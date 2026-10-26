//! 应用内更新：判断当前程序的更新方式，给更新检查提供可用的代理，以及免安装版的自替换更新。
//!
//! MSI 安装版交给 tauri-plugin-updater 运行安装包；免安装版由这里下载新 exe、校验签名，
//! 再把运行中的 exe（不论叫什么名字）改名为同目录的 `ClaudeDeck.exe.old`（Windows 允许给运行中的 exe 改名），
//! 新版本统一放成 `ClaudeDeck.exe`，启动后旧进程退出。新进程带 `--wait-pid=<旧进程 PID>`，
//! 先等旧进程退出再初始化（避开单实例检测），然后删除 `.old`、修正开机自启路径，不留旧版本文件。

use crate::*;
use base64::Engine;
use std::path::PathBuf;

/// MSI 安装时写入的注册表位置（见 WiX 模板：HKCU\Software\<制造商>\<产品名>\InstallDir）
const INSTALL_REG_KEY: &str = r"Software\chengzhiren66\ClaudeDeck";
const INSTALL_REG_VALUE: &str = "InstallDir";

/// 免安装版只接受本仓库 Release 的下载地址
const PORTABLE_URL_PREFIX: &str =
    "https://github.com/chengzhirenchaoshuai/ClaudeDeck/releases/download/";

/// 新进程等待旧进程退出的参数
const WAIT_PID_ARG: &str = "--wait-pid=";

/// 免安装版更新后的统一文件名；下载中的新版与替换下来的旧版也按它命名，便于启动时清理
const PORTABLE_EXE_NAME: &str = "ClaudeDeck.exe";

/// 本进程是否由免安装版更新拉起（finish_portable_update 中设置）
static LAUNCHED_BY_UPDATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateMode {
    /// MSI 安装版：运行安装包更新
    Msi,
    /// 免安装版：替换 exe 自身
    Portable,
    /// 开发版：不做应用内更新，避免替换 target 下的程序
    Dev,
}

#[derive(Serialize)]
pub(crate) struct UpdateEnv {
    mode: UpdateMode,
    /// 可用的 HTTP 代理地址，未配置或不可达时为 None
    proxy: Option<String>,
}

/// 读取 MSI 记录的安装目录
fn msi_install_dir() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    let key: Vec<u16> = INSTALL_REG_KEY.encode_utf16().chain([0]).collect();
    let name: Vec<u16> = INSTALL_REG_VALUE.encode_utf16().chain([0]).collect();
    let mut buf = vec![0u16; 1024];
    // 缓冲区大小以字节计，返回值包含结尾的 0
    let mut size = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    let dir = String::from_utf16_lossy(&buf[..len]);
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// 当前 exe 是否位于 MSI 安装目录下
fn is_msi_installed() -> bool {
    let (Some(install_dir), Ok(exe)) = (msi_install_dir(), std::env::current_exe()) else {
        return false;
    };
    match (install_dir.canonicalize(), exe.canonicalize()) {
        (Ok(dir), Ok(exe)) => exe
            .parent()
            .is_some_and(|p| p.as_os_str().eq_ignore_ascii_case(dir.as_os_str())),
        _ => false,
    }
}

fn update_mode() -> UpdateMode {
    if cfg!(debug_assertions) {
        UpdateMode::Dev
    } else if is_msi_installed() {
        UpdateMode::Msi
    } else {
        UpdateMode::Portable
    }
}

/// 更新插件的 HTTP 客户端只支持 http(s) 代理，且代理不可达时直接连接
async fn update_proxy() -> Option<String> {
    let url = resolve_proxy_url()?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    is_proxy_reachable(&url).await.then_some(url)
}

#[tauri::command]
pub(crate) async fn get_update_env() -> UpdateEnv {
    UpdateEnv {
        mode: update_mode(),
        proxy: update_proxy().await,
    }
}

/// 当前 exe 及其旁边的 `.new`（下载的新版）、`.old`（替换下来的旧版）路径
struct PortablePaths {
    /// 当前运行的 exe，文件名任意
    current: PathBuf,
    /// 更新后的程序：同目录下的 ClaudeDeck.exe
    target: PathBuf,
    /// 下载好、待替换的新版本
    new: PathBuf,
    /// 替换下来的旧版本，新版本启动后删除
    old: PathBuf,
}

impl PortablePaths {
    fn for_exe(current: PathBuf) -> Result<Self, String> {
        let dir = current.parent().ok_or("无法获取程序所在目录")?.to_path_buf();
        Ok(Self {
            target: dir.join(PORTABLE_EXE_NAME),
            new: dir.join(format!("{PORTABLE_EXE_NAME}.new")),
            old: dir.join(format!("{PORTABLE_EXE_NAME}.old")),
            current,
        })
    }

    /// 运行中的 exe 改名为 .old（原文件名随之消失），新版本放到 ClaudeDeck.exe；
    /// 当前不是 ClaudeDeck.exe 时，同目录已有的 ClaudeDeck.exe 是旧副本，直接被覆盖。失败时恢复原状
    fn swap_in_new(&self) -> Result<(), String> {
        if !self.new.exists() {
            return Err("没有已下载的新版本".into());
        }
        let _ = std::fs::remove_file(&self.old);
        std::fs::rename(&self.current, &self.old).map_err(|e| format!("无法替换程序文件：{e}"))?;
        if let Err(e) = std::fs::rename(&self.new, &self.target) {
            let _ = std::fs::rename(&self.old, &self.current);
            return Err(format!("无法替换程序文件：{e}"));
        }
        Ok(())
    }

    /// 撤销 swap_in_new，保留下载的新版本以便重试
    fn undo_swap(&self) {
        let _ = std::fs::rename(&self.target, &self.new);
        let _ = std::fs::rename(&self.old, &self.current);
    }

    /// 残留的 .old（旧版本）和 .new（下载了但没安装的新版本）；不含正在运行的文件
    fn stale_files(&self) -> Vec<PathBuf> {
        [&self.old, &self.new]
            .into_iter()
            .filter(|f| f.exists() && !f.as_os_str().eq_ignore_ascii_case(self.current.as_os_str()))
            .cloned()
            .collect()
    }
}

/// 删除文件，被短暂占用时重试；全部删掉返回 true
fn remove_with_retry(files: &[PathBuf], attempts: u32, interval: std::time::Duration) -> bool {
    for i in 0..attempts {
        if files.iter().all(|f| std::fs::remove_file(f).is_ok() || !f.exists()) {
            return true;
        }
        if i + 1 < attempts {
            std::thread::sleep(interval);
        }
    }
    false
}

fn portable_paths() -> Result<PortablePaths, String> {
    let current = std::env::current_exe().map_err(|e| format!("无法获取程序路径：{e}"))?;
    PortablePaths::for_exe(current)
}

fn ensure_portable() -> Result<(), String> {
    if update_mode() == UpdateMode::Portable {
        Ok(())
    } else {
        Err("当前不是免安装版，不能替换程序文件".into())
    }
}

/// 用 tauri.conf.json 中更新插件的公钥校验 minisign 签名（与 MSI 更新包同一把密钥）
fn verify_signature(app: &AppHandle, data: &[u8], signature: &str) -> Result<(), String> {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|v| v.as_str())
        .ok_or("缺少更新公钥")?;
    verify_with_pubkey(pubkey, data, signature)
}

/// 公钥和签名都是 base64 包裹的 minisign 文本，与 tauri.conf.json、.sig 文件中的格式一致
fn verify_with_pubkey(pubkey: &str, data: &[u8], signature: &str) -> Result<(), String> {
    let decode = |s: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    };
    let pubkey = decode(pubkey).ok_or("更新公钥格式错误")?;
    let pubkey = minisign_verify::PublicKey::decode(&pubkey).map_err(|e| format!("更新公钥无效：{e}"))?;
    let sig = decode(signature).ok_or("签名格式错误")?;
    let sig = minisign_verify::Signature::decode(&sig).map_err(|e| format!("签名格式错误：{e}"))?;
    pubkey
        .verify(data, &sig, true)
        .map_err(|e| format!("签名校验失败：{e}"))
}

#[derive(Clone, Serialize)]
pub(crate) struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// 下载免安装版新 exe，签名校验通过后保存为同目录的 `ClaudeDeck.exe.new`
#[tauri::command]
pub(crate) async fn download_portable_update(
    app: AppHandle,
    url: String,
    signature: String,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    ensure_portable()?;
    if !url.starts_with(PORTABLE_URL_PREFIX) {
        return Err("下载地址不在本项目的发布页下".into());
    }
    let paths = portable_paths()?;

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15),
        std::time::Duration::from_secs(600),
    )
    .await;
    let resp = client
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载失败：{e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut data = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        data.extend_from_slice(&chunk);
        let _ = on_progress.send(DownloadProgress { downloaded: data.len() as u64, total });
    }

    verify_signature(&app, &data, &signature)?;
    std::fs::write(&paths.new, &data).map_err(|e| format!("无法写入程序所在目录：{e}"))
}

/// 用已下载的新版本替换当前程序，启动新版本后退出。调用前前端应已结束所有会话
#[tauri::command]
pub(crate) async fn apply_portable_update(app: AppHandle) -> Result<(), String> {
    ensure_portable()?;
    let p = portable_paths()?;
    p.swap_in_new()?;

    let spawned = std::process::Command::new(&p.target)
        .arg(format!("{WAIT_PID_ARG}{}", std::process::id()))
        .spawn();
    if let Err(e) = spawned {
        // 新版本起不来就换回旧版本
        p.undo_swap();
        return Err(format!("无法启动新版本：{e}"));
    }
    app.exit(0);
    Ok(())
}

/// 程序启动最早期调用：由免安装版更新拉起时，先等旧进程退出；
/// 每次启动都在后台清理残留的 `.old`（旧版本）和 `.new`（下载了但没安装的新版本）
pub(crate) fn finish_portable_update() {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    let wait_pid = std::env::args()
        .find_map(|a| a.strip_prefix(WAIT_PID_ARG).and_then(|p| p.parse::<u32>().ok()));
    if let Some(pid) = wait_pid {
        LAUNCHED_BY_UPDATE.store(true, Ordering::Relaxed);
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                WaitForSingleObject(handle, 15_000);
                CloseHandle(handle);
            }
        }
    }

    if cfg!(debug_assertions) {
        return;
    }
    let Ok(p) = portable_paths() else { return };
    let stale = p.stale_files();
    if stale.is_empty() {
        return;
    }
    // 旧进程刚退出时文件可能还被系统或杀毒软件短暂占用，后台重试 10 秒，不拖慢启动；
    // 仍删不掉的留到下次启动再删
    std::thread::spawn(move || {
        remove_with_retry(&stale, 20, std::time::Duration::from_millis(500));
    });
}

/// 免安装版更新后程序路径可能变了（原来不叫 ClaudeDeck.exe），开着开机自启时按新路径重新登记
pub(crate) fn refresh_autostart_after_update(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    if !LAUNCHED_BY_UPDATE.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let autolaunch = app.autolaunch();
    if autolaunch.is_enabled().unwrap_or(false) {
        let _ = autolaunch.enable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用系统自带的 PING.EXE 模拟“正在运行、名字任意”的免安装版，走一遍替换与清理
    #[test]
    fn portable_swap_replaces_running_exe_and_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let ping = PathBuf::from(system_root).join(r"System32\PING.EXE");
        let current = dir.path().join("ClaudeDeck_1.4.2_x64_portable.exe");
        std::fs::copy(&ping, &current).unwrap();
        let p = PortablePaths::for_exe(current.clone()).unwrap();
        std::fs::write(&p.new, b"new version").unwrap();

        // 模拟正在运行的旧版本
        let mut running = std::process::Command::new(&current)
            .args(["-n", "3", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();

        p.swap_in_new().unwrap();
        assert!(!current.exists(), "原文件名应已消失");
        assert_eq!(std::fs::read(&p.target).unwrap(), b"new version");
        assert!(p.old.exists());
        assert!(!p.new.exists());

        // 旧进程退出后（对应新进程的 --wait-pid 等待），以 ClaudeDeck.exe 的身份清理残留
        running.wait().unwrap();
        let after = PortablePaths::for_exe(p.target.clone()).unwrap();
        let stale = after.stale_files();
        assert_eq!(stale, vec![after.old.clone()]);
        assert!(remove_with_retry(&stale, 20, std::time::Duration::from_millis(100)));

        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec![PORTABLE_EXE_NAME.to_string()]);
    }

    #[test]
    fn portable_swap_restores_when_nothing_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("whatever.exe");
        std::fs::write(&current, b"old").unwrap();
        let p = PortablePaths::for_exe(current.clone()).unwrap();
        assert!(p.swap_in_new().is_err());
        assert_eq!(std::fs::read(&current).unwrap(), b"old");
        assert!(!p.old.exists());
    }

    #[test]
    fn undo_swap_restores_original_name() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("我的 ClaudeDeck.exe");
        std::fs::write(&current, b"old").unwrap();
        let p = PortablePaths::for_exe(current.clone()).unwrap();
        std::fs::write(&p.new, b"new").unwrap();
        p.swap_in_new().unwrap();
        p.undo_swap();
        assert_eq!(std::fs::read(&current).unwrap(), b"old");
        assert_eq!(std::fs::read(&p.new).unwrap(), b"new");
        assert!(!p.target.exists() && !p.old.exists());
    }
}
