//! 从文件树把文件拖出窗口：发起系统级拖拽，放到桌面、资源管理器或其他程序。
//!
//! 本机文件直接拖。远程文件要先用 scp 下载到本机缓存，拖出窗口时立即开始下载：
//! - 下载完成时左键仍按着：进入系统拖拽，和本机文件一样；
//! - 下载完成前就松开了：系统拖拽已经没法开始（一开始发现左键松开会立即“放下”，
//!   文件会落到光标当时所在的位置），改为按松开位置判断目标文件夹——桌面，或资源管理器
//!   窗口当前所在的目录——下载完成后复制过去。前端显示拉取进度；识别不出位置时，
//!   下载完成后让用户选择保存位置。

use crate::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};

/// 拖拽缓存的保留时间：放下后资源管理器可能还在后台复制，不能马上删
const DRAG_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// 清理拖拽缓存里超过保留时间的子目录（每次拉取一个子目录），失败忽略
fn cleanup_drag_cache(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > DRAG_CACHE_TTL);
        if expired {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// 远程文件拉取任务
// ---------------------------------------------------------------------------

/// 一次远程文件拉取
struct Pull {
    /// 本机缓存文件（保留原文件名）
    local: PathBuf,
    /// 远端文件大小，0 表示还不知道
    total: AtomicU64,
    /// 下载结果，None 表示进行中
    result: StdMutex<Option<Result<(), String>>>,
    /// 松开位置对应的目标文件夹，None 表示还没松开或识别不出
    target: StdMutex<Option<PathBuf>>,
    /// 复制到目标文件夹的结果
    saved: StdMutex<Option<Result<PathBuf, String>>>,
    /// 取消下载
    cancel: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

fn pulls() -> &'static StdMutex<HashMap<u64, Arc<Pull>>> {
    static PULLS: OnceLock<StdMutex<HashMap<u64, Arc<Pull>>>> = OnceLock::new();
    PULLS.get_or_init(Default::default)
}

static NEXT_PULL_ID: AtomicU64 = AtomicU64::new(1);

fn get_pull(id: u64) -> Result<Arc<Pull>, String> {
    pulls().lock().unwrap().get(&id).cloned().ok_or_else(|| "拉取任务不存在".to_string())
}

/// 结束并移除拉取任务：还在下载就取消
fn close_pull_inner(id: u64) {
    if let Some(pull) = pulls().lock().unwrap().remove(&id) {
        if let Some(tx) = pull.cancel.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
}

/// 目标文件夹里已有同名文件时，改成「名称 (2).扩展名」这样的形式
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{} ({}){}", stem, n, ext)))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// 下载已完成且目标已知时复制过去。下载结束和松开鼠标两处都会调用，只复制一次
fn deliver(pull: &Pull) {
    let downloaded = matches!(*pull.result.lock().unwrap(), Some(Ok(())));
    if !downloaded {
        return;
    }
    let Some(dir) = pull.target.lock().unwrap().clone() else { return };
    let mut saved = pull.saved.lock().unwrap();
    if saved.is_some() {
        return;
    }
    let name = pull.local.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let dest = unique_dest(&dir, name);
    *saved = Some(
        std::fs::copy(&pull.local, &dest)
            .map(|_| dest)
            .map_err(|e| format!("复制到目标文件夹失败: {}", e)),
    );
}

/// 开始拉取：在拖拽缓存里建子目录，后台用 scp 下载，同时查询远端大小用于显示进度
fn start_pull(uri: &str) -> Result<(u64, Arc<Pull>), String> {
    let name = uri
        .rsplit(['/', '\\'])
        .next()
        .filter(|n| !n.is_empty() && *n != "." && *n != ".." && !n.contains(':'))
        .ok_or("无效的文件路径")?;
    let root = crate::app_paths::cache_path("drag")?;
    cleanup_drag_cache(&root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let dir = root.join(stamp.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    let local = dir.join(name);
    let mut cmd = commands::remote::scp_download_command(uri, &local)?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let pull = Arc::new(Pull {
        local,
        total: AtomicU64::new(0),
        result: StdMutex::new(None),
        target: StdMutex::new(None),
        saved: StdMutex::new(None),
        cancel: StdMutex::new(Some(cancel_tx)),
    });
    let id = NEXT_PULL_ID.fetch_add(1, Ordering::Relaxed);
    pulls().lock().unwrap().insert(id, pull.clone());

    // 远端大小只用于进度，查不到不影响下载
    let size_pull = pull.clone();
    let size_uri = uri.to_string();
    tokio::spawn(async move {
        if let Ok(size) = commands::remote::remote_file_size(&size_uri).await {
            size_pull.total.store(size, Ordering::Relaxed);
        }
    });

    let task_pull = pull.clone();
    tokio::spawn(async move {
        let result = match cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true) // 取消时随 future 一起被丢弃，scp 进程随之结束
            .spawn()
        {
            Err(e) => Err(format!("无法启动 scp（请确认系统已安装 OpenSSH 客户端）: {}", e)),
            Ok(child) => tokio::select! {
                out = child.wait_with_output() => match out {
                    Ok(o) if o.status.success() => Ok(()),
                    Ok(o) => {
                        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        Err(if err.is_empty() {
                            format!("下载远端文件失败（scp 退出码 {}）", o.status.code().unwrap_or(-1))
                        } else {
                            format!("下载远端文件失败: {}", err)
                        })
                    }
                    Err(e) => Err(format!("下载远端文件失败: {}", e)),
                },
                _ = cancel_rx => Err("已取消".to_string()),
            },
        };
        *task_pull.result.lock().unwrap() = Some(result);
        deliver(&task_pull);
    });
    Ok((id, pull))
}

// ---------------------------------------------------------------------------
// 鼠标与放置位置
// ---------------------------------------------------------------------------

/// 鼠标主键当前是否按着（考虑了左右键互换设置）
fn left_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    // GetAsyncKeyState 读的是物理按键，左右键互换时主键是物理右键
    let key = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    (unsafe { GetAsyncKeyState(key as i32) } as u16 & 0x8000) != 0
}

/// 光标下的顶层窗口句柄与窗口类名
fn root_window_at_cursor() -> (isize, String) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetCursorPos, WindowFromPoint, GA_ROOT,
    };
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return (0, String::new());
        }
        let hwnd = WindowFromPoint(pt);
        if hwnd.is_null() {
            return (0, String::new());
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let mut buf = [0u16; 256];
        let len = GetClassNameW(root, buf.as_mut_ptr(), buf.len() as i32);
        (root as isize, String::from_utf16_lossy(&buf[..len.max(0) as usize]))
    }
}

/// 资源管理器窗口当前所在的文件夹：经 Shell.Application 按窗口句柄查找。
/// 结果用 base64 输出，避免无控制台时 PowerShell 输出编码不对导致中文乱码。
/// “此电脑”等虚拟位置没有文件系统路径，返回 None
async fn explorer_folder(hwnd: isize) -> Option<PathBuf> {
    let script = format!(
        "foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {{ \
           try {{ if ($w.HWND -eq {hwnd}) {{ \
             [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($w.Document.Folder.Self.Path)); break \
           }} }} catch {{}} }}"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
        .await
        .ok()?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let text = String::from_utf8_lossy(&output.stdout);
    let bytes = STANDARD.decode(text.trim()).ok()?;
    let path = PathBuf::from(String::from_utf8(bytes).ok()?);
    path.is_dir().then_some(path)
}

/// 松开鼠标的位置
enum DropSpot {
    /// 回到了本应用窗口：视为取消
    OwnWindow,
    /// 桌面或资源管理器窗口里的文件夹
    Folder(PathBuf),
    /// 识别不出（其他程序、虚拟位置等）
    Unknown,
}

async fn drop_spot(own_hwnd: isize) -> DropSpot {
    let (root, class) = root_window_at_cursor();
    if root != 0 && root == own_hwnd {
        return DropSpot::OwnWindow;
    }
    let folder = match class.as_str() {
        // 桌面图标所在的窗口
        "Progman" | "WorkerW" => dirs::desktop_dir().filter(|d| d.is_dir()),
        "CabinetWClass" => explorer_folder(root).await,
        _ => None,
    };
    folder.map(DropSpot::Folder).unwrap_or(DropSpot::Unknown)
}

// ---------------------------------------------------------------------------
// 系统拖拽与命令
// ---------------------------------------------------------------------------

/// 在 UI 线程上发起系统拖拽（DoDragDrop 会阻塞直到放下或取消），返回是否已放下
async fn system_drag(window: &tauri::Window, file: PathBuf) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let tx = StdMutex::new(Some(tx));
            let icon = drag::Image::Raw(include_bytes!("../../../assets/icons/32x32.png").to_vec());
            let started = drag::start_drag(
                &win,
                drag::DragItem::Files(vec![file]),
                icon,
                move |result, _pos| {
                    if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                        let _ = tx.send(matches!(result, drag::DragResult::Dropped));
                    }
                },
                drag::Options::default(), // 复制模式：本机文件拖出去是复制，不会移走原文件
            );
            if let Err(e) = started {
                eprintln!("[drag] start_drag failed: {e}");
            }
        })
        .map_err(|e| format!("无法开始拖拽: {}", e))?;
    // start_drag 失败时回调不会被调用，发送端随闭包释放，这里收到 RecvError
    rx.await.map_err(|_| "无法开始拖拽".to_string())
}

/// 拖出窗口的结果
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DragOutcome {
    Dropped,
    Cancelled,
    /// 远程文件下载完成前松开了鼠标：继续在后台拉取，前端显示进度
    #[serde(rename_all = "camelCase")]
    Pulling {
        id: u64,
        name: String,
        /// 识别出的目标文件夹；None 表示下载完成后由用户选择保存位置
        target: Option<String>,
    },
}

/// 从文件树把文件拖出窗口。前端在内部拖拽移出窗口边界时调用，此时左键仍按着。
#[tauri::command]
pub(crate) async fn start_file_drag(window: tauri::Window, path: String) -> Result<DragOutcome, String> {
    if !path.starts_with(commands::remote::REMOTE_SCHEME) {
        reject_unsafe_path(&path)?;
        let file = PathBuf::from(path.replace('/', "\\"));
        if !file.exists() {
            return Err(format!("文件不存在：{}", file.display()));
        }
        let dropped = system_drag(&window, file).await?;
        return Ok(if dropped { DragOutcome::Dropped } else { DragOutcome::Cancelled });
    }

    let (id, pull) = start_pull(&path)?;
    let own_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    loop {
        let result = pull.result.lock().unwrap().clone();
        if let Some(Err(e)) = result {
            close_pull_inner(id);
            return Err(e);
        }
        let down = left_button_down();
        if result.is_some() && down {
            // 下载完成时还按着：正常进入系统拖拽
            pulls().lock().unwrap().remove(&id);
            let dropped = system_drag(&window, pull.local.clone()).await?;
            return Ok(if dropped { DragOutcome::Dropped } else { DragOutcome::Cancelled });
        }
        if !down {
            let name = pull.local.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
            return Ok(match drop_spot(own_hwnd).await {
                DropSpot::OwnWindow => {
                    close_pull_inner(id);
                    DragOutcome::Cancelled
                }
                DropSpot::Folder(dir) => {
                    let target = dir.display().to_string();
                    *pull.target.lock().unwrap() = Some(dir);
                    deliver(&pull);
                    DragOutcome::Pulling { id, name, target: Some(target) }
                }
                DropSpot::Unknown => DragOutcome::Pulling { id, name, target: None },
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

/// 拉取进度
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullStatus {
    /// 已下载字节数（本地缓存文件当前大小）
    received: u64,
    /// 远端文件大小，0 表示还不知道
    total: u64,
    /// 下载已完成
    downloaded: bool,
    /// 已复制到目标文件夹后的完整路径
    saved_to: Option<String>,
    /// 下载或复制失败的原因
    error: Option<String>,
}

#[tauri::command]
pub(crate) async fn pull_status(id: u64) -> Result<PullStatus, String> {
    let pull = get_pull(id)?;
    let received = std::fs::metadata(&pull.local).map(|m| m.len()).unwrap_or(0);
    let result = pull.result.lock().unwrap().clone();
    let saved = pull.saved.lock().unwrap().clone();
    let error = match (&result, &saved) {
        (Some(Err(e)), _) | (_, Some(Err(e))) => Some(e.clone()),
        _ => None,
    };
    Ok(PullStatus {
        received,
        total: pull.total.load(Ordering::Relaxed),
        downloaded: matches!(result, Some(Ok(()))),
        saved_to: saved.and_then(|r| r.ok()).map(|p| p.display().to_string()),
        error,
    })
}

/// 目标位置识别不出时：下载完成后由用户在保存对话框里选位置，复制过去
#[tauri::command]
pub(crate) async fn save_pull(id: u64, dest: String) -> Result<(), String> {
    reject_unsafe_path(&dest)?;
    let pull = get_pull(id)?;
    std::fs::copy(&pull.local, &dest).map_err(|e| format!("保存失败: {}", e))?;
    close_pull_inner(id);
    Ok(())
}

/// 关闭拉取任务：还在下载就取消（缓存文件留给定期清理）
#[tauri::command]
pub(crate) async fn close_pull(id: u64) -> Result<(), String> {
    close_pull_inner(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_dest_adds_number() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unique_dest(dir.path(), "a.txt"), dir.path().join("a.txt"));
        std::fs::write(dir.path().join("a.txt"), "1").unwrap();
        assert_eq!(unique_dest(dir.path(), "a.txt"), dir.path().join("a (2).txt"));
        std::fs::write(dir.path().join("a (2).txt"), "2").unwrap();
        assert_eq!(unique_dest(dir.path(), "a.txt"), dir.path().join("a (3).txt"));
        std::fs::write(dir.path().join("README"), "x").unwrap();
        assert_eq!(unique_dest(dir.path(), "README"), dir.path().join("README (2)"));
    }
}
