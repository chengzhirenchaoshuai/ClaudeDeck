//! 系统通知（Windows 操作中心的 toast）：回复完成、需要用户确认时由前端调用。
//!
//! 未打包的 Windows 程序发 toast 必须带一个已登记的 AppUserModelID，否则通知会被系统静默丢弃：
//! - MSI 安装版：Tauri 的安装模板在开始菜单快捷方式上写了 System.AppUserModel.ID = 应用标识，无需处理；
//! - 免安装版：没有快捷方式，这里在 HKCU\Software\Classes\AppUserModelId\<应用标识> 下登记显示名称和图标；
//! - 开发版（从 target\debug 运行）：插件不设置应用 ID，通知显示为 PowerShell 的名称和图标。

use crate::*;
use std::sync::OnceLock;
use tauri_plugin_notification::NotificationExt;

/// 每个进程只登记一次
static AUMID_READY: OnceLock<()> = OnceLock::new();

/// 写入 HKCU 下的一个字符串值（键不存在时自动创建）
fn set_reg_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    let key: Vec<u16> = subkey.encode_utf16().chain([0]).collect();
    let name_w: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let data: Vec<u16> = value.encode_utf16().chain([0]).collect();
    let rc = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name_w.as_ptr(),
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("写入注册表失败（{}）：{}", rc, subkey))
    }
}

/// 免安装版：登记 AppUserModelID 的显示名称和图标，通知才会显示（并显示为本应用）
fn ensure_portable_aumid(identifier: &str, display_name: &str) {
    if cfg!(debug_assertions) || commands::updater::is_msi_installed() {
        return;
    }
    AUMID_READY.get_or_init(|| {
        let subkey = format!(r"Software\Classes\AppUserModelId\{}", identifier);
        if let Err(e) = set_reg_string(&subkey, "DisplayName", display_name) {
            eprintln!("[notification] {}", e);
            return;
        }
        // 图标要求是磁盘上的图片文件：把内置图标写到缓存目录
        let icon = app_paths::cache_path("notification-icon.png").and_then(|path| {
            std::fs::write(&path, include_bytes!("../../../assets/icons/128x128.png"))
                .map_err(|e| e.to_string())?;
            Ok(path)
        });
        match icon {
            Ok(path) => {
                if let Err(e) = set_reg_string(&subkey, "IconUri", &path.to_string_lossy()) {
                    eprintln!("[notification] {}", e);
                }
            }
            Err(e) => eprintln!("[notification] 写入通知图标失败：{}", e),
        }
    });
}

/// 发送一条系统通知
#[tauri::command]
pub(crate) async fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    let display_name = app.config().product_name.clone().unwrap_or_else(|| "ClaudeDeck".to_string());
    ensure_portable_aumid(&identifier, &display_name);
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
