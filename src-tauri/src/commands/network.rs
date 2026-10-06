//! 网络：代理探测（登录 shell 环境变量、系统代理、本地常见端口）与按代理缓存的智能 HTTP 客户端。

// 仅 macOS/Linux 分支用到根模块的导入（如 HashMap），Windows 下编译会报未使用
#[allow(unused_imports)]
use crate::*;

/// Capture proxy-related environment variables from the user's login shell.
/// GUI apps launched from Finder/Dock don't inherit shell env vars (including
/// proxy settings), which causes API requests to fail in regions that require
/// a proxy to reach Anthropic's API.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_proxy_env() -> &'static HashMap<String, String> {
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
pub(crate) fn system_proxy_url() -> Option<String> {
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
pub(crate) fn probe_local_proxy() -> Option<String> {
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
pub(crate) fn resolve_proxy_url() -> Option<String> {
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
pub(crate) async fn is_proxy_reachable(proxy_url: &str) -> bool {
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
pub(crate) async fn build_smart_http_client(
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
