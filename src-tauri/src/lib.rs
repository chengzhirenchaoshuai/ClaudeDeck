mod app_paths;
mod commands;
mod protocol;

use commands::providers::*;
use commands::cli_setup::*;
use commands::toolchain::*;
use commands::sessions::*;
pub use commands::sessions::statusline_write_hook;
use commands::files::*;
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

/// Capture proxy-related environment variables from the user's login shell.
/// GUI apps launched from Finder/Dock don't inherit shell env vars (including
/// proxy settings), which causes API requests to fail in regions that require
/// a proxy to reach Anthropic's API.
#[cfg(not(target_os = "windows"))]
fn login_shell_proxy_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        // Print proxy-related vars in key=value format, one per line.
        // Must use -ic (interactive) instead of -l (login) because proxy vars
        // are typically set in .zshrc/.bashrc which are only sourced for
        // interactive shells, not non-interactive login shells.
        let script = r#"for v in https_proxy http_proxy all_proxy no_proxy HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY; do eval "val=\$$v"; if [ -n "$val" ]; then echo "$v=$val"; fi; done"#;
        let output = std::process::Command::new(&shell)
            .args(["-ic", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        let mut map = HashMap::new();
        if let Ok(o) = output {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let k = k.trim();
                        let v = v.trim();
                        if !k.is_empty() && !v.is_empty() {
                            map.insert(k.to_string(), v.to_string());
                        }
                    }
                }
            }
        }
        if !map.is_empty() {
            eprintln!("login shell proxy env captured: {:?}", map.keys().collect::<Vec<_>>());
        }
        map
    })
}

/// Read macOS system proxy settings from `scutil --proxy`.
/// Re-reads every call so proxy changes are picked up immediately.
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .arg("--proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let get_val = |key: &str| -> Option<String> {
        text.lines()
            .find(|l| l.trim().starts_with(&format!("{} :", key)))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let is_enabled = |key: &str| get_val(key).map_or(false, |v| v == "1");

    // Prefer HTTPS > SOCKS > HTTP
    if is_enabled("HTTPSEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPSProxy"), get_val("HTTPSPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system HTTPS proxy detected");
            return Some(url);
        }
    }
    if is_enabled("SOCKSEnable") {
        if let (Some(host), Some(port)) = (get_val("SOCKSProxy"), get_val("SOCKSPort")) {
            let url = format!("socks5://{}:{}", host, port);
            eprintln!("system SOCKS proxy detected");
            return Some(url);
        }
    }
    if is_enabled("HTTPEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPProxy"), get_val("HTTPPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system HTTP proxy detected");
            return Some(url);
        }
    }
    None
}

/// Probe common local proxy ports and return the first reachable one.
/// Re-probes every call (fast: ~100ms worst case) so proxy tools started after
/// ClaudeDeck are still detected. Covers Clash, Surge, common SOCKS.
fn probe_local_proxy() -> Option<String> {
    let ports: &[(u16, &str)] = &[
        (7890, "http"),   // Clash default
        (7897, "http"),   // Clash Verge default
        (6152, "http"),   // Surge HTTP
        (1080, "socks5"), // Common SOCKS
    ];
    for &(port, scheme) in ports {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        if std::net::TcpStream::connect_timeout(
            &addr,
            std::time::Duration::from_millis(80),
        )
        .is_ok()
        {
            let url = format!("{}://127.0.0.1:{}", scheme, port);
            eprintln!("auto-detected local proxy");
            return Some(url);
        }
    }
    None
}

/// Resolve the best proxy URL from environment variables, system proxy, and login shell.
/// Returns Some(url) if a proxy is configured, None otherwise.
fn resolve_proxy_url() -> Option<String> {
    // 1. Check current process env vars (set by VPN/Clash when running)
    let from_env = std::env::var("https_proxy")
        .ok()
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("http_proxy").ok())
        .or_else(|| std::env::var("HTTP_PROXY").ok());
    if let Some(url) = from_env {
        if !url.is_empty() {
            return Some(url);
        }
    }
    // 2. macOS system proxy (System Settings > Network > Proxy)
    #[cfg(target_os = "macos")]
    {
        if let Some(url) = system_proxy_url() {
            return Some(url);
        }
    }
    // 3. macOS/Linux GUI apps don't inherit shell env; check login shell
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        let url = proxy_env
            .get("https_proxy")
            .or_else(|| proxy_env.get("HTTPS_PROXY"))
            .or_else(|| proxy_env.get("all_proxy"))
            .or_else(|| proxy_env.get("ALL_PROXY"))
            .or_else(|| proxy_env.get("http_proxy"))
            .or_else(|| proxy_env.get("HTTP_PROXY"));
        if let Some(u) = url {
            if !u.is_empty() {
                return Some(u.clone());
            }
        }
    }
    // 4. Probe common local proxy ports (Clash 7890, Surge 6152, SOCKS 1080)
    if let Some(url) = probe_local_proxy() {
        return Some(url);
    }
    None
}

/// Check if a proxy endpoint is actually reachable (TCP connect with 1s timeout).
async fn is_proxy_reachable(proxy_url: &str) -> bool {
    // Parse host:port from proxy URL like "http://127.0.0.1:7890"
    let addr = proxy_url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks5://")
        .trim_start_matches("socks5h://")
        .trim_end_matches('/');
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// Build a reqwest Client with smart proxy handling.
///
/// Logic: if a proxy URL is found in env/login-shell, probe the proxy port first.
/// If reachable → use proxy; if not (VPN off) → bypass and connect directly.
/// This makes the app "just work" regardless of VPN state.
async fn build_smart_http_client(
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
) -> reqwest::Client {
    // Reuse clients across calls — building a reqwest::Client (TLS + pool) on
    // every request is wasteful. Keyed by timeout + the resolved proxy so a
    // proxy change still yields a fresh client. Only the no-proxy client is
    // cached: when a proxy is configured we re-probe reachability each call to
    // honor VPN on/off (the "smart proxy" behavior).
    let proxy_key = resolve_proxy_url().unwrap_or_default();
    let cache_key = format!(
        "{}|{}|{}",
        connect_timeout.as_millis(),
        request_timeout.as_millis(),
        proxy_key
    );
    static CLIENTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, reqwest::Client>>,
    > = std::sync::OnceLock::new();
    if proxy_key.is_empty() {
        if let Some(c) = CLIENTS
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap()
            .get(&cache_key)
        {
            return c.clone();
        }
    }

    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .no_proxy(); // Disable automatic env proxy reading — we manage it ourselves

    if let Some(proxy_url) = resolve_proxy_url() {
        if is_proxy_reachable(&proxy_url).await {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                eprintln!("Smart proxy: using configured proxy");
                builder = builder.proxy(proxy);
            }
        } else {
            eprintln!("Smart proxy: configured proxy unreachable, connecting directly");
        }
    }

    let client = builder.build().unwrap_or_else(|_| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default()
    });
    if proxy_key.is_empty() {
        CLIENTS
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap()
            .insert(cache_key, client.clone());
    }
    client
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

#[tauri::command]
async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    params: StartSessionParams,
) -> Result<SessionInfo, String> {
    let session_id = params
        .session_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Clean up any existing process with the same session_id
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;

    // Use persistent stream-json input mode instead of per-message -p mode.
    // This keeps the CLI process alive so slash commands (/rewind, /compact, /cost, etc.) work.
    let mut args = vec![
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--replay-user-messages".to_string(),
    ];

    // 默认跳过全部 MCP 服务器以加快冷启动：MCP 服务器（chrome-devtools、codex 等）
    // 需要逐个初始化，CLI 才会接受输入，可能多出 20-30 秒。
    // 用户在“MCP 服务器”页打开“会话中加载 MCP”后，按 CLI 自身的配置加载。
    if !params.enable_mcp.unwrap_or(false) {
        args.push("--strict-mcp-config".to_string());
    }

    // Resume an existing CLI session if requested
    if let Some(ref resume_id) = params.resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
        // 回退：续接到指定消息并分叉出新会话，模型只会记得该消息（含）之前的历史
        if let Some(ref at) = params.resume_session_at {
            if !at.is_empty() && at.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                args.push("--resume-session-at".to_string());
                args.push(at.clone());
                args.push("--fork-session".to_string());
            }
        }
    }

    if let Some(ref model) = params.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    if let Some(ref tools) = params.allowed_tools {
        for tool in tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }

    // Permission mode: all modes use --permission-prompt-tool stdio so the CLI
    // routes user interactions (AskUserQuestion, ExitPlanMode) via control_request.
    // In bypassPermissions mode the CLI auto-approves tool permissions internally
    // (zero overhead) but still sends control_requests for user interactions.
    let permission_mode = params.permission_mode.as_deref().unwrap_or("default");
    args.push("--permission-mode".to_string());
    args.push(permission_mode.to_string());
    args.push("--permission-prompt-tool".to_string());
    args.push("stdio".to_string());

    // 远程项目（cwd 为 ssh://<主机>/<路径>）：经 ssh 在远端运行 claude，使用远端自己的配置。
    // 不注入本机 Provider 环境变量与模型映射，也不需要本机的 claude / git-bash。
    // 挪到 --settings 构造之前：下面要根据是不是远程决定要不要加 statusLine 钩子
    // （钩子指向本机的 claudedeck.exe 路径，对远程主机毫无意义，不能带过去）。
    let remote_target = commands::remote::parse_remote_uri(&params.cwd);

    // Extended thinking + effort level
    let thinking_level = params.thinking_level.as_deref().unwrap_or("high");
    let mut settings_obj = serde_json::json!({
        "alwaysThinkingEnabled": thinking_level != "off",
    });
    // 5 小时 / 7 天用量只有 claude.ai Pro/Max 账户才有，CLI 不会主动通过
    // stream-json 的 rate_limit_event 可靠地带上具体百分比（不同版本字段不一样，
    // 部分版本干脆没有）。官方文档里唯一稳定带百分比的渠道是 statusLine 钩子：
    // CLI 每次助手回复后会调用这个命令，把包含 rate_limits.five_hour/seven_day
    // .used_percentage 的完整会话状态 JSON 喂给它。这里让 claudedeck.exe 自己
    // 兼任这个钩子（--statusline-write，见 main.rs），把摘出来的 rate_limits
    // 写到本地文件，前端再通过 get_session_rate_limits 读取。只对本机会话生效——
    // 远程主机上没有这个可执行文件，钩子指过去也跑不起来。
    if remote_target.is_none() {
        if let Ok(exe) = std::env::current_exe() {
            // 官方文档明确写了：Windows 上 statusLine 命令是通过 Git Bash（装了的话）
            // 或者 PowerShell 跑的；Git Bash 会把不在引号保护范围内的反斜杠当成转义符，
            // 路径分隔符直接被吃掉，命令静默失败、什么错误都不会冒出来——这正是钩子
            // 完全没生效、5h/7d 用量彻底不显示的真正原因。文档给的解决办法就是路径统一用
            // 正斜杠，Windows 的 CreateProcess/PowerShell/Git Bash 三边都认，不需要纠结
            // 引号规则。
            let exe_str = exe.display().to_string().replace('\\', "/");
            settings_obj["statusLine"] = serde_json::json!({
                "type": "command",
                "command": format!("\"{}\" --statusline-write", exe_str),
            });
        }
    }
    args.push("--settings".to_string());
    args.push(settings_obj.to_string());
    let (mut child, claude_bin, env_count) = if let Some((host_id, remote_path)) = remote_target {
        let host = commands::remote::find_host(&host_id)?;
        // 去掉本机专用的参数：--strict-mcp-config（远端沿用自己的 MCP 配置）、
        // --model（本机的模型映射对远端无意义，由远端配置决定）
        let mut remote_args: Vec<String> = Vec::new();
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--strict-mcp-config" => {}
                "--model" => {
                    iter.next();
                }
                _ => remote_args.push(arg.clone()),
            }
        }
        let effort = thinking_level.to_string();
        let mut remote_env: Vec<(&str, &str)> = vec![
            ("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1"),
            ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "64000"),
        ];
        if thinking_level != "off" {
            remote_env.push(("CLAUDE_CODE_EFFORT_LEVEL", effort.as_str()));
        }
        let remote_cmd = commands::remote::build_remote_claude_command(
            &remote_path,
            &remote_env,
            &remote_args,
        )?;
        let mut cmd = commands::remote::ssh_command(&host);
        cmd.arg(&remote_cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start ssh (is OpenSSH client installed?): {}", e))?;
        (child, format!("ssh:{}", host_id), remote_env.len())
    } else {
        // Resolve claude binary — it may not be on the default PATH
        let claude_bin = find_claude_binary().unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                "claude.cmd".to_string()
            }
            #[cfg(not(target_os = "windows"))]
            {
                "claude".to_string()
            }
        });

        // Build an enriched PATH for the child process
        let enriched_path = build_enriched_path();

        // Resolve provider environment variables from provider_id
        let (mut resolved_env, inherited_keys_to_remove, provider_extra_args) =
            resolve_provider_env(params.provider_id.as_deref())?;

        // Append provider-specific CLI args (e.g. --setting-sources project,local)
        args.extend(provider_extra_args);

        // Inject effort level env var for non-off thinking levels
        if thinking_level != "off" {
            resolved_env.insert(
                "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
                thinking_level.to_string(),
            );
        }

        // Raise the per-turn output token cap from the CLI default (32K) to 64K.
        // This prevents "response exceeded the 32000 output token maximum" errors
        // when generating large files (e.g. HTML presentations).
        resolved_env
            .entry("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string())
            .or_insert_with(|| "64000".to_string());

        // Enable CLI-managed file checkpoints for rewind functionality.
        // With --replay-user-messages, user messages in stream output carry a uuid
        // that identifies the checkpoint. The rewind_files command uses these UUIDs.
        resolved_env.insert(
            "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".to_string(),
            "1".to_string(),
        );

        // For long-context third-party routes, override Claude Code's internal compact window.
        // Some provider model names do not expose a 1M marker, so the frontend can declare it.
        let declared_context_window = params.context_window.unwrap_or_else(|| {
            params.model.as_deref().map(|model_name| {
                let m = model_name.to_lowercase();
                if m.contains("mimo") || m.contains("[1m]") { 1_000_000 } else { 200_000 }
            }).unwrap_or(200_000)
        });
        if declared_context_window >= 1_000_000 {
            resolved_env.insert(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
                declared_context_window.to_string(),
            );
            eprintln!(
                "[ClaudeDeck] Set CLAUDE_CODE_AUTO_COMPACT_WINDOW={} for model {:?}",
                declared_context_window,
                params.model
            );
        }

        // On Windows, disable MSYS2/Git Bash automatic path conversion.
        // Without this, MSYS2 converts Windows paths (e.g. F:\秀\input\file.xlsx)
        // to Unix-style paths (/f/秀/input/file.xlsx), which breaks file operations
        // especially with non-ASCII (Chinese) characters in paths.
        #[cfg(target_os = "windows")]
        {
            resolved_env.entry("MSYS_NO_PATHCONV".to_string())
                .or_insert_with(|| "1".to_string());
            resolved_env.entry("MSYS2_ARG_CONV_EXCL".to_string())
                .or_insert_with(|| "*".to_string());
        }

        // On Windows, auto-detect git-bash and inject CLAUDE_CODE_GIT_BASH_PATH
        // so Claude Code CLI can find bash.exe without user manual configuration.
        #[cfg(target_os = "windows")]
        {
            if !resolved_env.contains_key("CLAUDE_CODE_GIT_BASH_PATH") {
                if let Some(bash_path) = find_git_bash() {
                    resolved_env.insert("CLAUDE_CODE_GIT_BASH_PATH".to_string(), bash_path);
                } else {
                    // git-bash is a hard requirement for Claude Code on Windows.
                    // Fail fast with a clear error instead of spawning and getting a silent exit.
                    return Err("Claude Code requires Git Bash on Windows.\n\
                         Please reinstall Claude Code via Settings to auto-install Git,\n\
                         or install Git for Windows manually: https://git-scm.com/downloads/win"
                        .to_string());
                }
            }
        }

        // Auto-detect and inject proxy env vars into CLI subprocess.
        // GUI apps launched from Finder/Dock don't inherit shell proxy settings.
        // Detection order: login shell > macOS system proxy > local port probing.
        #[cfg(not(target_os = "windows"))]
        {
            let proxy_env = login_shell_proxy_env();
            for (k, v) in proxy_env {
                if !resolved_env.contains_key(k) && std::env::var(k).is_err() {
                    resolved_env.insert(k.clone(), v.clone());
                }
            }
        }

        // If still no proxy env vars, try system proxy + port probing
        {
            let has_proxy = resolved_env.keys().any(|k| {
                let kl = k.to_lowercase();
                kl == "https_proxy" || kl == "http_proxy" || kl == "all_proxy"
            });
            if !has_proxy {
                // resolve_proxy_url checks: process env > system proxy > login shell > port probing
                if let Some(url) = resolve_proxy_url() {
                    for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
                        resolved_env.insert(key.to_string(), url.clone());
                    }
                    if url.starts_with("socks") {
                        resolved_env.insert("all_proxy".to_string(), url.clone());
                        resolved_env.insert("ALL_PROXY".to_string(), url.clone());
                    }
                }
            }
        }

        // On Windows, .cmd/.bat files must be launched via cmd /C
        #[cfg(target_os = "windows")]
        let child = {
            // Helper: build and spawn a Command for the given binary
            let spawn_win = |bin: &str| {
                let needs_cmd = bin.ends_with(".cmd")
                    || bin.ends_with(".bat")
                    || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'));
                let mut cmd = if needs_cmd {
                    let mut c = Command::new("cmd");
                    c.arg("/C").arg(bin);
                    c
                } else {
                    Command::new(bin)
                };
                cmd.args(&args)
                    .current_dir(&params.cwd)
                    .env("PATH", &enriched_path)
                    .env_remove("CLAUDECODE");
                for key in &inherited_keys_to_remove {
                    cmd.env_remove(key);
                }
                for (key, value) in &resolved_env {
                    cmd.env(key, value);
                }
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .creation_flags(0x08000000)
                    .spawn()
            };

            match spawn_win(&claude_bin) {
                Ok(c) => c,
                Err(e) if e.raw_os_error() == Some(193) => {
                    // Error 193: not a valid Win32 application — binary is corrupt.
                    // Clean up the bad binary and try to find an alternative.
                    eprintln!("error 193 on '{}', cleaning up and retrying...", claude_bin);
                    if let Some(cli_dir) = cli_download_dir() {
                        let suspect = cli_dir.join("claude.exe");
                        if suspect.exists() {
                            let _ = std::fs::remove_file(&suspect);
                        }
                    }
                    let alt_bin = find_claude_binary().unwrap_or_else(|| "claude.cmd".to_string());
                    if alt_bin == claude_bin {
                        return Err(format!(
                            "Failed to spawn claude (tried '{}'): {}",
                            claude_bin, e
                        ));
                    }
                    eprintln!("Retrying with alternative: {}", alt_bin);
                    spawn_win(&alt_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}' then '{}'): {}",
                            claude_bin, alt_bin, e2
                        )
                    })?
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let child = {
            let spawn_unix = |bin: &str| -> std::io::Result<tokio::process::Child> {
                let mut cmd = Command::new(bin);
                cmd.args(&args)
                    .current_dir(&params.cwd)
                    .env("PATH", &enriched_path)
                    // Clear CLAUDECODE env var so the CLI doesn't refuse to start
                    // when ClaudeDeck itself is launched from within a Claude Code session.
                    .env_remove("CLAUDECODE");
                // Clear inherited ANTHROPIC_* env vars that conflict with our overrides
                for key in &inherited_keys_to_remove {
                    cmd.env_remove(key);
                }
                // Inject custom API provider env vars
                for (key, value) in &resolved_env {
                    cmd.env(key, value);
                }
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
            };

            match spawn_unix(&claude_bin) {
                Ok(c) => c,
                Err(e) if e.raw_os_error() == Some(13) => {
                    // EACCES
                    // Permission denied — attempt to fix execute permission and retry.
                    eprintln!(
                        "EACCES on '{}', attempting chmod +x and retrying...",
                        claude_bin
                    );
                    let path = std::path::Path::new(&claude_bin);
                    let fixed = (|| -> Result<(), std::io::Error> {
                        use std::os::unix::fs::PermissionsExt;
                        let metadata = std::fs::metadata(path)?;
                        let mut perms = metadata.permissions();
                        perms.set_mode(perms.mode() | 0o755);
                        std::fs::set_permissions(path, perms)?;
                        Ok(())
                    })();
                    if let Err(chmod_err) = fixed {
                        eprintln!("chmod +x failed: {}", chmod_err);
                        return Err(format!(
                            "Failed to spawn claude (tried '{}', permission denied, chmod fix also failed: {}): {}",
                            claude_bin, chmod_err, e
                        ));
                    }
                    eprintln!("chmod +x succeeded, retrying spawn...");
                    spawn_unix(&claude_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}', retried after chmod +x): {}",
                            claude_bin, e2
                        )
                    })?
                }
                Err(e) if e.raw_os_error() == Some(88) || e.raw_os_error() == Some(8) => {
                    // ENOEXEC (88 on macOS, 8 on Linux) — Malformed binary.
                    // Delete the corrupt binary and try to find an alternative.
                    eprintln!(
                        "ENOEXEC on '{}' (malformed binary), cleaning up and retrying...",
                        claude_bin
                    );
                    if let Some(cli_dir) = cli_download_dir() {
                        let suspect = cli_dir.join("claude");
                        if suspect.exists() {
                            let _ = std::fs::remove_file(&suspect);
                            eprintln!("Removed corrupt binary: {:?}", suspect);
                        }
                    }
                    let alt_bin = find_claude_binary().unwrap_or_else(|| "claude".to_string());
                    if alt_bin == claude_bin {
                        return Err(format!(
                            "Failed to spawn claude (tried '{}', binary is malformed/corrupt — \
                             please reinstall CLI from Settings): {}",
                            claude_bin, e
                        ));
                    }
                    eprintln!("Retrying with alternative: {}", alt_bin);
                    spawn_unix(&alt_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}' then '{}'): {}",
                            claude_bin, alt_bin, e2
                        )
                    })?
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
            }
        };
        (child, claude_bin, resolved_env.len())
    };

    let pid = child.id().unwrap_or(0);
    eprintln!(
        "[ClaudeDeck] CLI spawned: pid={}, bin={}, permission_mode={}",
        pid, claude_bin, permission_mode
    );
    // Never log subprocess arguments, PATH, or environment values: provider
    // API keys and proxy credentials may be present in those values.
    eprintln!(
        "[ClaudeDeck] runtime config: args={}, env_keys={}",
        args.len(),
        env_count
    );
    eprintln!("[ClaudeDeck] cwd: {}", &params.cwd);

    // Capture stdin and store in StdinManager for sending follow-up messages
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    stdin_mgr.insert(session_id.clone(), stdin).await;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let sid = session_id.clone();

    state
        .insert(
            sid.clone(),
            ManagedProcess {
                child,
                session_id: sid.clone(),
            },
        )
        .await;

    // Helper: emit to the main webview using emit_to for reliable delivery
    fn emit_to_frontend(app: &AppHandle, event: &str, payload: Value) -> Result<(), String> {
        if let Err(e1) = app.emit_to("main", event, payload.clone()) {
            // Fallback: use global emit
            if let Err(e2) = app.emit(event, payload) {
                return Err(format!("emit_to failed: {}, emit failed: {}", e1, e2));
            }
        }
        Ok(())
    }

    // Spawn stdout reader — streams NDJSON to frontend, intercepts control_request
    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let stdin_clone = stdin_mgr.inner().clone();
    let is_bypass = permission_mode == "bypassPermissions";
    tokio::spawn(async move {
        let stream_event = format!("claude:stream:{}", sid_clone);
        // Use a large buffer (1MB) to efficiently read large NDJSON lines from Claude CLI.
        // Default 8KB buffer causes thousands of syscalls for large outputs (e.g. 24.8MB PDF),
        // which stalls on Windows pipes. 1MB buffer reduces syscalls by ~125x.
        let mut reader = BufReader::with_capacity(1024 * 1024, stdout);
        let mut line_count: u64 = 0;
        let mut emit_fail_count: u32 = 0;
        let spawn_time = std::time::Instant::now();
        loop {
            // 按字节读、lossy 转换，理由同 stderr 读取那边：不能因为某一行不是合法
            // UTF-8（理论上不该发生，但防御性地保证一次坏数据不会让整条流从此死掉）
            // 就让 .lines() 直接报错终止，之后所有正常输出也读不到了。
            let mut buf: Vec<u8> = Vec::new();
            let line = match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,  // normal EOF
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                        buf.pop();
                    }
                    String::from_utf8_lossy(&buf).into_owned()
                }
                Err(e) => {
                    eprintln!("[ClaudeDeck:CRITICAL] stdout read error after {} lines: {}", line_count, e);
                    break;
                }
            };
            line_count += 1;
            // Parse every line as a JSON Value first (avoids serde enum pitfalls)
            let json = match serde_json::from_str::<Value>(&line) {
                Ok(v) => v,
                Err(_) => continue, // skip non-JSON lines
            };
            // Keep startup diagnostics without persisting prompts, responses,
            // thinking text, tool input, or other user data in application logs.
            if line_count <= 10 {
                eprintln!(
                    "[ClaudeDeck:stdout] #{} @{}ms type={} subtype={} bytes={}",
                    line_count,
                    spawn_time.elapsed().as_millis(),
                    json.get("type").and_then(|v| v.as_str()).unwrap_or("?"),
                    json.get("subtype").and_then(|v| v.as_str()).unwrap_or("-"),
                    line.len(),
                );
            }

            // Intercept control_request messages for SDK control protocol routing.
            // All modes use --permission-prompt-tool stdio. In bypass mode, we
            // auto-approve tool permissions here (zero frontend overhead) but route
            // user interactions (AskUserQuestion) to the frontend.
            if let Some("control_request") = json.get("type").and_then(|v| v.as_str()) {
                let request_id = json
                    .get("request_id")
                    .or_else(|| json.get("requestId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(request) = json.get("request") {
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();

                    // Bypass mode: auto-approve everything except user interactions.
                    if is_bypass {
                        let tool_name = request
                            .get("tool_name")
                            .or_else(|| request.get("toolName"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if tool_name != "AskUserQuestion" {
                            let mut allow = serde_json::json!({ "behavior": "allow" });
                            if subtype == "can_use_tool" {
                                allow["updatedInput"] = request
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Object(serde_json::Map::new()));
                                if let Some(id) = request
                                    .get("tool_use_id")
                                    .or_else(|| request.get("toolUseId"))
                                    .and_then(|v| v.as_str())
                                {
                                    allow["toolUseID"] = Value::String(id.to_string());
                                }
                            }
                            let resp = serde_json::json!({
                                "type": "control_response",
                                "response": { "subtype": "success", "request_id": request_id, "response": allow }
                            });
                            let _ = stdin_clone.send(&sid_clone, &resp.to_string()).await;
                            continue;
                        }
                        // AskUserQuestion: fall through to frontend routing
                    }

                    match subtype {
                        "can_use_tool" => {
                            let tool_name = request
                                .get("tool_name")
                                .or_else(|| request.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input = request.get("input").cloned().unwrap_or(Value::Null);
                            let description = request
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let tool_use_id = request
                                .get("tool_use_id")
                                .or_else(|| request.get("toolUseId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);

                            eprintln!(
                                "[ClaudeDeck] permission request: tool={} request_id={}",
                                tool_name, request_id
                            );

                            // Emit as a special stream message (reuses the working stream channel)
                            let perm_payload = serde_json::json!({
                                "type": "tokenicode_permission_request",
                                "request_id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "description": description,
                                "tool_use_id": tool_use_id,
                            });
                            let _ = emit_to_frontend(&app_clone, &stream_event, perm_payload);
                            continue; // Don't forward to stream as normal msg
                        }
                        "hook_callback" => {
                            // Auto-allow hook callbacks (ClaudeDeck doesn't manage hooks)
                            let auto_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "allow" }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                            continue;
                        }
                        other => {
                            // Unknown control request subtype — deny by default (P0-4 fix)
                            eprintln!("[ClaudeDeck] control_request/{}: denying unknown subtype (request_id={})", other, request_id);
                            let deny_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "deny", "message": format!("Unknown permission type '{}' denied by ClaudeDeck", other) }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &deny_resp.to_string()).await;
                            continue;
                        }
                    }
                } else {
                    eprintln!(
                        "[ClaudeDeck] control_request missing 'request' field: {}",
                        &line[..line.len().min(200)]
                    );
                    // Auto-allow to avoid blocking CLI
                    let auto_resp = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": { "behavior": "allow" }
                        }
                    });
                    let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                    continue;
                }
            }

            // Normal message — forward to frontend stream.
            // For very large messages (e.g. PDF content, large file reads), truncate the
            // content before sending through Tauri IPC to avoid freezing the WebView.
            // Claude CLI already has the full content internally; the frontend only needs
            // a preview for display purposes.
            let json_to_emit = {
                let serialized_len = line.len();
                const MAX_IPC_BYTES: usize = 2 * 1024 * 1024; // 2MB threshold
                if serialized_len > MAX_IPC_BYTES {
                    let mut truncated = json.clone();
                    // Truncate content in tool_result blocks and message content
                    if let Some(content) = truncated.get_mut("content") {
                        truncate_large_content(content, MAX_IPC_BYTES / 2);
                    }
                    if let Some(msg) = truncated.get_mut("message") {
                        if let Some(content) = msg.get_mut("content") {
                            truncate_large_content(content, MAX_IPC_BYTES / 2);
                        }
                    }
                    truncated
                } else {
                    json
                }
            };
            if let Err(e) = emit_to_frontend(&app_clone, &stream_event, json_to_emit) {
                emit_fail_count += 1;
                eprintln!("[ClaudeDeck] emit_to_frontend failed (#{emit_fail_count}): {e}");
                // If emit fails repeatedly, the frontend is likely unreachable.
                // Break the loop to trigger process_exit cleanup (#64).
                if emit_fail_count >= 10 {
                    eprintln!("[ClaudeDeck:CRITICAL] {} consecutive emit failures — frontend unreachable, stopping stream", emit_fail_count);
                    break;
                }
            } else {
                emit_fail_count = 0;  // reset on success
            }
        }
        // Emit process_exit on the stream channel (primary detection)
        let _ = emit_to_frontend(
            &app_clone,
            &stream_event,
            serde_json::json!({"type": "process_exit"}),
        );
        // Also emit on the dedicated exit channel (backup detection via onSessionExit)
        let _ = emit_to_frontend(
            &app_clone,
            &format!("claude:exit:{}", sid_clone),
            serde_json::json!(null),
        );

        // Notify frontend that session list may have changed
        let _ = emit_to_frontend(&app_clone, "sessions:changed", serde_json::json!(null));
    });

    // Spawn stderr reader
    let app_clone2 = app.clone();
    let sid_clone2 = sid.clone();
    tokio::spawn(async move {
        // 不用 .lines()：它按 UTF-8 解码，一旦某一行不是合法 UTF-8（远程主机是中文
        // Windows 时，PowerShell 在没有控制台的情况下常常用系统 OEM 代码页而不是
        // UTF-8 输出错误信息）next_line() 就会返回 Err，这个 while-let 循环会直接
        // 静默退出、后面的内容再也读不到——用户看到的错误就会诡异地卡在第一行
        // （比如只有一句 "#< CLIXML" 没有下文）。改成按字节读到 \n，用 lossy 转换
        // （非法字节替换成 �），保证不管编码是否正确都能把内容读完整。
        let mut reader = BufReader::with_capacity(256 * 1024, stderr);
        loop {
            let mut buf: Vec<u8> = Vec::new();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                        buf.pop();
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let _ = emit_to_frontend(
                        &app_clone2,
                        &format!("claude:stderr:{}", sid_clone2),
                        serde_json::json!(line),
                    );
                }
                Err(e) => {
                    eprintln!("[ClaudeDeck:CRITICAL] stderr read error: {}", e);
                    break;
                }
            }
        }
    });

    // Send the first message via stdin as NDJSON (skip if prompt is empty — pre-warm mode)
    if !params.prompt.is_empty() {
        let first_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": params.prompt
            }
        });
        stdin_mgr.send(&sid, &first_msg.to_string()).await?;
    }

    Ok(SessionInfo {
        session_id: sid,
        pid,
        cli_path: claude_bin.clone(),
    })
}

#[tauri::command]
async fn send_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // Wrap user text in stream-json NDJSON format
    let json_msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });
    stdin_mgr.send(&session_id, &json_msg.to_string()).await
}

#[tauri::command]
async fn send_raw_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    stdin_mgr.send(&session_id, &message).await
}

/// Respond to a structured permission request from the SDK control protocol.
/// Called by the frontend when the user approves or denies a tool use.
///
/// IMPORTANT: The SDK always sends `updatedInput` with the original tool input when allowing.
/// CLI internally relies on this field. For deny, only `message` is included.
/// Format mirrors exactly what the SDK constructs (from reverse-engineered source).
#[tauri::command]
async fn respond_permission(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
    tool_use_id: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    let mut inner = serde_json::Map::new();
    if allow {
        inner.insert("behavior".into(), Value::String("allow".into()));
        // SDK always includes updatedInput with the original tool input on allow
        inner.insert(
            "updatedInput".into(),
            updated_input.unwrap_or(Value::Object(serde_json::Map::new())),
        );
    } else {
        inner.insert("behavior".into(), Value::String("deny".into()));
        inner.insert(
            "message".into(),
            Value::String(message.unwrap_or_else(|| "User denied this operation".into())),
        );
    }
    if let Some(ref tuid) = tool_use_id {
        inner.insert("toolUseID".into(), Value::String(tuid.clone()));
    }

    let resp = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": inner,
        }
    });
    let json_str = resp.to_string();
    stdin_mgr.send(&session_id, &json_str).await
}

/// Send a runtime control request to the CLI (set_permission_mode, set_model, interrupt).
#[tauri::command]
async fn send_control_request(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    subtype: String,
    payload: Value,
) -> Result<(), String> {
    use protocol::ControlRequest;
    let req = match subtype.as_str() {
        "interrupt" => ControlRequest::interrupt(),
        "set_permission_mode" => {
            let mode = payload
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'mode' in payload")?
                .to_string();
            ControlRequest::set_permission_mode(mode)
        }
        "set_model" => {
            let model = payload
                .get("model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            ControlRequest::set_model(model)
        }
        "rewind_files" => {
            let user_message_id = payload
                .get("user_message_id")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'user_message_id' in payload")?
                .to_string();
            ControlRequest::rewind_files(user_message_id)
        }
        other => return Err(format!("Unknown control request subtype: {}", other)),
    };
    let json_str = serde_json::to_string(&req)
        .map_err(|e| format!("Failed to serialize control request: {}", e))?;
    stdin_mgr.send(&session_id, &json_str).await
}

#[tauri::command]
async fn kill_session(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
) -> Result<(), String> {
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;
    Ok(())
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

/// 应用退出前有序终止所有会话进程（本地 claude 与经 ssh 启动的远端 claude 一视同仁）：
/// 先发 interrupt 中断当前回合，稍候关闭 stdin（远端经 ssh 转发为 EOF），
/// 等进程自行退出，超时（3 秒）才强制结束，尽量避免留下孤儿进程。
#[tauri::command]
async fn shutdown_all_sessions(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
) -> Result<(), String> {
    let ids = state.active_ids().await;
    if ids.is_empty() {
        return Ok(());
    }
    if let Ok(interrupt) = serde_json::to_string(&protocol::ControlRequest::interrupt()) {
        for id in &ids {
            let _ = stdin_mgr.send(id, &interrupt).await;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    for id in &ids {
        stdin_mgr.remove(id).await;
    }
    state.wait_or_kill_all(std::time::Duration::from_secs(3)).await;
    Ok(())
}

/// TK-329: List all active stdinIds from ProcessManager.
/// Frontend uses this after refresh to detect and clean up orphaned backend processes.
#[tauri::command]
async fn list_active_processes(
    state: State<'_, ProcessManager>,
) -> Result<Vec<String>, String> {
    Ok(state.active_ids().await)
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
            start_claude_session,
            commands::preview::preview_open_url,
            commands::preview::preview_refresh,
            commands::preview::preview_back,
            commands::preview::preview_forward,
            commands::preview::open_browser_window,
            send_stdin,
            send_raw_stdin,
            kill_session,
            list_active_processes,
            commands::sessions::hide_session,
            get_claude_config_paths,
            commands::usage::get_usage_stats,
            commands::providers::get_provider_balance,
            shutdown_all_sessions,
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
            respond_permission,
            send_control_request,
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
    fn test_hyphenated_dir() {
        // ppt-maker exists on disk as a dir with hyphens in name
        let result = decode_project_name("-Users-tinyzhuang-Desktop-ppt-maker");
        assert_eq!(result, "/Users/tinyzhuang/Desktop/ppt-maker");
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

    #[test]
    fn test_space_in_dir_name() {
        // "jd 设计" exists at ~/Desktop/jd 设计
        let result = decode_project_name("-Users-tinyzhuang-Desktop-jd-设计");
        println!("Result: {}", result);
        // Should decode to "/Users/tinyzhuang/Desktop/jd 设计"
        assert_eq!(result, "/Users/tinyzhuang/Desktop/jd 设计");
    }
}
