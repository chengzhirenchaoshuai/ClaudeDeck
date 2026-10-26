//! 应用内更新：判断当前程序的更新方式，给更新检查提供可用的代理，以及免安装版的自替换更新。
//!
//! MSI 安装版交给 tauri-plugin-updater 运行安装包；免安装版由这里下载新 exe、校验签名，
//! 再把运行中的 exe 改名为 `.old`（Windows 允许给运行中的 exe 改名）、新文件放到原位置，
//! 启动新进程后退出。新进程带 `--wait-pid=<旧进程 PID>`，先等旧进程退出再初始化（避开单实例检测），
//! 并删除 `.old`。

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
fn portable_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取程序路径：{e}"))?;
    Ok((exe.clone(), exe.with_extension("exe.new"), exe.with_extension("exe.old")))
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

/// 下载免安装版新 exe，签名校验通过后保存为 `<exe>.new`
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
    let (_, new_path, _) = portable_paths()?;

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
    std::fs::write(&new_path, &data).map_err(|e| format!("无法写入程序所在目录：{e}"))
}

/// 用已下载的 `<exe>.new` 替换当前程序，启动新版本后退出。调用前前端应已结束所有会话
#[tauri::command]
pub(crate) async fn apply_portable_update(app: AppHandle) -> Result<(), String> {
    ensure_portable()?;
    let (exe, new_path, old_path) = portable_paths()?;
    if !new_path.exists() {
        return Err("没有已下载的新版本".into());
    }

    let _ = std::fs::remove_file(&old_path);
    std::fs::rename(&exe, &old_path).map_err(|e| format!("无法替换程序文件：{e}"))?;
    if let Err(e) = std::fs::rename(&new_path, &exe) {
        let _ = std::fs::rename(&old_path, &exe);
        return Err(format!("无法替换程序文件：{e}"));
    }

    let spawned = std::process::Command::new(&exe)
        .arg(format!("{WAIT_PID_ARG}{}", std::process::id()))
        .spawn();
    if let Err(e) = spawned {
        // 新版本起不来就换回旧版本，保留下载的文件以便重试
        let _ = std::fs::rename(&exe, &new_path);
        let _ = std::fs::rename(&old_path, &exe);
        return Err(format!("无法启动新版本：{e}"));
    }
    app.exit(0);
    Ok(())
}

/// 程序启动最早期调用：由免安装版更新拉起时，先等旧进程退出，再清理替换下来的 `.old`
pub(crate) fn finish_portable_update() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    let wait_pid = std::env::args()
        .find_map(|a| a.strip_prefix(WAIT_PID_ARG).and_then(|p| p.parse::<u32>().ok()));
    if let Some(pid) = wait_pid {
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                WaitForSingleObject(handle, 15_000);
                CloseHandle(handle);
            }
        }
    }
    if let Ok((_, _, old_path)) = portable_paths() {
        if old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
    }
}
