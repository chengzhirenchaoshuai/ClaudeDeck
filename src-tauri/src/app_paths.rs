//! 应用数据目录：所有 ClaudeDeck 自己的数据统一放在 %APPDATA%\ClaudeDeck\ 下。
//!
//! ```text
//! %APPDATA%\ClaudeDeck\
//! ├── config\     配置（服务商、密钥、远程主机、置顶/归档、隐藏会话、Skills 翻译设置）
//! ├── cache\      缓存，随时可删（statusLine 用量、远程会话缓存、翻译缓存）
//! ├── tools\      应用内自动安装的 CLI / Git / Node
//! └── webview\    WebView2 数据（含 localStorage 里的界面设置）
//! ```
//!
//! 不在这里的：会话自定义名称放在 CLI 配置目录（远程客户端要从同一文件读取），
//! 消息附件放在项目内的 .tokenicode\tmp\（CLI 只能读取项目内文件）。

use std::path::{Path, PathBuf};

const ROOT_DIR_NAME: &str = "ClaudeDeck";

/// 根目录：%APPDATA%\ClaudeDeck
pub fn root_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join(ROOT_DIR_NAME))
        .ok_or_else(|| "无法确定应用数据目录".to_string())
}

fn ensure_sub_dir(name: &str) -> Result<PathBuf, String> {
    let dir = root_dir()?.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录 {} 失败: {}", dir.display(), e))?;
    Ok(dir)
}

pub fn config_dir() -> Result<PathBuf, String> {
    ensure_sub_dir("config")
}

pub fn cache_dir() -> Result<PathBuf, String> {
    ensure_sub_dir("cache")
}

pub fn tools_dir() -> Result<PathBuf, String> {
    ensure_sub_dir("tools")
}

/// 配置目录下的文件路径
pub fn config_path(name: &str) -> Result<PathBuf, String> {
    Ok(config_dir()?.join(name))
}

/// 缓存目录下的文件路径
pub fn cache_path(name: &str) -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(name))
}

/// WebView2 数据目录。同一目录不能被两个运行中的实例同时使用，
/// 所以 alpha 版、开发版（debug 构建）各用一个独立目录。
pub fn webview_dir(identifier: &str) -> Result<PathBuf, String> {
    let mut name = String::from("webview");
    if identifier.ends_with(".alpha") {
        name.push_str("-alpha");
    }
    if cfg!(debug_assertions) {
        name.push_str("-dev");
    }
    ensure_sub_dir(&name)
}

/// 从旧位置迁移数据（复制，旧目录保留作备份）。各部分独立判断，目标已存在就跳过：
/// - ~/.tokenicode/ → config\ 与 cache\
/// - %LOCALAPPDATA%\<identifier>\EBWebView → webview*\EBWebView
///
/// 必须在创建任何窗口之前调用，否则 WebView2 会先在新目录里建好空数据。
pub fn migrate_legacy(identifier: &str) {
    let Ok(root) = root_dir() else { return };

    if let Some(old) = dirs::home_dir().map(|h| h.join(".tokenicode")) {
        if old.is_dir() && !root.join("config").exists() {
            if let (Ok(config), Ok(cache)) = (config_dir(), cache_dir()) {
                if let Ok(entries) = std::fs::read_dir(&old) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        let is_cache = name_str == "statusline"
                            || name_str == "remote_cache"
                            || name_str.starts_with("translation-cache");
                        let target = if is_cache { &cache } else { &config }.join(&name);
                        copy_recursive(&entry.path(), &target);
                    }
                }
                eprintln!("[app_paths] 已从 {} 迁移配置", old.display());
            }
        }
    }

    let Ok(webview) = webview_dir(identifier) else { return };
    let new_ebw = webview.join("EBWebView");
    if !new_ebw.exists() {
        if let Some(old_ebw) = dirs::data_local_dir().map(|d| d.join(identifier).join("EBWebView")) {
            if old_ebw.is_dir() {
                copy_recursive(&old_ebw, &new_ebw);
                eprintln!("[app_paths] 已从 {} 迁移 WebView 数据", old_ebw.display());
            }
        }
    }
}

/// 递归复制，单个文件失败（例如被正在运行的旧版本占用）时跳过，不中断整体迁移。
fn copy_recursive(src: &Path, dst: &Path) {
    if src.is_dir() {
        if std::fs::create_dir_all(dst).is_err() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(src) {
            for entry in entries.flatten() {
                copy_recursive(&entry.path(), &dst.join(entry.file_name()));
            }
        }
    } else if let Err(e) = std::fs::copy(src, dst) {
        eprintln!("[app_paths] 跳过 {}: {}", src.display(), e);
    }
}
