//! 应用内更新：判断当前程序是否为 MSI 安装版，并给更新检查提供可用的代理。

use crate::*;

/// MSI 安装时写入的注册表位置（见 WiX 模板：HKCU\Software\<制造商>\<产品名>\InstallDir）
const INSTALL_REG_KEY: &str = r"Software\chengzhiren66\ClaudeDeck";
const INSTALL_REG_VALUE: &str = "InstallDir";

#[derive(Serialize)]
pub(crate) struct UpdateEnv {
    /// 当前运行的是 MSI 安装目录里的程序；免安装版和开发版为 false，只能手动下载更新
    installed: bool,
    /// 可用的 HTTP 代理地址，未配置或不可达时为 None
    proxy: Option<String>,
}

/// 读取 MSI 记录的安装目录
fn msi_install_dir() -> Option<std::path::PathBuf> {
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
    (!dir.is_empty()).then(|| std::path::PathBuf::from(dir))
}

/// 当前 exe 是否位于 MSI 安装目录下
fn is_msi_installed() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
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
        installed: is_msi_installed(),
        proxy: update_proxy().await,
    }
}
