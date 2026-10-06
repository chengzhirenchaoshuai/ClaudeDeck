mod app_paths;
mod commands;
mod protocol;

use commands::providers::*;
use commands::cli_setup::*;
use commands::toolchain::*;
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

/// Holds a watcher and its background flush task; dropping stops both.
struct WatchHandle {
    _watcher: notify::RecommendedWatcher,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Manages active file watchers with debounced event batching
#[derive(Default)]
struct WatcherManager {
    watchers: Arc<TokioMutex<HashMap<String, WatchHandle>>>,
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

/// 隐藏名单文件：只记录“回退”产生的被替换旧分支。
/// 会话列表以 CLI 的 projects 目录为准，这里的 ID 仅在列表中不显示，jsonl 文件保留以便恢复。
fn hidden_sessions_path() -> Result<std::path::PathBuf, String> {
    app_paths::config_path("hidden_sessions.txt")
}

/// 读取隐藏名单。文件不存在或读取失败时视为空。
fn load_hidden_sessions() -> std::collections::HashSet<String> {
    let Ok(path) = hidden_sessions_path() else {
        return std::collections::HashSet::new();
    };
    std::fs::read_to_string(&path)
        .map(|content| {
            content
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// 会话是否应出现在列表中：排除 desk_* 临时 ID 与被回退隐藏的旧分支。
fn is_listable_session(id: &str, hidden: &std::collections::HashSet<String>) -> bool {
    !id.starts_with("desk_") && !hidden.contains(id)
}

/// 从列表中隐藏一个被替换的会话（不删除 JSONL 文件）。回退功能用它替换可见分支。
#[tauri::command]
async fn hide_session(session_id: String) -> Result<(), String> {
    if session_id.is_empty() || load_hidden_sessions().contains(&session_id) {
        return Ok(());
    }
    use std::io::Write;
    let path = hidden_sessions_path()?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open hidden sessions: {}", e))?;
    writeln!(file, "{}", session_id).map_err(|e| format!("Failed to write hidden session: {}", e))
}

/// 监听 CLI 会话目录（<配置目录>/projects），jsonl 有新增、修改或删除时，
/// 经 1 秒防抖向前端发送 `cli-sessions:changed`（附带变化的文件路径），
/// 使会话列表和已打开的会话内容与 CLI 保持同步。
/// projects 目录尚未创建时（CLI 从未运行）每 3 秒重试，不主动创建该目录。
fn start_sessions_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use notify::{Event, EventKind, RecursiveMode, Watcher};
        use std::time::Duration;

        let Ok(dir) = claude_projects_dir() else {
            return;
        };
        while !dir.exists() {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }

        // 通道里传递本次事件涉及的 jsonl 路径；删除整个项目文件夹时路径不带 .jsonl 后缀，
        // 此时发送空列表，仅提示前端刷新会话列表
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<String>>();
        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            let jsonl_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| p.extension().map_or(false, |e| e == "jsonl"))
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let relevant = match event.kind {
                EventKind::Remove(_) => true,
                EventKind::Create(_) | EventKind::Modify(_) => !jsonl_paths.is_empty(),
                _ => false,
            };
            if relevant {
                let _ = tx.send(jsonl_paths);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[ClaudeDeck] Failed to create sessions watcher: {}", e);
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
            eprintln!("[ClaudeDeck] Failed to watch {:?}: {}", dir, e);
            return;
        }

        // watcher 需在此作用域内保持存活，否则监听会随之停止
        while let Some(first) = rx.recv().await {
            let mut changed: std::collections::HashSet<String> = first.into_iter().collect();
            tokio::time::sleep(Duration::from_millis(1000)).await;
            while let Ok(more) = rx.try_recv() {
                changed.extend(more);
            }
            let _ = app.emit(
                "cli-sessions:changed",
                serde_json::json!({ "paths": changed.into_iter().collect::<Vec<_>>() }),
            );
        }
    });
}

/// Delete a session: delete the .jsonl file under the CLI projects dir
#[tauri::command]
async fn delete_session(_session_id: String, session_path: String) -> Result<(), String> {
    if session_path.starts_with(commands::remote::REMOTE_SCHEME) {
        return commands::remote::delete_remote_session(&session_path).await;
    }
    // 仅允许删除 CLI projects 目录内的 jsonl（P0-1 fix）
    if !session_path.is_empty() {
        let target = std::path::Path::new(&session_path);
        if target.exists() {
            let canonical = target
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?;
            // 白名单目录也需规范化，否则 Windows 下 \\?\ 前缀会导致 starts_with 误判
            let allowed_dir = claude_projects_dir()?
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize projects dir: {}", e))?;
            if !canonical.starts_with(&allowed_dir) {
                return Err(format!(
                    "Refusing to delete file outside CLI projects dir: {:?}",
                    canonical
                ));
            }
            std::fs::remove_file(&canonical)
                .map_err(|e| format!("Failed to delete session file: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_sessions() -> Result<Vec<Value>, String> {
    let claude_dir = claude_projects_dir()?;

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    // 以 CLI 的 projects 目录为准，仅排除临时 ID 与回退隐藏的旧分支
    let hidden = load_hidden_sessions();

    let mut sessions = vec![];
    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();

                                if !is_listable_session(&id, &hidden) {
                                    continue;
                                }

                                // Get file metadata for timestamp
                                let modified = std::fs::metadata(&path)
                                    .and_then(|m| m.modified())
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);

                                // Read the first few lines to extract preview and cwd.
                                // A session must remain visible even when it has no
                                // assistant record yet (for example after an API failure).
                                let (preview, cwd) = extract_session_info(&path);

                                // Use cwd from JSONL if available (authoritative),
                                // otherwise fall back to decoding the directory name.
                                let project_dir = entry.file_name().to_string_lossy().to_string();
                                let project_name = resolve_project_path(&cwd, &project_dir);

                                sessions.push(serde_json::json!({
                                    "id": id,
                                    "path": path.to_string_lossy(),
                                    "project": project_name,
                                    "projectDir": project_dir,
                                    "modifiedAt": modified,
                                    "preview": preview,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by modified time, newest first
    sessions.sort_by(|a, b| {
        let ta = a["modifiedAt"].as_u64().unwrap_or(0);
        let tb = b["modifiedAt"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(sessions)
}

/// Search across listed session JSONL files for a query string.
/// Returns matching sessions with snippets, sorted by match_count descending (max 50).
#[tauri::command]
async fn search_sessions(query: String) -> Result<Vec<Value>, String> {
    if query.len() < 2 {
        return Ok(vec![]);
    }

    let claude_dir = claude_projects_dir()?;

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    let hidden = load_hidden_sessions();
    let query_lower = query.to_lowercase();

    let mut results: Vec<Value> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();
                                if !is_listable_session(&id, &hidden) {
                                    continue;
                                }
                                if let Some(result) = search_session_file(&path, &query_lower) {
                                    results.push(result);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by match_count descending
    results.sort_by(|a, b| {
        let ca = a["match_count"].as_u64().unwrap_or(0);
        let cb = b["match_count"].as_u64().unwrap_or(0);
        cb.cmp(&ca)
    });

    results.truncate(50);
    Ok(results)
}

/// Search a single session JSONL file for the query string.
/// Returns a JSON value with session_id, snippet, match_count, and match_role if any matches found.
fn search_session_file(path: &std::path::Path, query_lower: &str) -> Option<serde_json::Value> {
    use std::io::BufRead;

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let session_id = path.file_stem()?.to_string_lossy().to_string();

    let mut match_count: u64 = 0;
    let mut first_snippet = String::new();
    let mut first_role = String::new();
    let mut snippets_collected: usize = 0;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        // Quick rejection: skip lines where the query doesn't appear at all
        let line_lower = line.to_lowercase();
        if !line_lower.contains(query_lower) {
            continue;
        }

        // Skip lines that aren't user or assistant messages (raw string check before JSON parse)
        if !line.contains("\"type\":\"user\"")
            && !line.contains("\"type\":\"human\"")
            && !line.contains("\"type\":\"assistant\"")
            && !line.contains("\"type\": \"user\"")
            && !line.contains("\"type\": \"human\"")
            && !line.contains("\"type\": \"assistant\"")
            && !line.contains("\"role\":\"user\"")
            && !line.contains("\"role\":\"assistant\"")
            && !line.contains("\"role\": \"user\"")
            && !line.contains("\"role\": \"assistant\"")
        {
            continue;
        }

        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Determine role
        let role = if obj["type"].as_str() == Some("human")
            || obj["type"].as_str() == Some("user")
            || obj["message"]["role"].as_str() == Some("user")
        {
            "user"
        } else if obj["type"].as_str() == Some("assistant")
            || obj["message"]["role"].as_str() == Some("assistant")
        {
            "assistant"
        } else {
            continue;
        };

        // Skip meta and sidechain messages
        if obj["isMeta"].as_bool() == Some(true) || obj["isSidechain"].as_bool() == Some(true) {
            continue;
        }

        // Extract text from content blocks
        let content_arr = obj["content"]
            .as_array()
            .or_else(|| obj["message"]["content"].as_array());

        let mut text_parts: Vec<String> = Vec::new();
        if let Some(blocks) = content_arr {
            for block in blocks {
                let block_type = block["type"].as_str().unwrap_or("");
                if block_type == "tool_result"
                    || block_type == "tool_use"
                    || block_type == "thinking"
                    || block_type == "image"
                {
                    continue;
                }
                if block_type == "text" {
                    if let Some(text) = block["text"].as_str() {
                        text_parts.push(text.to_string());
                    }
                }
            }
        }

        let full_text = text_parts.join(" ");
        let full_text_lower = full_text.to_lowercase();

        if !full_text_lower.contains(query_lower) {
            continue;
        }

        match_count += 1;

        if snippets_collected < 3 {
            // Extract snippet using char indices for Unicode safety
            let chars: Vec<char> = full_text_lower.chars().collect();
            if let Some(char_pos) = chars
                .windows(query_lower.chars().count())
                .position(|w| w.iter().collect::<String>() == query_lower)
            {
                let original_chars: Vec<char> = full_text.chars().collect();
                let total_chars = original_chars.len();
                let start = if char_pos > 75 { char_pos - 75 } else { 0 };
                let end = std::cmp::min(total_chars, char_pos + query_lower.chars().count() + 75);

                let mut snippet: String = original_chars[start..end].iter().collect();
                if start > 0 {
                    snippet = format!("...{}", snippet);
                }
                if end < total_chars {
                    snippet = format!("{}...", snippet);
                }

                if snippets_collected == 0 {
                    first_snippet = snippet;
                    first_role = role.to_string();
                }
                snippets_collected += 1;
            }
        }
    }

    if match_count > 0 {
        Some(serde_json::json!({
            "session_id": session_id,
            "snippet": first_snippet,
            "match_count": match_count,
            "match_role": first_role,
        }))
    } else {
        None
    }
}

/// Extract preview (first user message) and cwd from a session .jsonl file.
/// Returns (preview, cwd) — cwd may be empty if not found.
fn extract_session_info(path: &std::path::Path) -> (String, String) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), String::new()),
    };
    let reader = std::io::BufReader::new(file);
    let mut cwd = String::new();
    let mut preview = String::new();

    // Scan up to 100 lines to find cwd and the first real user message.
    for line in reader.lines().take(100) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let json = match serde_json::from_str::<Value>(&line) {
            Ok(j) => j,
            Err(_) => continue,
        };

        // Extract cwd from the first line that has it
        if cwd.is_empty() {
            if let Some(c) = json["cwd"].as_str() {
                if !c.is_empty() {
                    cwd = c.to_string();
                }
            }
        }

        // Extract preview from first user message
        if preview.is_empty() {
            let is_user = json["type"].as_str() == Some("human")
                || json["type"].as_str() == Some("user")
                || json["role"].as_str() == Some("user")
                || json["message"]["role"].as_str() == Some("user");

            if !is_user {
                continue;
            }
            // isMeta 消息是 CLI 注入的内部提示（比如本地命令的 caveat 包装），
            // 不是用户真正输入的内容，跳过避免把这段提示文字当预览显示出来
            if json["isMeta"].as_bool() == Some(true) {
                continue;
            }

            // Try to extract text from message.content array
            if let Some(content) = json["message"]["content"].as_array() {
                // First pass: look for direct text blocks
                for block in content {
                    if let Some(text) = block["text"].as_str() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            preview = trimmed.chars().take(120).collect();
                            break;
                        }
                    }
                }
                // Second pass: look for text inside nested content
                if preview.is_empty() {
                    for block in content {
                        if let Some(inner) = block["content"].as_array() {
                            for inner_block in inner {
                                if let Some(text) = inner_block["text"].as_str() {
                                    let trimmed = text.trim();
                                    if !trimmed.is_empty() {
                                        preview = trimmed.chars().take(120).collect();
                                        break;
                                    }
                                }
                            }
                            if !preview.is_empty() {
                                break;
                            }
                        }
                        if let Some(text) = block["content"].as_str() {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                preview = trimmed.chars().take(120).collect();
                                break;
                            }
                        }
                    }
                }
            }
            // Try direct content string
            if preview.is_empty() {
                if let Some(text) = json["message"]["content"].as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = trimmed.chars().take(120).collect();
                    }
                }
            }
        }

        // Stop early if we have both
        if !cwd.is_empty() && !preview.is_empty() {
            break;
        }
    }
    (preview, cwd)
}

/// Decode project directory name back to readable path.
///
/// Claude CLI encodes paths by replacing `/` with `-`, e.g.:
///   /Users/tinyzhuang/Desktop/ppt-maker → -Users-tinyzhuang-Desktop-ppt-maker
///
/// Simple `.replace('-', '/')` fails when directory names contain hyphens
/// (e.g. "ppt-maker" becomes "ppt/maker").
///
/// Claude CLI encodes project paths by replacing `/`, `.`, and ` ` (space)
/// with `-`. This is lossy: "a-b" could mean "a/b", "a.b", "a b", or literal
/// "a-b". We resolve ambiguity via greedy filesystem probing.
///
/// Strategy: greedily match real filesystem segments from left to right.
/// At each position, try the longest possible segment first.  For each
/// candidate span of dash-separated parts, try joining them with the
/// original `-`, then ` ` (space), then `.` — whichever produces a path
/// that actually exists on disk wins.
/// CLI 把工作目录编码成 projects 下的目录名：每个不是 ASCII 字母数字的字符（含中文）都换成 '-'。
fn encode_project_dir(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 决定一个会话所属项目的真实路径。
/// 会话文件里记录的 cwd 可能已过时：项目从 E:\GaussDB 搬到 F:\AI\mywork\GaussDB 后，
/// 会话文件被放进了新位置对应的目录，但里面记录的仍是旧 cwd。而 CLI 是按“当前目录编码成的目录名”
/// 去找会话文件的，所以：
/// 1. cwd 编码后正好等于所在目录名，说明 cwd 就是它，直接用；
/// 2. 否则用目录名还原出的路径（按磁盘实际存在的目录探测），存在就用它；
/// 3. 都不行才退回记录的 cwd（没有 cwd 则用还原结果），此时提示“目录缺失”是准确的。
fn resolve_project_path(cwd: &str, project_dir: &str) -> String {
    if !cwd.is_empty() && encode_project_dir(cwd) == project_dir {
        return cwd.to_string();
    }
    let mut decoded = decode_project_name(project_dir);
    // 还原出的 Windows 路径可能在盘符后多一个反斜杠（F:\AI），会让项目键和 CLI 编码出的目录名都对不上
    if !decoded.starts_with("\\\\") {
        while decoded.contains("\\\\") {
            decoded = decoded.replace("\\\\", "\\");
        }
    }
    if std::path::Path::new(&decoded).exists() {
        return decoded;
    }
    if cwd.is_empty() {
        decoded
    } else {
        cwd.to_string()
    }
}

fn decode_project_name(encoded: &str) -> String {
    // Detect Windows-style encoded paths: "C-Users-..." (drive letter prefix without leading dash)
    // vs Unix-style: "-Users-..." (leading dash = root /)
    let is_windows_path = encoded.len() >= 2
        && encoded.as_bytes()[0].is_ascii_alphabetic()
        && encoded.as_bytes()[1] == b'-';

    let (trimmed, root, sep) = if is_windows_path {
        // Windows: "C-Users-foo" → root = "C:\", rest = "Users-foo"
        let drive = &encoded[0..1];
        let rest = &encoded[2..]; // skip "C-"
        (rest, format!("{}:\\", drive), "\\")
    } else {
        // Unix: "-Users-foo" → root = "/", rest = "Users-foo"
        let rest = encoded.strip_prefix('-').unwrap_or(encoded);
        (rest, "/".to_string(), "/")
    };

    let parts: Vec<&str> = trimmed.split('-').collect();

    if parts.is_empty() {
        return encoded.to_string();
    }

    let mut decoded_segments: Vec<String> = Vec::new();
    let mut i = 0;

    while i < parts.len() {
        let mut best_len = 1;
        let mut best_segment = parts[i].to_string();

        // Build the parent path for existence checking
        let parent = if decoded_segments.is_empty() {
            root.clone()
        } else {
            format!("{}{}", root, decoded_segments.join(sep))
        };

        // Try combining parts[i..j], longest first.
        // For each candidate length, try multiple join separators.
        let max_j = parts.len().min(i + 10); // limit lookahead
        let mut found = false;
        'outer: for j in (i + 1..=max_j).rev() {
            let slice = &parts[i..j];
            // Separators to try: hyphen (original name), space, dot
            for join_sep in ["-", " ", "."] {
                let candidate = slice.join(join_sep);
                let full_path = format!(
                    "{}{}{}",
                    parent,
                    if parent.ends_with(sep) { "" } else { sep },
                    candidate
                );
                if std::path::Path::new(&full_path).exists() {
                    best_len = j - i;
                    best_segment = candidate;
                    found = true;
                    break 'outer;
                }
            }
        }

        // Handle empty parts from consecutive dashes (e.g. "/." encoded as "--").
        // If we're at an empty part and no filesystem match was found, try
        // prepending a "." to the next segment (hidden dirs like .claude).
        if !found && parts[i].is_empty() {
            // Collect consecutive empty parts (each represents one encoded char)
            let start = i;
            while i < parts.len() && parts[i].is_empty() {
                i += 1;
            }
            let dot_count = i - start; // number of dots/special chars

            if i < parts.len() {
                // Try interpreting as dot-prefixed segment:
                // e.g. empty + "claude-worktrees" → ".claude-worktrees"
                let prefix = ".".repeat(dot_count);
                // Greedy match on the remaining parts after the dots
                let remaining_max = parts.len().min(i + 10);
                let mut dot_found = false;
                for j in (i + 1..=remaining_max).rev() {
                    for join_sep in ["-", " ", "."] {
                        let after = parts[i..j].join(join_sep);
                        let candidate = format!("{}{}", prefix, after);
                        let full_path = format!(
                            "{}{}{}",
                            parent,
                            if parent.ends_with(sep) { "" } else { sep },
                            candidate
                        );
                        if std::path::Path::new(&full_path).exists() {
                            decoded_segments.push(candidate);
                            i = j;
                            dot_found = true;
                            break;
                        }
                    }
                    if dot_found {
                        break;
                    }
                }
                if !dot_found {
                    // Fallback: just use dot + next part as segment
                    let candidate = format!("{}{}", prefix, parts[i]);
                    decoded_segments.push(candidate);
                    i += 1;
                }
            } else {
                // Trailing empty parts — append dots to last segment or ignore
                if let Some(prev) = decoded_segments.last_mut() {
                    prev.push_str(&".".repeat(dot_count));
                }
            }
            continue;
        }

        decoded_segments.push(best_segment);
        i += best_len;
    }

    format!("{}{}", root, decoded_segments.join(sep))
}

#[tauri::command]
async fn load_session(path: String) -> Result<Vec<Value>, String> {
    use std::io::BufRead;
    // 远程会话（ssh:// URI）经 ssh 读取
    if path.starts_with(commands::remote::REMOTE_SCHEME) {
        return commands::remote::load_remote_session(&path).await;
    }
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(json);
            }
        }
    }
    Ok(messages)
}

/// Compute billing totals and the latest occupied-context snapshot from a
/// persisted Claude session JSONL file. Assistant records may be repeated once
/// per content block, so totals are de-duplicated by message id.
fn compute_session_tokens<R: std::io::BufRead>(reader: R) -> Value {
    let mut seen_message_ids = std::collections::HashSet::new();
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut context_input_tokens: u64 = 0;
    let mut context_output_tokens: u64 = 0;
    // 最后一次真实 API 调用的模型，前端据此判断上下文窗口（200K / 1M）
    let mut model = String::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(json) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if json["type"].as_str() != Some("assistant") {
            continue;
        }
        let message = &json["message"];
        let usage = &message["usage"];
        if !usage.is_object() {
            continue;
        }

        let input = usage["input_tokens"].as_u64().unwrap_or(0);
        let output = usage["output_tokens"].as_u64().unwrap_or(0);
        let cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        let direct_cache_creation = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        let cache_creation = if direct_cache_creation > 0 {
            direct_cache_creation
        } else {
            usage["cache_creation"]["ephemeral_1h_input_tokens"].as_u64().unwrap_or(0)
                + usage["cache_creation"]["ephemeral_5m_input_tokens"].as_u64().unwrap_or(0)
        };

        // The latest assistant API call is the authoritative context snapshot.
        context_input_tokens = input + cache_read + cache_creation;
        context_output_tokens = output;
        // CLI 自己合成的消息（如报错提示）模型名为 "<synthetic>"，不算真实模型
        if let Some(m) = message["model"].as_str() {
            if !m.is_empty() && m != "<synthetic>" {
                model = m.to_string();
            }
        }

        let message_id = message["id"].as_str().unwrap_or_default();
        if !message_id.is_empty() && seen_message_ids.insert(message_id.to_string()) {
            total_input_tokens += input;
            total_output_tokens += output;
        }
    }

    serde_json::json!({
        "totalInputTokens": total_input_tokens,
        "totalOutputTokens": total_output_tokens,
        "contextInputTokens": context_input_tokens,
        "contextOutputTokens": context_output_tokens,
        "model": model,
    })
}

#[tauri::command]
async fn get_session_tokens(session_id: String) -> Result<Value, String> {
    // Find the JSONL file: <CLI 配置目录>/projects/<any-project>/<session_id>.jsonl
    let projects_dir = claude_projects_dir()?;
    let mut jsonl_path = None;

    if projects_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let candidate = entry.path().join(format!("{}.jsonl", &session_id));
                if candidate.exists() {
                    jsonl_path = Some(candidate);
                    break;
                }
            }
        }
    }

    let path = jsonl_path.ok_or_else(|| format!("Session JSONL not found for: {}", session_id))?;

    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open session JSONL: {}", e))?;
    Ok(compute_session_tokens(std::io::BufReader::new(file)))
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    let mut cmd = Command::new("code");
    cmd.arg(&path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Use 'open -R' to reveal (select) the file in Finder
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        cmd.args(["/select,", &path]);
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_folder_in_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, fallback to cmd
        let wt_result = Command::new("wt")
            .args(["-d", &path])
            .creation_flags(0x08000000)
            .spawn();
        if wt_result.is_err() {
            Command::new("cmd")
                .args(["/K", "cd", "/d", &path])
                .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let cd_cmd = format!("cd '{}' && $SHELL", path.replace('\'', "'\\''"));
        let terminals: &[(&str, &[&str])] = &[
            ("gnome-terminal", &["--", "bash", "-c", cd_cmd.as_str()] as &[&str]),
            ("konsole", &["-e", "bash", "-c", cd_cmd.as_str()]),
            ("xterm", &["-e", cd_cmd.as_str()]),
        ];
        let mut opened = false;
        for (term, args) in terminals {
            if std::process::Command::new(term)
                .args(args.iter().copied())
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn open_folder_in_terminal_admin(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell to start Windows Terminal elevated
        let ps_script = format!(
            "Start-Process wt -Verb RunAs -ArgumentList '-d', '{}'",
            path.replace('\'', "''")
        );
        std::process::Command::new("powershell")
            .args(["-Command", &ps_script])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open elevated terminal: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Administrator terminal is only supported on Windows".to_string())
    }
}

/// Helper: create an NSURL from a file path string (macOS only).
/// Returns a raw pointer to the NSURL object, or null on failure.
#[cfg(target_os = "macos")]
unsafe fn create_nsurl_from_path(path: &str) -> *mut objc::runtime::Object {
    use objc::msg_send;
    use objc::runtime::{Class, Object};
    use objc::sel;
    use objc::sel_impl;

    let nsstring_class = Class::get("NSString").unwrap();
    let path_nsstring: *mut Object = msg_send![nsstring_class, alloc];
    let path_nsstring: *mut Object = msg_send![path_nsstring,
        initWithBytes: path.as_ptr() as *const std::ffi::c_void
        length: path.len()
        encoding: 4u64  // NSUTF8StringEncoding
    ];
    if path_nsstring.is_null() {
        return std::ptr::null_mut();
    }

    let nsurl_class = Class::get("NSURL").unwrap();
    let file_url: *mut Object = msg_send![nsurl_class,
        fileURLWithPath: path_nsstring
        isDirectory: false
    ];
    file_url
}

/// Show the macOS native share sheet for a file at the current mouse position.
#[tauri::command]
async fn share_file(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path);
                    if file_url.is_null() {
                        return;
                    }

                    // Create NSArray with the URL
                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    // Create NSSharingServicePicker
                    let picker_class = Class::get("NSSharingServicePicker").unwrap();
                    let picker: *mut Object = msg_send![picker_class, alloc];
                    let picker: *mut Object = msg_send![picker, initWithItems: items];
                    if picker.is_null() {
                        return;
                    }

                    // Get key window's content view
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let key_window: *mut Object = msg_send![nsapp, keyWindow];
                    if key_window.is_null() {
                        return;
                    }

                    let content_view: *mut Object = msg_send![key_window, contentView];
                    if content_view.is_null() {
                        return;
                    }

                    // Get mouse position and convert to view coordinates
                    let nsevent_class = Class::get("NSEvent").unwrap();
                    let mouse_screen: cocoa::foundation::NSPoint =
                        msg_send![nsevent_class, mouseLocation];
                    let mouse_window: cocoa::foundation::NSPoint = msg_send![key_window,
                        convertPointFromScreen: mouse_screen
                    ];
                    let mouse_view: cocoa::foundation::NSPoint = msg_send![content_view,
                        convertPoint: mouse_window fromView: std::ptr::null::<Object>()
                    ];

                    let anchor_rect = cocoa::foundation::NSRect::new(
                        mouse_view,
                        cocoa::foundation::NSSize::new(1.0, 1.0),
                    );

                    let _: () = msg_send![picker,
                        showRelativeToRect: anchor_rect
                        ofView: content_view
                        preferredEdge: 1u64  // NSRectEdge.minY (bottom)
                    ];
                }
            });
        })
        .map_err(|e| format!("Failed to share: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = path;
    }

    Ok(())
}

/// Directly invoke WeChat's sharing service for a file (macOS only).
#[tauri::command]
async fn share_to_wechat(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path);
                    if file_url.is_null() {
                        return;
                    }

                    // Create NSArray with the URL
                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    // Get all sharing services for this file
                    let service_class = Class::get("NSSharingService").unwrap();
                    let services: *mut Object = msg_send![service_class,
                        sharingServicesForItems: items
                    ];

                    let count: usize = msg_send![services, count];

                    // Find WeChat's sharing service by title
                    for i in 0..count {
                        let service: *mut Object = msg_send![services, objectAtIndex: i];
                        let title: *mut Object = msg_send![service, title];
                        let utf8: *const std::ffi::c_char = msg_send![title, UTF8String];
                        if utf8.is_null() {
                            continue;
                        }
                        let title_str = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                        if title_str.contains("WeChat") || title_str.contains("微信") {
                            let _: () = msg_send![service, performWithItems: items];
                            return;
                        }
                    }

                    // WeChat service not found — log for debugging
                    eprintln!(
                        "[share_to_wechat] WeChat sharing service not found. Available services:"
                    );
                    for i in 0..count {
                        let service: *mut Object = msg_send![services, objectAtIndex: i];
                        let title: *mut Object = msg_send![service, title];
                        let utf8: *const std::ffi::c_char = msg_send![title, UTF8String];
                        if !utf8.is_null() {
                            let t = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                            eprintln!("  - {}", t);
                        }
                    }
                }
            });
        })
        .map_err(|e| format!("Failed to share to WeChat: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = path;
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
}

#[tauri::command]
async fn read_file_tree(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let max_depth = depth.unwrap_or(5);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err("Directory does not exist".to_string());
    }
    Ok(read_dir_recursive(root, 0, max_depth))
}

fn read_dir_recursive(dir: &std::path::Path, current_depth: u32, max_depth: u32) -> Vec<FileNode> {
    let mut nodes = vec![];
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };

    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by(|a, b| {
        let a_dir = a.path().is_dir();
        let b_dir = b.path().is_dir();
        b_dir.cmp(&a_dir).then_with(|| {
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase())
        })
    });

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip specific ignored dirs (but show dotfiles like .claude, .github, .vscode)
        if name == "node_modules"
            || name == "target"
            || name == "__pycache__"
            || name == ".git"
            || name == ".DS_Store"
            || name == "Thumbs.db"
            || name == ".venv"
            || name == "venv"
            || name == ".env"
            || name == "dist"
            || name == "build"
            || name == ".next"
            || name == ".nuxt"
            || name == ".parcel-cache"
            || name == "coverage"
            || name == ".turbo"
            || name == ".svelte-kit"
        {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();
        let children = if is_dir && current_depth < max_depth {
            Some(read_dir_recursive(&path, current_depth + 1, max_depth))
        } else if is_dir {
            Some(vec![]) // Placeholder for unexpanded dirs
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }
    nodes
}

/// Reject obviously malicious paths: empty, containing a NUL byte, or using
/// `..` traversal. The app only operates inside the user-selected project dir,
/// so legitimate calls never need `..`. (Full path allowlisting requires the
/// active project root to be plumbed into Rust — tracked as a follow-up.)
fn reject_unsafe_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err("路径包含非法字符 (NUL)".to_string());
    }
    for part in std::path::Path::new(path).components() {
        if let std::path::Component::ParentDir = part {
            return Err("路径包含越权访问 (..)".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn read_file_content(path: String) -> Result<String, String> {
    // 远程会话里点开的文件：经 ssh 从远端读取
    if path.starts_with(commands::remote::REMOTE_SCHEME) {
        let bytes = commands::remote::read_remote_file(&path, 1_048_576).await?;
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    reject_unsafe_path(&path)?;
    // Limit to 1MB to prevent loading huge files
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot read file: {}", e))?;
    if metadata.len() > 1_048_576 {
        return Err("File too large (>1MB)".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {}", e))
}

/// Check if the app has file system access to a given directory.
/// Returns Ok(true) if readable, Ok(false) if not, Err on other failures.
/// Used at startup to detect macOS TCC restrictions.
#[tauri::command]
async fn check_file_access(path: String) -> Result<bool, String> {
    match std::fs::read_dir(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(format!("Cannot check path: {}", e)),
    }
}

/// Read a binary file and return it as a base64-encoded data URL.
/// Used for previewing images, PDFs, and other binary files in the webview.
/// Limit: 50MB to prevent memory issues.
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    reject_unsafe_path(&path)?;
    use base64::Engine as _;

    let bytes = if path.starts_with(commands::remote::REMOTE_SCHEME) {
        // 远程会话里点开的图片 / PDF 等：经 ssh 从远端读取
        commands::remote::read_remote_file(&path, 50_000_000).await?
    } else {
        let metadata = std::fs::metadata(&path).map_err(|e| format!("Cannot read file: {}", e))?;
        if metadata.len() > 50_000_000 {
            return Err("File too large (>50MB)".to_string());
        }
        std::fs::read(&path).map_err(|e| format!("Cannot read file: {}", e))?
    };

    // Guess MIME type from extension
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
async fn write_file_content(path: String, content: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
async fn copy_file(src: String, dest: String) -> Result<(), String> {
    reject_unsafe_path(&src)?;
    reject_unsafe_path(&dest)?;
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| format!("Cannot copy file: {}", e))
}

#[tauri::command]
async fn rename_file(src: String, dest: String) -> Result<(), String> {
    reject_unsafe_path(&src)?;
    reject_unsafe_path(&dest)?;
    std::fs::rename(&src, &dest).map_err(|e| format!("Cannot rename file: {}", e))
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    // Move to system trash/recycle bin (recoverable) instead of permanent delete
    trash::delete(&path).map_err(|e| format!("Cannot move to trash: {}", e))
}

#[tauri::command]
async fn create_directory(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot create directory: {}", e))
}

#[tauri::command]
async fn export_session_markdown(path: String, output_path: String, conversation_only: bool) -> Result<(), String> {
    use std::io::{BufRead, Write};
    // 远程会话（ssh:// URI）经 ssh 读取，和 load_session 保持一致
    let records: Vec<Value> = if path.starts_with(commands::remote::REMOTE_SCHEME) {
        commands::remote::load_remote_session(&path).await?
    } else {
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
        std::io::BufReader::new(file)
            .lines()
            .filter_map(|l| l.ok())
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .collect()
    };

    let mut md = String::from("# Claude Code Session\n\n");
    md.push_str(&format!("*Exported from: {}*\n\n---\n\n", path));

    for json in &records {
        let msg_type = json["type"].as_str().unwrap_or("");
        match msg_type {
            "user" | "human" => {
                let mut text_buf = String::new();
                let content = &json["message"]["content"];
                if let Some(text) = content.as_str() {
                    text_buf.push_str(text);
                    text_buf.push_str("\n\n");
                } else if let Some(arr) = content.as_array() {
                    for block in arr {
                        if let Some(text) = block["text"].as_str() {
                            text_buf.push_str(text);
                            text_buf.push_str("\n\n");
                        }
                    }
                }
                if !conversation_only || !text_buf.trim().is_empty() {
                    md.push_str("## User\n\n");
                    md.push_str(&text_buf);
                }
            }
            "assistant" => {
                let mut has_text = false;
                let mut text_buf = String::new();
                if let Some(content) = json["message"]["content"].as_array() {
                    for block in content {
                        if block["type"].as_str() == Some("text") {
                            if let Some(text) = block["text"].as_str() {
                                has_text = true;
                                text_buf.push_str(text);
                                text_buf.push_str("\n\n");
                            }
                        } else if !conversation_only && block["type"].as_str() == Some("tool_use") {
                            let name = block["name"].as_str().unwrap_or("Tool");
                            text_buf.push_str(&format!("**Tool: {}**\n\n", name));
                            if let Some(input) = block.get("input") {
                                text_buf.push_str("```json\n");
                                text_buf.push_str(
                                    &serde_json::to_string_pretty(input)
                                        .unwrap_or_default(),
                                );
                                text_buf.push_str("\n```\n\n");
                            }
                        }
                    }
                }
                if !conversation_only || has_text {
                    md.push_str("## Assistant\n\n");
                    md.push_str(&text_buf);
                }
            }
            _ => {}
        }
    }

    let mut out = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    out.write_all(md.as_bytes())
        .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn export_session_json(path: String, output_path: String) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(json);
            }
        }
    }
    let json_str = serde_json::to_string_pretty(&messages)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let mut out = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    out.write_all(json_str.as_bytes())
        .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

/// List recent projects by scanning ~/.claude/projects/ directory names
#[tauri::command]
async fn list_recent_projects() -> Result<Vec<Value>, String> {
    let projects_dir = claude_projects_dir()?;

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects: HashMap<String, u64> = HashMap::new();

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                let _decoded = decode_project_name(&dir_name);
                // Get the actual path (not the shortened ~/ version)
                let actual_path = dir_name.replace('-', "/");

                // Find the most recent session file in this project
                let mut latest: u64 = 0;
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        if let Ok(meta) = file.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                                    latest = latest.max(dur.as_millis() as u64);
                                }
                            }
                        }
                    }
                }

                // Only include if the actual directory exists
                if std::path::Path::new(&actual_path).exists() {
                    projects.insert(actual_path.clone(), latest);
                }
            }
        }
    }

    let mut result: Vec<Value> = projects
        .into_iter()
        .map(|(path, ts)| {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let short_path = {
                if let Some(home) = dirs::home_dir() {
                    let home_str = home.to_string_lossy().to_string();
                    if path.starts_with(&home_str) {
                        format!("~{}", &path[home_str.len()..])
                    } else {
                        path.clone()
                    }
                } else {
                    path.clone()
                }
            };
            serde_json::json!({
                "name": name,
                "path": path,
                "shortPath": short_path,
                "lastUsed": ts,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        let ta = a["lastUsed"].as_u64().unwrap_or(0);
        let tb = b["lastUsed"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    // TK-321: Keep only the 4 most recent projects
    result.truncate(4);

    Ok(result)
}

/// Start watching a directory for file changes, emit batched events to frontend.
/// Events are collected into 200ms windows to avoid IPC storms on high-frequency dirs.
#[tauri::command]
async fn watch_directory(
    app: AppHandle,
    state: State<'_, WatcherManager>,
    path: String,
) -> Result<(), String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::sync::Mutex;
    use std::time::Duration;

    // Stop existing watcher for this path if any
    {
        let mut watchers = state.watchers.lock().await;
        watchers.remove(&path);
    }

    // Directories whose changes are noise for the UI (high-frequency writes by CLI, git, etc.)
    const IGNORED_SEGMENTS: &[&str] = &[
        ".claude",
        ".git",
        "node_modules",
        ".next",
        "target",
        "__pycache__",
        ".venv",
    ];

    // Shared buffer: events accumulate here between flush cycles.
    // std::sync::Mutex because the notify callback runs on a non-async OS thread.
    let pending: Arc<Mutex<Vec<(String, Vec<String>)>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_for_watcher = pending.clone();

    // Shutdown signal: dropping the sender → receiver fires → flush task drains and exits.
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let app_for_flush = app.clone();
    let path_for_flush = path.clone();

    // Background flush task: every 200ms, merge buffered events and emit a single IPC event
    let _flush = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    let mut buf = match pending.lock() {
                        Ok(b) => b,
                        Err(_) => break,
                    };
                    if buf.is_empty() {
                        continue;
                    }
                    let events: Vec<_> = buf.drain(..).collect();
                    drop(buf);

                    let mut seen = std::collections::HashSet::new();
                    let mut all_paths = Vec::new();
                    for (_, paths) in &events {
                        for p in paths {
                            if seen.insert(p.clone()) {
                                all_paths.push(p.clone());
                            }
                        }
                    }

                    let primary_kind = if events.iter().any(|(k, _)| k == "created" || k == "removed") {
                        if events.iter().any(|(k, _)| k == "created") { "created" } else { "removed" }
                    } else {
                        "modified"
                    };

                    let _ = app_for_flush.emit(
                        "fs:change",
                        serde_json::json!({
                            "kind": primary_kind,
                            "paths": all_paths,
                            "root": path_for_flush,
                        }),
                    );
                }
                _ = &mut shutdown_rx => {
                    // Final drain before exit
                    if let Ok(mut buf) = pending.lock() {
                        if !buf.is_empty() {
                            let events: Vec<_> = buf.drain(..).collect();
                            drop(buf);
                            let mut seen = std::collections::HashSet::new();
                            let mut all_paths = Vec::new();
                            for (_, paths) in &events {
                                for p in paths {
                                    if seen.insert(p.clone()) {
                                        all_paths.push(p.clone());
                                    }
                                }
                            }
                            let primary_kind = if events.iter().any(|(k, _)| k == "created" || k == "removed") {
                                if events.iter().any(|(k, _)| k == "created") { "created" } else { "removed" }
                            } else {
                                "modified"
                            };
                            let _ = app_for_flush.emit(
                                "fs:change",
                                serde_json::json!({
                                    "kind": primary_kind,
                                    "paths": all_paths,
                                    "root": path_for_flush,
                                }),
                            );
                        }
                    }
                    break;
                }
            }
        }
    });

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                EventKind::Create(_) => "created",
                EventKind::Modify(_) => "modified",
                EventKind::Remove(_) => "removed",
                _ => return,
            };
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| {
                    !p.components().any(|c| {
                        IGNORED_SEGMENTS
                            .iter()
                            .any(|seg| c.as_os_str() == *seg)
                    })
                })
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            if let Ok(mut buf) = pending_for_watcher.lock() {
                buf.push((kind.to_string(), paths));
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch: {}", e))?;

    let mut watchers = state.watchers.lock().await;
    watchers.insert(
        path,
        WatchHandle {
            _watcher: watcher,
            _shutdown: shutdown_tx,
        },
    );

    Ok(())
}

#[tauri::command]
async fn unwatch_directory(state: State<'_, WatcherManager>, path: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().await;
    watchers.remove(&path);
    Ok(())
}

/// Get file size in bytes for a given path
#[tauri::command]
async fn get_file_size(path: String) -> Result<u64, String> {
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    Ok(metadata.len())
}

/// Save a file to a temp directory and return its path.
/// Uses a unique suffix to avoid name collisions (e.g. multiple pasted images all named "image.png").
#[tauri::command]
async fn save_temp_file(
    name: String,
    data: Vec<u8>,
    cwd: Option<String>,
) -> Result<String, String> {
    // If a working directory is provided, save inside it so Claude CLI can access the file.
    // Falls back to system temp if cwd is not set.
    let tmp = if let Some(ref dir) = cwd {
        let p = std::path::PathBuf::from(dir)
            .join(".tokenicode")
            .join("tmp");
        if std::fs::create_dir_all(&p).is_ok() {
            // Ensure .tokenicode is gitignored in user's project
            let gitignore = std::path::PathBuf::from(dir)
                .join(".tokenicode")
                .join(".gitignore");
            if !gitignore.exists() {
                let _ = std::fs::write(&gitignore, "*\n");
            }
            p
        } else {
            std::env::temp_dir().join("tokenicode")
        }
    } else {
        std::env::temp_dir().join("tokenicode")
    };
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Split name into stem + extension, append timestamp + counter for uniqueness
    let path_buf = std::path::PathBuf::from(&name);
    let stem = path_buf
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path_buf
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let unique_name = format!("{}_{}{}{}", stem, ts, count, ext);
    let path = tmp.join(&unique_name);
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Path to the session-names metadata file (<CLI 配置目录>/tokenicode_session_names.json).
fn session_names_path() -> Result<std::path::PathBuf, String> {
    Ok(claude_config_dir()?.join("tokenicode_session_names.json"))
}

/// Load custom session display names from disk.
#[tauri::command]
async fn load_custom_previews() -> Result<Value, String> {
    let path = session_names_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session names: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse session names: {}", e))
}

/// Save custom session display names to disk.
#[tauri::command]
async fn save_custom_previews(data: Value) -> Result<(), String> {
    let path = session_names_path()?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize session names: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write session names: {}", e))
}

/// 存放 statusLine 钩子写下来的用量文件的目录（按 CLI 会话 id 分文件）。
fn statusline_dir() -> Option<std::path::PathBuf> {
    let dir = app_paths::cache_path("statusline").ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// claude CLI 的 statusLine 钩子入口（main.rs 里 `--statusline-write` 参数触发）。
/// 每次助手回复后被调用一次：从 stdin 读取完整的会话状态 JSON，把里面的
/// rate_limits（5 小时 / 7 天用量百分比，claude.ai Pro/Max 账户才有）摘出来，
/// 按 session_id 存成一个文件，供 get_session_rate_limits 读取。
///
/// 不启动 Tauri、不做任何耗时操作——这条调用会临时挡住 claude 处理下一条消息，
/// 必须尽快退出；任何解析失败都直接放弃，不影响 claude 本身的运行。
pub fn statusline_write_hook() {
    use std::io::Read;
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Ok(data) = serde_json::from_str::<Value>(&input) else { return };
    let Some(session_id) = data.get("session_id").and_then(|v| v.as_str()) else { return };
    // 防御性校验：CLI 给的应该总是 UUID，但既然要拼文件名就不信任它
    if session_id.is_empty()
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return;
    }
    let Some(rate_limits) = data.get("rate_limits") else { return };
    let Some(dir) = statusline_dir() else { return };
    let path = dir.join(format!("{}.json", session_id));

    // 5h/7d 是不是每次都一起出现，CLI 那边不保证（官方文档写了：每个窗口可能各自
    // 缺失）。合并写入而不是整个覆盖：这次只带了其中一个窗口的数据时，保留上次
    // 已知的另一个窗口，除非它自己的 resets_at 已经过了——那种情况本来就该被认为
    // 过期丢弃（模拟 CLI 自己 "drops a window once resets_at passes" 的语义），
    // 不是我们这边弄丢的。不然会出现"这次显示 5h、下次显示 7d，来回跳"的现象。
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(merged_obj) = merged.as_object_mut() {
        merged_obj.retain(|_, v| {
            v.get("resets_at").and_then(|r| r.as_u64()).map(|r| r > now_secs).unwrap_or(true)
        });
        if let Some(new_obj) = rate_limits.as_object() {
            for (k, v) in new_obj {
                merged_obj.insert(k.clone(), v.clone());
            }
        }
    }
    let _ = std::fs::write(&path, merged.to_string());
}

/// 读取某个 CLI 会话最近一次 statusLine 钩子写下的 5 小时 / 7 天用量数据。
/// 没有（还没收到过、账户不是 Pro/Max、或者钩子没起作用）就返回 null，
/// 前端据此决定要不要显示这块状态条——不在这里编造数据。
#[tauri::command]
async fn get_session_rate_limits(session_id: String) -> Option<Value> {
    let dir = statusline_dir()?;
    if session_id.is_empty()
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    let content = std::fs::read_to_string(dir.join(format!("{}.json", session_id))).ok()?;
    serde_json::from_str::<Value>(&content).ok()
}

/// Load pinned session IDs from disk.
#[tauri::command]
async fn load_pinned_sessions() -> Result<Value, String> {
    let path = app_paths::config_path("pinned.json")?;
    // 文件不存在时返回 null（区别于“存在但为空”），前端据此决定是否保留本地缓存
    if !path.exists() {
        return Ok(Value::Null);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read pinned sessions: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse pinned sessions: {}", e))
}

/// Save pinned session IDs to disk.
#[tauri::command]
async fn save_pinned_sessions(data: Value) -> Result<(), String> {
    let path = app_paths::config_path("pinned.json")?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize pinned sessions: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write pinned sessions: {}", e))
}

/// Load archived session IDs from disk.
#[tauri::command]
async fn load_archived_sessions() -> Result<Value, String> {
    let path = app_paths::config_path("archived.json")?;
    // 文件不存在时返回 null（区别于“存在但为空”），前端据此决定是否保留本地缓存
    if !path.exists() {
        return Ok(Value::Null);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read archived sessions: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse archived sessions: {}", e))
}

/// Save archived session IDs to disk.
#[tauri::command]
async fn save_archived_sessions(data: Value) -> Result<(), String> {
    let path = app_paths::config_path("archived.json")?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize archived sessions: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write archived sessions: {}", e))
}

fn normalize_deepseek_model_name(model: &str) -> String {
    let trimmed = model.trim();
    let lower = trimmed.to_lowercase();
    let compact: String = lower
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '.' | '(' | ')' | '[' | ']' | '-'))
        .collect();

    if compact.contains("deepseekv4pro") {
        return "deepseek-v4-pro".to_string();
    }
    if compact.contains("deepseekv4flash") {
        return "deepseek-v4-flash".to_string();
    }
    if lower.contains("fable") || lower.contains("opus") || compact.contains("claudeopus") {
        return "deepseek-v4-pro".to_string();
    }
    if lower.contains("sonnet") || lower.contains("haiku") || compact.contains("claudesonnet") || compact.contains("claudehaiku") {
        return "deepseek-v4-flash".to_string();
    }

    trimmed.to_string()
}

/// Generate a short AI title for a session by spawning a separate Claude CLI process.
/// Uses deepseek-v4-flash for fast title generation. Completely isolated from the
/// main conversation channel — spawns a new process that exits after one response.
#[tauri::command]
async fn generate_session_title(
    user_message: String,
    assistant_message: String,
    provider_id: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    // Safe UTF-8 truncation (don't slice mid-character)
    fn safe_truncate(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            return s;
        }
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    let user_msg = safe_truncate(&user_message, 500);
    let asst_msg = safe_truncate(&assistant_message, 500);

    let prompt = format!(
        "Generate a very short title (5-10 words, in the same language as the conversation) for this conversation. Reply with ONLY the title text, no quotes, no extra text, no explanation.\n\nUser: {}\n\nAssistant: {}",
        user_msg, asst_msg
    );

    // Resolve model and env vars for provider
    let (provider_env, provider_keys_to_remove, model_name) = if let Some(ref pid) = provider_id {
        let (env, keys, _args) = resolve_provider_env(Some(pid))?;
        // Find haiku tier mapping from provider
        let providers_file = load_providers()?;
        let provider = providers_file.providers.iter().find(|p| p.id == *pid);
        let haiku_model = provider.and_then(|p| {
            p.model_mappings
                .iter()
                .find(|m| m.tier == "haiku" && !m.provider_model.is_empty())
                .map(|m| m.provider_model.clone())
        });
        match haiku_model {
            Some(m) => (env, keys, normalize_deepseek_model_name(&m)),
            None => return Err("SKIP: no haiku mapping for provider".to_string()),
        }
    } else {
        // 没配置 provider 时走的是真实的 Anthropic 直连账号，deepseek-v4-flash 这个
        // 模型名对这类账号根本不存在，用真实存在的 Haiku 模型兜底
        (
            HashMap::new(),
            vec![],
            "claude-haiku-4-5-20251001".to_string(),
        )
    };

    // Resolve claude binary
    let claude_bin = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;

    let enriched_path = build_enriched_path();

    // Spawn a one-shot CLI process: -p for single prompt, --output-format json for structured output.
    // --no-session-persistence：这只是问一句要标题，不该在磁盘上留下一个真实会话——
    // 不加这个的话，就算 cwd 指对了项目，claude CLI 还是会把这次一次性调用当成
    // 一次完整会话记下来，项目会话列表里就会莫名多出一条内容是这段 prompt 拼接文本
    // 的"对话"。
    let args = vec![
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model_name,
        "--output-format".to_string(),
        "json".to_string(),
        "--max-turns".to_string(),
        "1".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--no-session-persistence".to_string(),
    ];

    let mut cmd = tokio::process::Command::new(&claude_bin);
    cmd.args(&args)
        .env("PATH", &enriched_path)
        .env_remove("CLAUDECODE") // Allow nested CLI launch
        .env_remove("CLAUDE_CODE_ENTRY") // Remove any other nesting guards
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 之前没设置 cwd 时，子进程会继承 ClaudeDeck 自己的进程工作目录（打包后经常是
    // release 目录），导致 claude CLI 把这次一次性标题生成调用记成了一个新项目
    // （比如侧边栏莫名多出一个叫 "release" 的项目）。改成用真实会话所在的项目目录，
    // 目录不存在时退回用户主目录，绝不能再落到 ClaudeDeck 自己的安装目录下。
    let title_gen_cwd = cwd
        .filter(|p| !p.is_empty() && std::path::Path::new(p).is_dir())
        .or_else(|| dirs::home_dir().map(|p| p.display().to_string()));
    if let Some(dir) = title_gen_cwd {
        cmd.current_dir(dir);
    }

    // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
    #[cfg(target_os = "windows")]
    cmd.env("MSYS_NO_PATHCONV", "1").env("MSYS2_ARG_CONV_EXCL", "*");

    // Inject provider env vars
    for (k, v) in &provider_env {
        cmd.env(k, v);
    }
    for k in &provider_keys_to_remove {
        cmd.env_remove(k);
    }

    // Inject proxy env vars from login shell for GUI apps
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        for (k, v) in proxy_env {
            if std::env::var(k).is_err() && !provider_env.contains_key(k) {
                cmd.env(k, v);
            }
        }
    }

    // Suppress console window on Windows
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude for title gen: {}", e))?
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for title gen process: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Title gen process failed: {}",
            stderr.chars().take(200).collect::<String>()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON output — Claude CLI --output-format json returns:
    // { "type": "result", "result": "the title text", ... }
    if let Ok(json) = serde_json::from_str::<Value>(stdout.trim()) {
        let title = json
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();
        if title.is_empty() {
            return Err("Empty title generated".to_string());
        }
        return Ok(title);
    }

    // Fallback: if not valid JSON, try to use raw stdout as title
    let raw = stdout.trim().trim_matches('"').to_string();
    if raw.is_empty() || raw.len() > 200 {
        return Err("Could not parse title from CLI output".to_string());
    }
    Ok(raw)
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
            hide_session,
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
            delete_session,
            list_sessions,
            commands::usage::get_profile_stats,
            search_sessions,
            load_session,
            get_session_tokens,
            read_file_tree,
            read_file_content,
            write_file_content,
            copy_file,
            rename_file,
            delete_file,
            create_directory,
            open_in_vscode,
            reveal_in_finder,
            open_with_default_app,
            share_file,
            share_to_wechat,
            export_session_markdown,
            export_session_json,
            list_recent_projects,
            watch_directory,
            unwatch_directory,
            save_temp_file,
            get_file_size,
            check_file_access,
            read_file_base64,
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
            open_folder_in_terminal,
            open_folder_in_terminal_admin,
            load_custom_previews,
            save_custom_previews,
            load_pinned_sessions,
            save_pinned_sessions,
            load_archived_sessions,
            save_archived_sessions,
            get_session_rate_limits,
            generate_session_title,
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
