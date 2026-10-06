//! Claude CLI 的检测、诊断、安装与更新，以及登录（OAuth / 终端）和认证状态检查。

use crate::*;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CliStatus {
    pub(crate) installed: bool,
    pub(crate) path: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) git_bash_missing: bool,
}

/// Run a Claude CLI subcommand (e.g. `claude doctor`) as a one-shot process
/// and return its combined stdout/stderr output.
#[tauri::command]
pub(crate) async fn run_claude_command(subcommand: String, cwd: Option<String>) -> Result<String, String> {
    // P1-1: Allowlist safe subcommands
    let allowed = ["doctor", "--version", "config", "mcp"];
    if !allowed.contains(&subcommand.as_str()) {
        return Err(format!("Claude subcommand '{}' not allowed", subcommand));
    }

    let binary = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    let enriched_path = build_enriched_path();
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg(&subcommand);
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg(&subcommand);
        c
    };
    cmd.env("PATH", &enriched_path);
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::null());
    {
        cmd.creation_flags(0x08000000);
        // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
        cmd.env("MSYS_NO_PATHCONV", "1").env("MSYS2_ARG_CONV_EXCL", "*");
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    let future = cmd.output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("claude {} timed out after 30s", subcommand))?
        .map_err(|e| format!("Failed to run claude {}: {}", subcommand, e))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Ok(combined.trim().to_string())
    } else {
        let combined = format!("{}\n{}", stdout, stderr);
        Err(combined.trim().to_string())
    }
}

/// Run a safe `claude plugin ...` command and return stdout/stderr.
///
/// Arguments are passed as process args, not through a shell string, and the
/// first plugin subcommand is allowlisted.
#[tauri::command]
pub(crate) async fn run_claude_plugin_command(args: Vec<String>, cwd: Option<String>) -> Result<String, String> {
    if args.is_empty() {
        return Err("Claude plugin command requires arguments".to_string());
    }
    let allowed = [
        "list",
        "details",
        "install",
        "i",
        "enable",
        "disable",
        "update",
        "uninstall",
        "remove",
        "prune",
        "autoremove",
        "marketplace",
    ];
    if !allowed.contains(&args[0].as_str()) {
        return Err(format!("Claude plugin subcommand '{}' not allowed", args[0]));
    }
    for arg in &args {
        if arg.len() > 512 || arg.contains('\0') || arg.contains('\r') || arg.contains('\n') {
            return Err("Invalid Claude plugin argument".to_string());
        }
    }

    let binary = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    let enriched_path = build_enriched_path();
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg("plugin");
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg("plugin");
        c
    };
    cmd.args(&args);
    cmd.env("PATH", &enriched_path);
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::null());
    {
        cmd.creation_flags(0x08000000);
        cmd.env("MSYS_NO_PATHCONV", "1").env("MSYS2_ARG_CONV_EXCL", "*");
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output())
        .await
        .map_err(|_| "claude plugin command timed out after 180s".to_string())?
        .map_err(|e| format!("Failed to run claude plugin: {}", e))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        if stdout.trim().is_empty() {
            Ok(stderr.trim().to_string())
        } else {
            Ok(stdout.trim().to_string())
        }
    } else {
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Err(combined.trim().to_string())
    }
}

/// Check whether the Claude CLI is installed and return its path and version.
#[tauri::command]
pub(crate) async fn check_claude_cli() -> Result<CliStatus, String> {
    eprintln!("[check_claude_cli] START");
    let binary = find_claude_binary();
    eprintln!("[check_claude_cli] find_claude_binary => {:?}", binary);
    match binary {
        Some(path) => {
            // Try to get the version
            let enriched_path = build_enriched_path();
            eprintln!("[check_claude_cli] running '{} --version'...", path);

            // On Windows, .cmd files need cmd /C wrapper
            let output_result = {
                let needs_cmd = path.ends_with(".cmd") || path.ends_with(".bat");
                let fut = if needs_cmd {
                    Command::new("cmd")
                        .args(["/C", &path, "--version"])
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .output()
                };
                match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!(
                            "[check_claude_cli] --version timed out for '{}', trying fallback...",
                            path
                        );
                        let fallback = find_claude_binary_ordered().into_iter().find(|p| p != &path);
                        let git_bash_missing = find_git_bash().is_none();
                        return match fallback {
                            Some(alt_path) => {
                                eprintln!("[check_claude_cli] fallback found: {}", alt_path);
                                Ok(CliStatus {
                                    installed: true,
                                    path: Some(alt_path),
                                    version: None,
                                    git_bash_missing,
                                })
                            }
                            None => Ok(CliStatus {
                                installed: false,
                                path: None,
                                version: None,
                                git_bash_missing: false,
                            }),
                        };
                    }
                }
            };

            let version = match output_result {
                Ok(output) if output.status.success() => {
                    let raw = strip_ansi(&String::from_utf8_lossy(&output.stdout))
                        .trim()
                        .to_string();
                    if raw.is_empty() {
                        None
                    } else {
                        // `claude --version` outputs "2.1.92 (Claude Code)" — extract just the semver
                        let ver = raw.split_whitespace().next().unwrap_or(&raw).to_string();
                        Some(ver)
                    }
                }
                Ok(_) => None,
                Err(ref e) => {
                    eprintln!("check_claude_cli: failed to execute '{}': {}", path, e);
                    // On Windows, error 193 means the binary is corrupt/incompatible.
                    // Delete it and try to find a working alternative.
                    {
                        if e.raw_os_error() == Some(193) {
                            eprintln!("error 193: removing corrupt binary and re-searching...");
                            if let Some(cli_dir) = cli_download_dir() {
                                let suspect = cli_dir.join("claude.exe");
                                if suspect.exists() {
                                    let _ = std::fs::remove_file(&suspect);
                                }
                            }
                            let alt = find_claude_binary();
                            let git_bash_missing = find_git_bash().is_none();
                            return match alt {
                                Some(alt_path) => Ok(CliStatus {
                                    installed: true,
                                    path: Some(alt_path),
                                    version: None,
                                    git_bash_missing,
                                }),
                                None => Ok(CliStatus {
                                    installed: false,
                                    path: None,
                                    version: None,
                                    git_bash_missing: false,
                                }),
                            };
                        }
                    }
                    // TK-319: Binary found but can't be executed → report as not installed
                    let git_bash_missing = find_git_bash().is_none();
                    return Ok(CliStatus {
                        installed: false,
                        path: Some(path),
                        version: None,
                        git_bash_missing,
                    });
                }
            };
            // On Windows, check if git-bash is available (hard requirement for Claude Code)
            let git_bash_missing = find_git_bash().is_none();

            Ok(CliStatus {
                installed: true,
                path: Some(path),
                version,
                git_bash_missing,
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
        }),
    }
}

// ─── CLI Diagnostics ───────────────────────────────────────

/// Scan all CLI installations and return candidates with version info.
#[tauri::command]
pub(crate) async fn diagnose_cli() -> Result<Vec<commands::cli_resolver::CliCandidate>, String> {
    let mut candidates = commands::cli_resolver::scan_all();
    let enriched_path = build_enriched_path();

    for candidate in &mut candidates {
        if !candidate.issues.is_empty() && candidate.version.is_none() {
            continue;
        }
        let version_result = {
            let needs_cmd = candidate.path.ends_with(".cmd") || candidate.path.ends_with(".bat");
            let fut = if needs_cmd {
                Command::new("cmd")
                    .args(["/C", &candidate.path, "--version"])
                    .env("PATH", &enriched_path)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000)
                    .output()
            } else {
                Command::new(&candidate.path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000)
                    .output()
            };
            tokio::time::timeout(std::time::Duration::from_secs(3), fut).await
        };

        match version_result {
            Ok(Ok(output)) if output.status.success() => {
                let raw = strip_ansi(&String::from_utf8_lossy(&output.stdout))
                    .trim()
                    .to_string();
                let ver = raw.split_whitespace().next().unwrap_or(&raw).to_string();
                if !ver.is_empty() {
                    candidate.version = Some(ver);
                }
            }
            Ok(Ok(_)) => {
                candidate.issues.push("--version returned non-zero exit".to_string());
            }
            Ok(Err(e)) => {
                candidate.issues.push(format!("failed to execute: {}", e));
            }
            Err(_) => {
                candidate.issues.push("--version timed out (3s)".to_string());
            }
        }
    }

    Ok(candidates)
}

/// Clean up selected CLI installations.
#[tauri::command]
pub(crate) async fn cleanup_old_cli(targets: Vec<String>) -> Result<commands::cli_resolver::CleanupResult, String> {
    Ok(commands::cli_resolver::cleanup(&targets))
}

#[tauri::command]
pub(crate) async fn pin_cli(path: String) -> Result<(), String> {
    commands::cli_resolver::pin_cli(&path)
}

#[tauri::command]
pub(crate) async fn unpin_cli() -> Result<(), String> {
    commands::cli_resolver::unpin_cli()
}

#[tauri::command]
pub(crate) async fn get_pinned_cli() -> Result<Option<String>, String> {
    Ok(commands::cli_resolver::get_pinned_cli())
}

#[tauri::command]
pub(crate) async fn inject_cli_path(path: String) -> Result<String, String> {
    commands::cli_resolver::inject_path(&path)
}

#[tauri::command]
pub(crate) async fn delete_cli(path: String) -> Result<String, String> {
    commands::cli_resolver::delete_cli(&path)
}

/// Detect whether the user is behind the GFW (China network).
/// Tries to connect to Google — if unreachable within 3 seconds, assume China network.
/// Result is cached for the lifetime of the process via OnceLock.
pub(crate) static CHINA_NETWORK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub(crate) async fn detect_china_network() -> bool {
    // Network detection must bypass proxy to test the real network path.
    // If proxy is used, Google might be reachable via proxy even in China,
    // giving a false negative.
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let is_china = client
        .head("https://www.google.com/generate_204")
        .send()
        .await
        .is_err();

    eprintln!(
        "Network detection: {}",
        if is_china {
            "China (Google unreachable)"
        } else {
            "Global (Google reachable)"
        }
    );
    is_china
}

pub(crate) async fn is_china_network() -> bool {
    if let Some(&cached) = CHINA_NETWORK.get() {
        return cached;
    }
    let result = detect_china_network().await;
    let _ = CHINA_NETWORK.set(result);
    result
}

/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Uses --prefix to install into app-local directory when using local Node.js.
pub(crate) async fn install_cli_via_npm(app: &AppHandle, china: bool) -> Result<(), String> {
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 0, "phase": "npm_fallback"
        }),
    );

    // Determine npm path: local Node.js takes priority, then system npm
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        local_bin.join("npm.cmd").to_string_lossy().to_string()
    } else {
        "npm.cmd".to_string()
    };

    // Build PATH that includes local Node.js bin
    let enriched_path = build_enriched_path();

    // Always use --prefix to install into our controlled directory.
    // This avoids polluting system npm globals and ensures finalize_cli_install_paths
    // can reliably add the bin directory to PATH (fixes PowerShell not finding `claude`).
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    // Use app-local npm cache to avoid EPERM when system cache dir is locked
    // (common on Windows with antivirus or concurrent npm processes).
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create npm-cache dir: {}", e))?;

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://mirrors.huaweicloud.com/repository/npm",
            "https://mirrors.cloud.tencent.com/npm",
            "https://registry.npmjs.org",
        ]
    } else {
        vec![
            "https://registry.npmjs.org",
            "https://registry.npmmirror.com",
        ]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!(
            "Trying npm install with registry: {} (prefix: {}, cache: {})",
            registry,
            prefix_dir.display(),
            cache_dir.display()
        );

        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 50, "phase": "npm_fallback"
            }),
        );

        // Build args — always use --prefix and --cache for isolation
        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@anthropic-ai/claude-code".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];

        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                eprintln!("npm install succeeded via {}", registry);
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "installing"
                    }),
                );
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr);
                eprintln!("{}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("npm not found or failed to run: {}", e);
                eprintln!("{}", last_err);
                return Err(last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("{}", last_err);
            }
        }
    }

    Err(last_err)
}

/// Compare two semver-style version strings (e.g. "2.1.92" > "2.1.81").
/// Handles "v" prefix, "(Claude Code)" suffix, and non-numeric noise.
pub(crate) fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        // Take only the first whitespace-delimited token ("2.1.92 (Claude Code)" → "2.1.92")
        let ver = s.trim().trim_start_matches('v').split_whitespace().next().unwrap_or("");
        ver.split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    // Only compare if both parsed to the same number of segments
    if va.len() != vb.len() && (va.is_empty() || vb.is_empty()) {
        return false;
    }
    va > vb
}

/// Return the platform key matching the server manifest (e.g. "win32-x64").
pub(crate) fn native_platform_key() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    { "win32-x64" }
    #[cfg(target_arch = "aarch64")]
    { "win32-arm64" }
}

/// Try to update the CLI by downloading a native binary from GCS.
/// Only used for non-China users (GCS is fast globally; herear.cn bandwidth is too small
/// for ~230MB binaries). China users go straight to npm fallback with version verification.
pub(crate) async fn try_native_cli_update(china: bool) -> Result<String, String> {
    // Skip native binary download for China — GCS may be blocked, herear.cn bandwidth too small
    if china {
        return Err("Native binary download skipped for China network".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let sources: Vec<&str> = vec![CLI_GCS_BASE];

    // 1. Fetch latest version
    let mut version: Option<String> = None;
    for base in &sources {
        let url = format!("{}/latest", base);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        eprintln!("[native_update] latest version: {} (from {})", v, base);
                        version = Some(v);
                        break;
                    }
                }
            }
        }
    }
    let version = version.ok_or("Cannot fetch latest version from any source")?;

    // 2. Fetch manifest for checksum
    let platform = native_platform_key();
    let mut expected_checksum = String::new();
    let mut binary_name = "claude.exe".to_string();

    for base in &sources {
        let url = format!("{}/{}/manifest.json", base, version);
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(manifest) = resp.json::<serde_json::Value>().await {
                if let Some(info) = manifest.get("platforms").and_then(|p| p.get(platform)) {
                    if let Some(cs) = info.get("checksum").and_then(|v| v.as_str()) {
                        expected_checksum = cs.to_string();
                    }
                    if let Some(bn) = info.get("binary").and_then(|v| v.as_str()) {
                        binary_name = bn.to_string();
                    }
                    break;
                }
            }
        }
    }

    // 3. Determine install path: ~/.claude/local/ (same as official install.sh)
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let install_dir = home.join(".claude").join("local");
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Cannot create ~/.claude/local/: {e}"))?;
    let dest_path = install_dir.join(&binary_name);
    let tmp_path = install_dir.join(format!("{}.tmp", binary_name));

    // 4. Download binary (stream to disk, ~200MB)
    let dl_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let mut downloaded = false;
    for base in &sources {
        let url = format!("{}/{}/{}/{}", base, version, platform, binary_name);
        eprintln!("[native_update] downloading from {}", url);

        let resp = match dl_client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                eprintln!("[native_update] HTTP {} from {}", r.status(), base);
                continue;
            }
            Err(e) => {
                eprintln!("[native_update] request failed: {} ({})", e, base);
                continue;
            }
        };

        let mut stream = resp.bytes_stream();
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Cannot create tmp file: {e}"))?;

        use std::io::Write;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Write error: {e}"))?;
        }
        drop(file);

        // 5. Verify SHA-256 checksum
        if !expected_checksum.is_empty() {
            use sha2::{Digest, Sha256};
            let data = std::fs::read(&tmp_path)
                .map_err(|e| format!("Cannot read tmp file: {e}"))?;
            let actual = format!("{:x}", Sha256::digest(&data));
            if actual != expected_checksum {
                eprintln!(
                    "[native_update] checksum mismatch: expected {}… got {}…",
                    &expected_checksum[..12.min(expected_checksum.len())],
                    &actual[..12.min(actual.len())]
                );
                let _ = std::fs::remove_file(&tmp_path);
                continue;
            }
            eprintln!("[native_update] checksum verified");
        }

        downloaded = true;
        break;
    }

    if !downloaded {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("All download sources failed".to_string());
    }

    // On Windows the running binary may be locked; try rename, then copy+delete
    if let Err(_) = std::fs::rename(&tmp_path, &dest_path) {
        std::fs::copy(&tmp_path, &dest_path)
            .map_err(|e| format!("Cannot install binary: {e}"))?;
        let _ = std::fs::remove_file(&tmp_path);
    }

    eprintln!("[native_update] installed {} -> {}", binary_name, dest_path.display());
    Ok(version)
}

/// Update the Claude CLI to the latest version.
/// Strategy:
///   Non-China: native binary from GCS → npm fallback
///   China: npm with multi-registry + version verification (npmmirror → npm official)
#[tauri::command]
pub(crate) async fn update_claude_cli(app: AppHandle) -> Result<String, String> {
    let china = is_china_network().await;

    // Phase 1: Try native binary download (non-China only, GCS CDN)
    match try_native_cli_update(china).await {
        Ok(version) => {
            eprintln!("[update_claude_cli] native binary update success: v{}", version);
            return Ok(version);
        }
        Err(e) => {
            eprintln!("[update_claude_cli] native binary skipped/failed: {}, using npm", e);
        }
    }

    // Phase 2: npm with multi-registry + version verification
    // For China: npmmirror first (fast), verify version matches target,
    // if stale → auto-retry with npm official
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        local_bin.join("npm.cmd").to_string_lossy().to_string()
    } else {
        "npm.cmd".to_string()
    };

    let enriched_path = build_enriched_path();
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm prefix dir: {e}"))?;
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).ok();

    // Fetch target version for post-install verification (herear.cn for China, GCS for others)
    let target_version = {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let urls = if china {
            vec![format!("{}/latest", CLI_MIRROR_BASE), format!("{}/latest", CLI_GCS_BASE)]
        } else {
            vec![format!("{}/latest", CLI_GCS_BASE)]
        };
        let mut ver: Option<String> = None;
        for url in &urls {
            if let Ok(resp) = c.get(url).send().await {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() { ver = Some(v); break; }
                }
            }
        }
        ver
    };

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://registry.npmjs.org",
        ]
    } else {
        vec!["https://registry.npmjs.org"]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!("[update_claude_cli] trying npm registry: {}", registry);
        let _ = app.emit("setup:download:progress", serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 30, "phase": "npm_fallback"
        }));

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@anthropic-ai/claude-code@latest".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];
        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                let check = check_claude_cli().await.unwrap_or(CliStatus {
                    installed: false, version: None,
                    path: None, git_bash_missing: false,
                });
                let version = check.version.unwrap_or_else(|| "unknown".to_string());
                eprintln!("[update_claude_cli] npm installed v{} from {}", version, registry);
                let _ = app.emit("setup:download:progress", serde_json::json!({
                    "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
                }));

                // Version verification: if target is known and installed version is stale,
                // try next registry (npmmirror may be behind)
                if let Some(ref target) = target_version {
                    if version != *target && version_gt(target, &version) {
                        eprintln!(
                            "[update_claude_cli] v{} < target v{}, trying next registry",
                            version, target
                        );
                        last_err = format!("Mirror {} has v{} but latest is v{}", registry, version, target);
                        continue;
                    }
                }

                return Ok(version);
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr.chars().take(500).collect::<String>());
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("Failed to run npm: {e}");
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[update_claude_cli] {}", last_err);
            }
        }
    }

    Err(last_err)
}

/// Check if a newer CLI version is available.
/// Sources: herear.cn mirror (China-first) → GCS → npm registry.
#[derive(serde::Serialize)]
pub(crate) struct CliUpdateCheck {
    pub(crate) current: Option<String>,
    pub(crate) latest: Option<String>,
    pub(crate) update_available: bool,
}

#[tauri::command]
pub(crate) async fn check_cli_update() -> Result<CliUpdateCheck, String> {
    let cli = check_claude_cli().await.ok();
    let current = cli.as_ref().and_then(|c| c.version.clone());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let china = is_china_network().await;

    // Version check sources: China users try herear.cn first (GCS may be slow/blocked)
    let version_urls: Vec<String> = if china {
        vec![
            format!("{}/latest", CLI_MIRROR_BASE),
            format!("{}/latest", CLI_GCS_BASE),
        ]
    } else {
        vec![
            format!("{}/latest", CLI_GCS_BASE),
            format!("{}/latest", CLI_MIRROR_BASE),
        ]
    };

    let mut latest: Option<String> = None;
    for url in &version_urls {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        latest = Some(v);
                        break;
                    }
                }
            }
        }
    }

    // Final fallback: npm registry
    if latest.is_none() {
        if let Ok(resp) = client
            .get("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
            .header("Accept", "application/json")
            .send()
            .await
        {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            latest = json.get("version").and_then(|v| v.as_str()).map(String::from);
        }
    }

    let update_available = match (&current, &latest) {
        (Some(cur), Some(lat)) => version_gt(lat.trim(), cur.trim()),
        _ => false,
    };

    Ok(CliUpdateCheck { current, latest, update_available })
}

/// Install the Claude CLI via npm with network-aware mirror selection:
/// 0. Detect network environment (China vs Global)
/// 1. (Windows) Ensure git-bash is available — auto-install PortableGit if missing
/// 2. Ensure npm is available — download Node.js locally if needed
/// 3. Install CLI via npm with region-appropriate registry mirrors
#[tauri::command]
pub(crate) async fn install_claude_cli(app: AppHandle) -> Result<(), String> {
    // Skip installation if CLI already exists on system.
    // On Windows, still continue when git-bash is missing because reinstall is the repair path.
    let existing_cli = find_claude_binary();
    let can_skip_install = existing_cli.is_some() && find_git_bash().is_some();
    if can_skip_install {
        eprintln!("CLI already found on system, skipping installation");
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
            }),
        );
        return Ok(());
    }

    // Phase 0: Detect network environment (used by all subsequent phases)
    let china = is_china_network().await;

    // Phase 1 (Windows only): Ensure git-bash is available
    {
        if find_git_bash().is_none() {
            eprintln!("git-bash not found, auto-installing PortableGit...");
            install_git_bash_inner(&app, china).await.map_err(|e| {
                format!(
                    "Failed to install Git for Windows: {}. \
                     Please install Git for Windows manually: https://git-scm.com/downloads/win",
                    e
                )
            })?;
        }

        // If CLI is already installed (only git-bash was missing), skip download phases
        if find_claude_binary().is_some() {
            eprintln!("CLI already installed, git-bash was the only missing dependency");
            finalize_cli_install_paths(&app);
            return Ok(());
        }
    }

    // Phase 2: Ensure npm is available
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();

    if !has_npm {
        eprintln!("npm not available, deploying Node.js locally...");
        install_node_env_inner(&app, china).await.map_err(|e| {
            format!(
                "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                e
            )
        })?;
    }

    // Phase 3: Install CLI via npm
    install_cli_via_npm(&app, china)
        .await
        .map_err(|npm_err| format!("CLI installation failed via npm: {}", npm_err))?;

    eprintln!("CLI installed via npm");
    finalize_cli_install_paths(&app);
    Ok(())
}

/// Post-install: add relevant directories to Windows user PATH and emit completion.
pub(crate) fn finalize_cli_install_paths(app: &AppHandle) {
    {
        // Collect all directories that should be on PATH
        let mut dirs_to_add: Vec<String> = vec![];

        if let Some(cli_dir) = cli_download_dir() {
            dirs_to_add.push(cli_dir.to_string_lossy().to_string());
        }
        if let Some(node_bin) = get_local_node_bin() {
            dirs_to_add.push(node_bin.to_string_lossy().to_string());
        }
        if let Some(npm_bin) = get_npm_global_bin() {
            dirs_to_add.push(npm_bin.to_string_lossy().to_string());
        }
        // Include local PortableGit bin and cmd directories
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                dirs_to_add.push(git_bin.to_string_lossy().to_string());
            }
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                dirs_to_add.push(git_cmd.to_string_lossy().to_string());
            }
        }

        for dir in &dirs_to_add {
            let ps_script = format!(
                "$old = [Environment]::GetEnvironmentVariable('Path','User'); \
                 if ($old -and -not $old.Contains('{}')) {{ \
                   [Environment]::SetEnvironmentVariable('Path', $old + ';{}', 'User') \
                 }} elseif (-not $old) {{ \
                   [Environment]::SetEnvironmentVariable('Path', '{}', 'User') \
                 }}",
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
            );
            let path_result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match path_result {
                Ok(output) if output.status.success() => {
                    eprintln!("Added to user PATH: {}", dir);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to add to PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for PATH: {}", e),
            }
        }

        // Set CLAUDE_CODE_GIT_BASH_PATH user env var so `claude` works from any terminal
        if let Some(bash_path) = find_git_bash() {
            let ps_script = format!(
                "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', '{}', 'User')",
                bash_path.replace('\'', "''"),
            );
            let result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match result {
                Ok(output) if output.status.success() => {
                    eprintln!("Set CLAUDE_CODE_GIT_BASH_PATH={}", bash_path);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to set CLAUDE_CODE_GIT_BASH_PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for env var: {}", e),
            }
        }
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
        }),
    );
}
/// Start the Claude OAuth login flow by running `claude login`.
#[tauri::command]
pub(crate) async fn start_claude_login(app: AppHandle) -> Result<(), String> {
    fn emit_to_frontend(app: &AppHandle, event: &str, payload: Value) -> Result<(), String> {
        if let Err(e1) = app.emit_to("main", event, payload.clone()) {
            if let Err(e2) = app.emit(event, payload) {
                return Err(format!("emit_to failed: {}, emit failed: {}", e1, e2));
            }
        }
        Ok(())
    }

    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;
    let enriched_path = build_enriched_path();

    // On Windows, .cmd/.bat files must be launched via cmd /C (same logic as start_session)
    let mut child = {
        let needs_cmd = claude_bin.ends_with(".cmd")
            || claude_bin.ends_with(".bat")
            || (!claude_bin.contains('\\')
                && !claude_bin.contains('/')
                && !claude_bin.contains('.'));
        let mut cmd = if needs_cmd {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&claude_bin);
            c
        } else {
            Command::new(&claude_bin)
        };
        cmd.args(["login"])
            .env("PATH", &enriched_path)
            .env_remove("CLAUDECODE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to start login (tried '{}'): {}", claude_bin, e))?
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app1 = app.clone();
    let stdout_handle = tokio::spawn(async move {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app1,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
            }
        }
    });

    let app2 = app.clone();
    let stderr_handle = tokio::spawn(async move {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app2,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Login process error: {}", e))?;

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    let code = status.code().unwrap_or(-1);
    let _ = app.emit_to(
        "main",
        "setup:login:exit",
        serde_json::json!({ "code": code }),
    );

    if code != 0 {
        return Err(format!("Login exited with code {}", code));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct AuthStatus {
    pub(crate) authenticated: bool,
    pub(crate) unknown: bool,
}

/// Check whether the Claude CLI is authenticated by running a lightweight check.
#[tauri::command]
pub(crate) async fn check_claude_auth() -> Result<AuthStatus, String> {
    let claude_bin = find_claude_binary().unwrap_or_else(|| {
        {
            "claude.cmd".to_string()
        }
    });
    let enriched_path = build_enriched_path();

    // First try a quick credential file check (instant, no subprocess)
    if let Ok(config_dir) = claude_config_dir() {
        let cred_path = config_dir.join("credentials.json");
        if cred_path.exists() {
            // Parse JSON and check for actual token fields
            if let Ok(content) = std::fs::read_to_string(&cred_path) {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    let has_token = ["claudeAiOAuthToken", "accessToken", "token", "apiKey"]
                        .iter()
                        .any(|key| {
                            json.get(key)
                                .and_then(|v| v.as_str())
                                .map(|s| !s.is_empty())
                                .unwrap_or(false)
                        });
                    if has_token {
                        return Ok(AuthStatus {
                            authenticated: true,
                            unknown: false,
                        });
                    }
                }
                // JSON invalid or no token found — fall through to claude doctor
            }
        }
        // Also check .claude.json (older format)
        let alt_exists = claude_json_path().map(|p| p.exists()).unwrap_or(false);
        if alt_exists {
            return Ok(AuthStatus {
                authenticated: true,
                unknown: false,
            });
        }
    }

    // Fallback: run `claude doctor` with a shorter timeout
    let mut cmd = if claude_needs_cmd_wrapper(&claude_bin) {
        let mut c = Command::new("cmd");
        c.args(["/C", &claude_bin, "doctor"]);
        c
    } else {
        let mut c = Command::new(&claude_bin);
        c.arg("doctor");
        c
    };
    cmd.env("PATH", &enriched_path).env_remove("CLAUDECODE");
    cmd.creation_flags(0x08000000);
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            let combined = format!("{} {}", stdout, stderr);

            let has_auth_issue = combined.contains("not authenticated")
                || combined.contains("not logged in")
                || combined.contains("login required")
                || combined.contains("unauthorized")
                || combined.contains("no api key");

            Ok(AuthStatus {
                authenticated: output.status.success() && !has_auth_issue,
                unknown: false,
            })
        }
        Ok(Err(e)) => Err(format!("Failed to run auth check: {}", e)),
        Err(_) => {
            // Timeout — cannot determine auth status
            Ok(AuthStatus {
                authenticated: false,
                unknown: true,
            })
        }
    }
}

/// 打开一个 cmd.exe 终端窗口运行 `claude login`（带补全后的 PATH）。
#[tauri::command]
pub(crate) async fn open_terminal_login() -> Result<(), String> {
    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;

    {
        // Spawn cmd /k with CREATE_NEW_CONSOLE to open a visible terminal window.
        // This avoids the `start` command's tricky quoting rules.
        let enriched_path = build_enriched_path();
        std::process::Command::new("cmd")
            .arg("/k")
            .arg(&format!("\"{}\" login", claude_bin))
            .env("PATH", &enriched_path)
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    Ok(())
}
