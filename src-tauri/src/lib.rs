mod app_paths;
mod commands;
mod protocol;

use commands::providers::*;
use commands::cli_setup::*;
use commands::toolchain::*;
use commands::sessions::*;
pub use commands::sessions::statusline_write_hook;
use commands::files::*;
use commands::network::*;
use commands::{ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager};
// protocol module kept for ControlRequest (send_control_request) and tests
use futures_util::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as TokioMutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
fn claude_needs_cmd_wrapper(bin: &str) -> bool {
    bin.ends_with(".cmd")
        || bin.ends_with(".bat")
        || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

/// Strip ANSI escape sequences from a string (terminal color/cursor codes).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')') => {
                    chars.next();
                    chars.next();
                }
                _ => {
                    chars.next();
                }
            }
        } else if c < '\x20' && c != '\n' && c != '\r' && c != '\t' {
            // skip control chars
        } else {
            out.push(c);
        }
    }
    out
}

/// GCS bucket for Claude Code releases.
const CLI_GCS_BASE: &str = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

/// Self-hosted mirror for China users.
const CLI_MIRROR_BASE: &str = "https://herear.cn:8443/releases/claude-code";

/// 应用内下载的 CLI 目录：<数据目录>/tools/cli
pub(crate) fn cli_download_dir() -> Option<std::path::PathBuf> {
    app_paths::tools_dir().ok().map(|d| d.join("cli"))
}

/// Path to the local Git installation directory (Windows only).
#[cfg(target_os = "windows")]
fn git_download_dir() -> Result<std::path::PathBuf, String> {
    app_paths::tools_dir().map(|d| d.join("git"))
}

/// Check if app-local PortableGit bash.exe exists (Windows only).
#[cfg(target_os = "windows")]
fn get_local_git_bash() -> Option<String> {
    let git_dir = git_download_dir().ok()?;
    let bash = git_dir.join("bin").join("bash.exe");
    if bash.exists() {
        Some(bash.to_string_lossy().to_string())
    } else {
        None
    }
}

// is_valid_executable moved to commands/cli_resolver.rs

/// On Windows, find git-bash (bash.exe) to satisfy Claude Code's requirement.
/// Returns the path to bash.exe if found.
#[cfg(target_os = "windows")]
pub(crate) fn find_git_bash() -> Option<String> {
    // 1. Check app-local PortableGit first (auto-installed by ClaudeDeck)
    if let Some(local) = get_local_git_bash() {
        return Some(local);
    }
    // 2. Check standard installation paths (all common drive letters)
    let mut candidates = vec![
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
    ];
    // Also check non-C drives (D:, E:, F:, etc.) where Git may be installed
    for drive in b'D'..=b'F' {
        candidates.push(format!(r"{}:\Program Files\Git\bin\bash.exe", drive as char));
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // Check user-level scoop/chocolatey installs
    if let Some(home) = dirs::home_dir() {
        let scoop = home.join(r"scoop\apps\git\current\bin\bash.exe");
        if scoop.exists() {
            return Some(scoop.to_string_lossy().to_string());
        }
    }
    // Try `where bash` as last resort
    if let Ok(output) = std::process::Command::new("cmd")
        .args(["/C", "where", "bash"])
        .creation_flags(0x08000000)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(path) = stdout.lines().next() {
                let path = path.trim().to_string();
                if !path.is_empty() && commands::cli_resolver::is_valid_executable(std::path::Path::new(&path)) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn find_claude_binary() -> Option<String> {
    commands::cli_resolver::find_binary()
}

/// Return all valid CLI binaries in priority order, for fallback iteration.
fn find_claude_binary_ordered() -> Vec<String> {
    commands::cli_resolver::resolve_ordered()
        .into_iter()
        .map(|(path, _)| path)
        .collect()
}

/// On macOS/Linux, GUI apps inherit a minimal launchd PATH and miss version
/// managers (nvm, volta, fnm) that are set up in login-shell config files.
/// This function spawns a login shell once, captures its PATH, and caches it
/// for the lifetime of the process via OnceLock.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_extra_path() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let output = std::process::Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !p.is_empty() {
                    eprintln!(
                        "login shell PATH captured ({} entries)",
                        p.split(':').count()
                    );
                }
                p
            }
            _ => {
                eprintln!("login shell PATH capture failed");
                String::new()
            }
        }
    })
}

/// Truncate excessively large string values inside a JSON structure.
/// Used to prevent Tauri IPC / WebView freezes when Claude CLI returns
/// huge tool results (e.g. 24MB PDF text content).
fn truncate_large_content(value: &mut Value, max_bytes: usize) {
    match value {
        Value::String(s) => {
            if s.len() > max_bytes {
                // Truncate at a safe UTF-8 boundary
                let mut end = max_bytes;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push_str("\n\n... [content truncated for display, full content available to Claude]");
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                truncate_large_content(item, max_bytes);
            }
        }
        Value::Object(map) => {
            for (_k, v) in map.iter_mut() {
                truncate_large_content(v, max_bytes);
            }
        }
        _ => {}
    }
}

/// Build an enriched PATH that includes common binary locations
pub(crate) fn build_enriched_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut paths = vec![];

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    // Highest priority: local npm-global/bin (where CLI is installed via local npm)
    if let Some(npm_bin) = get_npm_global_bin() {
        paths.push(npm_bin.to_string_lossy().to_string());
    }

    // Local Node.js bin (for running npm-installed CLI)
    if let Some(node_bin) = get_local_node_bin() {
        paths.push(node_bin.to_string_lossy().to_string());
    }

    // App-local CLI download directory
    if let Some(cli_dir) = cli_download_dir() {
        paths.push(cli_dir.to_string_lossy().to_string());
    }

    // App-local Git (PortableGit) bin directory (Windows only)
    #[cfg(target_os = "windows")]
    {
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                paths.push(git_bin.to_string_lossy().to_string());
            }
            // Also add cmd/ for git.exe
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                paths.push(git_cmd.to_string_lossy().to_string());
            }
            // Also add usr/bin/ for cygpath.exe (required by Claude CLI for path conversion)
            let git_usr_bin = git_dir.join("usr").join("bin");
            if git_usr_bin.exists() {
                paths.push(git_usr_bin.to_string_lossy().to_string());
            }
        }

        // Also check system-installed Git (not just app-local PortableGit)
        // to find usr/bin/cygpath.exe which Claude CLI needs for path conversion.
        if let Some(git_bash_path) = find_git_bash() {
            // git_bash_path is like "D:\Program Files\Git\bin\bash.exe"
            // We need the parent's parent to get the Git root, then add usr/bin
            let bash_path = std::path::Path::new(&git_bash_path);
            if let Some(git_root) = bash_path.parent().and_then(|p| p.parent()) {
                let usr_bin = git_root.join("usr").join("bin");
                if usr_bin.exists() {
                    let usr_bin_str = usr_bin.to_string_lossy().to_string();
                    if !paths.contains(&usr_bin_str) {
                        paths.push(usr_bin_str);
                    }
                }
                // Also ensure Git bin/ and cmd/ are in PATH
                for sub in &["bin", "cmd"] {
                    let dir = git_root.join(sub);
                    if dir.exists() {
                        let dir_str = dir.to_string_lossy().to_string();
                        if !paths.contains(&dir_str) {
                            paths.push(dir_str);
                        }
                    }
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        {
            if let Some(app_data) = dirs::data_dir() {
                paths.push(app_data.join("npm").to_string_lossy().to_string());
            }
            if let Some(local_app) = dirs::data_local_dir() {
                paths.push(
                    local_app
                        .join("Programs")
                        .join("claude-code")
                        .to_string_lossy()
                        .to_string(),
                );
            }
            paths.push(
                home.join("scoop")
                    .join("shims")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".cargo")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".volta")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm-windows: version dirs inside %NVM_HOME% (or %APPDATA%\nvm)
            let nvm_home = std::env::var("NVM_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|_| dirs::config_dir().map(|d| d.join("nvm")).ok_or(()))
                .ok();
            if let Some(ref nvm_dir) = nvm_home {
                if nvm_dir.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(nvm_dir) {
                        let mut version_dirs: Vec<std::path::PathBuf> = entries
                            .flatten()
                            .filter(|e| {
                                e.path().is_dir()
                                    && e.file_name().to_string_lossy().starts_with('v')
                            })
                            .map(|e| e.path())
                            .collect();
                        version_dirs.sort();
                        if let Some(latest) = version_dirs.last() {
                            paths.push(latest.to_string_lossy().to_string());
                        }
                    }
                }
            }
            // nvm-windows symlink (typically C:\Program Files\nodejs)
            if let Ok(symlink) = std::env::var("NVM_SYMLINK") {
                paths.push(symlink);
            }

            // fnm on Windows
            paths.push(
                home.join(".fnm")
                    .join("aliases")
                    .join("default")
                    .to_string_lossy()
                    .to_string(),
            );

            // Standard Node.js install path
            if let Ok(pf) = std::env::var("ProgramFiles") {
                let node_path = format!("{}\\nodejs", pf);
                paths.push(node_path);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            paths.push(home.join(".cargo/bin").to_string_lossy().to_string());
            paths.push(home.join(".local/bin").to_string_lossy().to_string());
            paths.push(home.join(".npm-global/bin").to_string_lossy().to_string());

            // volta (version manager) — shims live here
            paths.push(home.join(".volta/bin").to_string_lossy().to_string());

            // fnm (version manager) — default alias symlink
            paths.push(
                home.join(".fnm/aliases/default/bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm: find the latest installed Node.js version
            let nvm_dir = std::env::var("NVM_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| home.join(".nvm"));
            let nvm_versions = nvm_dir.join("versions/node");
            if nvm_versions.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    let mut version_dirs: Vec<std::path::PathBuf> = entries
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .map(|e| e.path())
                        .collect();
                    version_dirs.sort_by(|a, b| {
                        let parse_ver = |p: &std::path::Path| -> (u32, u32, u32) {
                            let name = p.file_name().unwrap_or_default().to_string_lossy();
                            let s = name.strip_prefix('v').unwrap_or(&name);
                            let parts: Vec<u32> =
                                s.split('.').filter_map(|x| x.parse().ok()).collect();
                            (
                                parts.first().copied().unwrap_or(0),
                                parts.get(1).copied().unwrap_or(0),
                                parts.get(2).copied().unwrap_or(0),
                            )
                        };
                        parse_ver(a).cmp(&parse_ver(b))
                    });
                    if let Some(latest) = version_dirs.last() {
                        paths.push(latest.join("bin").to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        paths.push("/opt/homebrew/bin".to_string());
        paths.push("/usr/local/bin".to_string());
    }

    // Merge login shell PATH (macOS/Linux) to catch version managers we missed
    #[cfg(not(target_os = "windows"))]
    {
        let shell_path = login_shell_extra_path();
        if !shell_path.is_empty() {
            let existing: std::collections::HashSet<String> = paths.iter().cloned().collect();
            let extra: Vec<String> = shell_path
                .split(':')
                .filter(|p| !p.is_empty() && !existing.contains(*p))
                .map(|p| p.to_string())
                .collect();
            paths.extend(extra);
        }
    }

    let mut result = paths.join(separator);
    if !current.is_empty() {
        result.push_str(separator);
        result.push_str(&current);
    }
    result
}

// --- Credential storage (TK-303) ---

/// Claude CLI 的配置根目录：优先取环境变量 CLAUDE_CONFIG_DIR，否则为 ~/.claude。
/// 会话（projects/）、skills、commands、credentials 等都以此为准，与 CLI 保持一致。
fn claude_config_dir() -> Result<std::path::PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Ok(std::path::PathBuf::from(dir));
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "Cannot find home dir".to_string())
}

/// CLI 会话目录：<配置根目录>/projects
fn claude_projects_dir() -> Result<std::path::PathBuf, String> {
    claude_config_dir().map(|d| d.join("projects"))
}

/// CLI 全局状态文件 .claude.json：设置了 CLAUDE_CONFIG_DIR 时位于该目录内，否则为 ~/.claude.json。
fn claude_json_path() -> Result<std::path::PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Ok(std::path::PathBuf::from(dir).join(".claude.json"));
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".claude.json"))
        .ok_or_else(|| "Cannot find home dir".to_string())
}

/// 显示并聚焦主窗口（托盘点击、托盘菜单、再次启动应用时使用）
fn show_main_window(app: &AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 创建系统托盘图标：左键显示主窗口，右键菜单提供“显示 / 退出”。
/// 退出交给前端处理（前端知道有哪些任务在运行，需要先确认并有序收尾）。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray-show", "显示 ClaudeDeck", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/icons/tray.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("ClaudeDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => {
                show_main_window(app);
                let _ = app.emit("tray:quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 返回 Claude CLI 的配置目录与 .claude.json 路径（遵循 CLAUDE_CONFIG_DIR），
/// 供前端读写 MCP、skills 等配置，避免写死 ~/.claude。
#[tauri::command]
async fn get_claude_config_paths() -> Result<Value, String> {
    Ok(serde_json::json!({
        "configDir": claude_config_dir()?.to_string_lossy(),
        "claudeJson": claude_json_path()?.to_string_lossy(),
    }))
}

/// Set the macOS dock icon dynamically from base64-encoded PNG data.
#[tauri::command]
async fn set_dock_icon(app: AppHandle, png_base64: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&png_base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;

        // NSApplication APIs must be called on the main thread
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| unsafe {
                use objc::msg_send;
                use objc::runtime::{Class, Object};
                use objc::sel;
                use objc::sel_impl;

                let nsdata_class = Class::get("NSData").unwrap();
                let nsdata: *mut Object = msg_send![nsdata_class, alloc];
                let nsdata: *mut Object = msg_send![nsdata,
                    initWithBytes: data.as_ptr()
                    length: data.len()
                ];

                let nsimage_class = Class::get("NSImage").unwrap();
                let nsimage: *mut Object = msg_send![nsimage_class, alloc];
                let nsimage: *mut Object = msg_send![nsimage, initWithData: nsdata];

                if !nsimage.is_null() {
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let _: () = msg_send![nsapp, setApplicationIconImage: nsimage];
                }
            });
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (&app, &png_base64);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 关闭窗口会隐藏到托盘，此时再次启动应用应唤起已有窗口，而不是再开一个实例
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // 开机自启动（Windows 写入当前用户的注册表启动项）；macOS 的启动方式在此指定
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessManager::new())
        .manage(StdinManager::new())
        .manage(WatcherManager::default())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 先把旧位置的数据迁移到 %APPDATA%\ClaudeDeck，再创建主窗口：
            // 主窗口在 tauri.conf.json 里设为 create: false，由这里指定固定的 WebView 数据目录创建
            let identifier = app.config().identifier.clone();
            app_paths::migrate_legacy(&identifier);
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json 中缺少主窗口配置")?;
            let mut main_window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .data_directory(app_paths::webview_dir(&identifier)?);
            // 开发版标题加后缀，和同时运行的正式版区分开
            if cfg!(debug_assertions) {
                main_window = main_window.title(format!("{} Dev", window_config.title));
            }
            main_window.build()?;

            // titleBarStyle: "Overlay" in tauri.conf.json handles macOS traffic lights
            // and native titlebar drag/double-click-to-maximize automatically.

            // 监听 CLI 会话目录，让会话列表随 CLI 变化自动同步
            start_sessions_watcher(app.handle().clone());

            // 系统托盘
            setup_tray(app)?;

            // Propagate proxy env vars from login shell to the process environment
            // so that ALL HTTP clients (including the updater plugin) can reach
            // external services through the proxy.
            #[cfg(not(target_os = "windows"))]
            {
                let proxy_env = login_shell_proxy_env();
                for (k, v) in proxy_env {
                    if std::env::var(k).is_err() {
                        // SAFETY: called once during single-threaded setup
                        unsafe {
                            std::env::set_var(k, v);
                        }
                    }
                }
            }

            // Register updater plugin (desktop only)
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(not(desktop))]
            let _ = app;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session_process::start_claude_session,
            commands::preview::preview_open_url,
            commands::preview::preview_refresh,
            commands::preview::preview_back,
            commands::preview::preview_forward,
            commands::preview::open_browser_window,
            commands::session_process::send_stdin,
            commands::session_process::send_raw_stdin,
            commands::session_process::kill_session,
            commands::session_process::list_active_processes,
            commands::sessions::hide_session,
            get_claude_config_paths,
            commands::usage::get_usage_stats,
            commands::providers::get_provider_balance,
            commands::session_process::shutdown_all_sessions,
            commands::remote::list_remote_hosts,
            commands::remote::list_remote_sessions,
            commands::remote::get_remote_usage,
            commands::remote::read_remote_config,
            commands::remote::save_remote_host,
            commands::remote::delete_remote_host,
            commands::remote::list_ssh_config_hosts,
            commands::remote::test_remote_connection,
            commands::remote::load_remote_custom_previews,
            commands::remote::save_remote_custom_previews,
            commands::remote::load_remote_archived_sessions,
            commands::remote::save_remote_archived_sessions,
            commands::sessions::delete_session,
            commands::sessions::list_sessions,
            commands::usage::get_profile_stats,
            commands::sessions::search_sessions,
            commands::sessions::load_session,
            commands::sessions::get_session_tokens,
            commands::files::read_file_tree,
            commands::files::read_file_content,
            commands::files::write_file_content,
            commands::files::copy_file,
            commands::files::rename_file,
            commands::files::delete_file,
            commands::files::create_directory,
            commands::files::open_in_vscode,
            commands::files::reveal_in_finder,
            commands::files::open_with_default_app,
            commands::files::share_file,
            commands::files::share_to_wechat,
            commands::sessions::export_session_markdown,
            commands::sessions::export_session_json,
            commands::sessions::list_recent_projects,
            commands::files::watch_directory,
            commands::files::unwatch_directory,
            commands::files::save_temp_file,
            commands::files::get_file_size,
            commands::files::check_file_access,
            commands::files::read_file_base64,
            commands::skills::list_slash_commands,
            commands::skills::list_skills,
            commands::skills::load_skill_translation_config,
            commands::skills::save_skill_translation_config,
            commands::skills::read_skill,
            commands::skills::write_skill,
            commands::skills::delete_skill,
            commands::skills::toggle_skill_enabled,
            commands::skills::list_all_commands,
            commands::skills::translate_skill_metadata,
            commands::skills::translate_skill_markdown,
            commands::git::run_git_command,
            commands::git::rewind_files,
            set_dock_icon,
            commands::cli_setup::run_claude_command,
            commands::cli_setup::run_claude_plugin_command,
            commands::cli_setup::check_claude_cli,
            commands::cli_setup::diagnose_cli,
            commands::cli_setup::cleanup_old_cli,
            commands::cli_setup::pin_cli,
            commands::cli_setup::unpin_cli,
            commands::cli_setup::get_pinned_cli,
            commands::cli_setup::inject_cli_path,
            commands::cli_setup::delete_cli,
            commands::cli_setup::install_claude_cli,
            commands::cli_setup::update_claude_cli,
            commands::cli_setup::check_cli_update,
            commands::toolchain::check_node_env,
            commands::toolchain::install_node_env,
            commands::local_models::check_local_model_service,
            commands::local_models::list_local_models,
            commands::local_models::pull_local_model,
            commands::cli_setup::start_claude_login,
            commands::cli_setup::check_claude_auth,
            commands::cli_setup::open_terminal_login,
            commands::files::open_folder_in_terminal,
            commands::files::open_folder_in_terminal_admin,
            commands::sessions::load_custom_previews,
            commands::sessions::save_custom_previews,
            commands::sessions::load_pinned_sessions,
            commands::sessions::save_pinned_sessions,
            commands::sessions::load_archived_sessions,
            commands::sessions::save_archived_sessions,
            commands::sessions::get_session_rate_limits,
            commands::sessions::generate_session_title,
            commands::providers::load_providers,
            commands::providers::save_providers,
            commands::providers::test_provider_connection,
            commands::session_process::respond_permission,
            commands::session_process::send_control_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod decode_tests {
    use super::{compute_session_tokens, decode_project_name, extract_session_info, provider_messages_endpoint};

    #[test]
    fn test_session_tokens_use_latest_context_and_deduplicate_blocks() {
        let jsonl = concat!(
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":900,\"output_tokens\":20}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":900,\"output_tokens\":20}}}\n",
            "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"usage\":{\"input_tokens\":50,\"cache_read_input_tokens\":1050,\"output_tokens\":10}}}\n",
        );
        let usage = compute_session_tokens(std::io::Cursor::new(jsonl));
        assert_eq!(usage["totalInputTokens"], 150);
        assert_eq!(usage["totalOutputTokens"], 30);
        assert_eq!(usage["contextInputTokens"], 1100);
        assert_eq!(usage["contextOutputTokens"], 10);
    }

    #[test]
    fn test_session_info_does_not_require_assistant_reply() {
        let path = std::env::temp_dir().join(format!(
            "tokenicode-session-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(
            &path,
            r#"{"type":"user","cwd":"D:\\work","message":{"role":"user","content":"hi"}}"#,
        )
        .expect("write test session");

        let info = extract_session_info(&path);
        let _ = std::fs::remove_file(&path);

        assert_eq!(info, ("hi".to_string(), r"D:\work".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_dpapi_master_key_roundtrip() {
        let key = [42u8; super::MASTER_KEY_LEN];
        let sealed = super::seal_master_key(&key).expect("seal key");
        assert!(sealed.starts_with(super::DPAPI_MAGIC));
        assert_eq!(super::open_master_key(&sealed).expect("open key"), key);
    }

    #[test]
    fn test_openai_endpoint_keeps_deepseek_bare_base_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com", "openai"),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn test_openai_endpoint_keeps_v1_base_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com/v1", "openai"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_openai_endpoint_keeps_full_chat_completions_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com/v1/chat/completions", "openai"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_simple_path() {
        let result = decode_project_name("-Users-tinyzhuang-Documents-FocusZone");
        assert_eq!(result, "/Users/tinyzhuang/Documents/FocusZone");
    }


    #[test]
    fn test_hidden_dir_double_dash() {
        // FocusZone/.claude-worktrees/condescending-brown
        // "/" → "-", "." → empty part making "--"
        let result = decode_project_name(
            "-Users-tinyzhuang-Documents-FocusZone--claude-worktrees-condescending-brown",
        );
        println!("Result: {}", result);
        // Should contain .claude somewhere
        assert!(
            result.contains(".claude"),
            "Expected .claude in path, got: {}",
            result
        );
    }

    #[test]
    fn test_nested_subdir() {
        let result = decode_project_name("-Users-tinyzhuang-Desktop-test-NiCode");
        // test/NiCode or test-NiCode — depends on what exists on disk
        println!("Result: {}", result);
        assert!(result.starts_with("/Users/tinyzhuang/Desktop/test"));
    }

}
