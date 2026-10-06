//! 网络：代理探测（环境变量、本地常见端口）与按代理缓存的智能 HTTP 客户端。

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
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            tokio::net::TcpStream::connect(addr),
        )
        .await,
        Ok(Ok(_))
    )
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
