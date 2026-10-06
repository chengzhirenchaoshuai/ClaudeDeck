//! 本地工具链部署：Node.js 与 Git for Windows（PortableGit）的下载（带镜像与进度）和解压。

use crate::*;

// ─── Node.js local deployment ──────────────────────────────────────────

/// Hardcoded Node.js LTS version for local deployment.
pub(crate) const NODE_LTS_VERSION: &str = "v22.22.0";

/// Primary Node.js download base URL (official).
pub(crate) const NODE_DIST_OFFICIAL: &str = "https://nodejs.org/dist";

/// China mirror: npmmirror CDN for Node.js binaries.
pub(crate) const NODE_DIST_NPMMIRROR: &str = "https://cdn.npmmirror.com/binaries/node";

/// China mirror: Huawei Cloud for Node.js binaries.
pub(crate) const NODE_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/nodejs";

/// Directory for app-local Node.js installation.
pub(crate) fn node_download_dir() -> Result<std::path::PathBuf, String> {
    app_paths::tools_dir().map(|d| d.join("node"))
}

/// Directory for npm global installs (--prefix target).
pub(crate) fn npm_global_dir() -> Result<std::path::PathBuf, String> {
    app_paths::tools_dir().map(|d| d.join("npm-global"))
}

/// Directory for npm cache (avoids system cache EPERM on Windows).
pub(crate) fn npm_cache_dir() -> Result<std::path::PathBuf, String> {
    app_paths::tools_dir().map(|d| d.join("npm-cache"))
}

/// Get the bin directory of the local Node.js installation, if it exists.
pub(crate) fn get_local_node_bin() -> Option<std::path::PathBuf> {
    let node_dir = node_download_dir().ok()?;
    #[cfg(target_os = "windows")]
    {
        // Windows: node.exe is at the root of the extracted directory
        let node_exe = node_dir.join("node.exe");
        if node_exe.exists() {
            return Some(node_dir);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = node_dir.join("bin");
        if bin.join("node").exists() {
            return Some(bin);
        }
    }
    None
}

/// Get the bin directory of npm-global, if it exists.
pub(crate) fn get_npm_global_bin() -> Option<std::path::PathBuf> {
    let dir = npm_global_dir().ok()?;
    #[cfg(target_os = "windows")]
    let bin = dir.clone();
    #[cfg(not(target_os = "windows"))]
    let bin = dir.join("bin");
    if bin.exists() {
        Some(bin)
    } else {
        None
    }
}

/// Determine Node.js archive filename and format for the current platform.
pub(crate) fn get_node_archive_info() -> Result<(String, &'static str), String> {
    // Returns (filename, extension)
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok((format!("node-{}-darwin-arm64", NODE_LTS_VERSION), "tar.gz")),
        ("macos", "x86_64") => Ok((format!("node-{}-darwin-x64", NODE_LTS_VERSION), "tar.gz")),
        ("windows", "x86_64") => Ok((format!("node-{}-win-x64", NODE_LTS_VERSION), "zip")),
        ("windows", "aarch64") => Ok((format!("node-{}-win-arm64", NODE_LTS_VERSION), "zip")),
        ("linux", "x86_64") => Ok((format!("node-{}-linux-x64", NODE_LTS_VERSION), "tar.gz")),
        ("linux", "aarch64") => Ok((format!("node-{}-linux-arm64", NODE_LTS_VERSION), "tar.gz")),
        (os, arch) => Err(format!("Unsupported platform for Node.js: {}-{}", os, arch)),
    }
}

/// Check if npm is available on the system (not counting local Node.js).
pub(crate) async fn is_system_npm_available() -> bool {
    let enriched_path = build_enriched_path();

    // 1. Direct PATH check
    #[cfg(target_os = "windows")]
    let result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npm.cmd", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut cmd = Command::new("npm");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    if matches!(&result, Ok(Ok(output)) if output.status.success()) {
        return true;
    }

    // 2. Fallback: login shell (macOS/Linux GUI apps don't inherit shell PATH)
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let shell_result = {
            let mut cmd = Command::new(&shell);
            cmd.args(["-l", "-c", "npm --version"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
        };
        if matches!(shell_result, Ok(Ok(output)) if output.status.success()) {
            eprintln!(
                "npm found via login shell ({}) but not via enriched PATH",
                shell
            );
            return true;
        }
    }

    false
}

#[derive(Serialize)]
pub(crate) struct NodeEnvStatus {
    pub(crate) node_available: bool,
    pub(crate) node_version: Option<String>,
    pub(crate) node_source: Option<String>, // "system" | "local"
    pub(crate) npm_available: bool,
}

#[tauri::command]
pub(crate) async fn check_node_env() -> Result<NodeEnvStatus, String> {
    let enriched_path = build_enriched_path();

    // 1. Check local Node.js first
    if let Some(local_bin) = get_local_node_bin() {
        let node_path = local_bin.join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        });
        let mut node_cmd = Command::new(&node_path);
        node_cmd.arg("--version").stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        node_cmd.creation_flags(0x08000000);
        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_secs(10), node_cmd.output()).await
        {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Ok(NodeEnvStatus {
                    node_available: true,
                    node_version: Some(version),
                    node_source: Some("local".to_string()),
                    npm_available: true, // local Node.js always comes with npm
                });
            }
        }
    }

    // 2. Check system Node.js
    #[cfg(target_os = "windows")]
    let node_result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "node", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let node_result = {
        let mut cmd = Command::new("node");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    match node_result {
        Ok(Ok(output)) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let npm_available = is_system_npm_available().await;
            Ok(NodeEnvStatus {
                node_available: true,
                node_version: Some(version),
                node_source: Some("system".to_string()),
                npm_available,
            })
        }
        _ => Ok(NodeEnvStatus {
            node_available: false,
            node_version: None,
            node_source: None,
            npm_available: is_system_npm_available().await,
        }),
    }
}

/// Download and extract Node.js LTS to the local app directory.
#[tauri::command]
pub(crate) async fn install_node_env(app: AppHandle) -> Result<(), String> {
    let china = is_china_network().await;
    install_node_env_inner(&app, china).await
}

pub(crate) async fn install_node_env_inner(app: &AppHandle, china: bool) -> Result<(), String> {
    let (archive_name, ext) = get_node_archive_info()?;
    let filename = format!("{}.{}", archive_name, ext);

    let install_dir = node_download_dir()?;
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create node dir: {}", e))?;

    let client = build_smart_http_client(
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(120),
    )
    .await;

    // Network-aware source ordering
    let sources: Vec<String> = if china {
        vec![
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_HUAWEI, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
        ]
    };

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for (i, url) in sources.iter().enumerate() {
        eprintln!("Trying Node.js download: {}", url);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "node_downloading"
            }),
        );

        match download_with_progress(app, &client, url, "node_downloading").await {
            Ok(bytes) => {
                eprintln!("Node.js download succeeded from source {}", i);
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes = archive_bytes
        .ok_or_else(|| format!("All Node.js download sources failed: {}", last_err))?;

    // Extract
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "node_extracting"
        }),
    );

    extract_node_archive(&bytes, ext, &archive_name, &install_dir)?;

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = install_dir.join("bin");
        if bin_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::set_permissions(
                        entry.path(),
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
            }
        }
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "node_complete"
        }),
    );

    eprintln!(
        "Node.js {} installed to {:?}",
        NODE_LTS_VERSION, install_dir
    );
    Ok(())
}

// ─── Git for Windows (PortableGit) local deployment ─────────────────────────

/// PortableGit version for auto-deployment on Windows (when git-bash is missing).
#[cfg(target_os = "windows")]
pub(crate) const GIT_PORTABLE_VERSION: &str = "2.47.1.2";

/// Git for Windows release tag (used in download URLs).
#[cfg(target_os = "windows")]
pub(crate) const GIT_RELEASE_TAG: &str = "v2.47.1.windows.2";

/// GitHub releases URL for Git for Windows.
#[cfg(target_os = "windows")]
pub(crate) const GIT_DIST_GITHUB: &str = "https://github.com/git-for-windows/git/releases/download";

/// China mirror: npmmirror binary mirror.
#[cfg(target_os = "windows")]
pub(crate) const GIT_DIST_NPMMIRROR: &str = "https://registry.npmmirror.com/-/binary/git-for-windows";

/// China mirror: Huawei Cloud.
#[cfg(target_os = "windows")]
pub(crate) const GIT_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/git-for-windows";

/// Download and install PortableGit to provide bash.exe on Windows.
/// The .7z.exe self-extracting archive is downloaded and executed silently.
#[cfg(target_os = "windows")]
pub(crate) async fn install_git_bash_inner(app: &AppHandle, china: bool) -> Result<(), String> {
    let install_dir = git_download_dir()?;

    // If an incomplete installation exists (no bash.exe), clean it up
    if install_dir.exists() {
        let bash = install_dir.join("bin").join("bash.exe");
        if !bash.exists() {
            eprintln!("Incomplete Git installation found, cleaning up...");
            let _ = std::fs::remove_dir_all(&install_dir);
        }
    }

    // Already installed?
    if install_dir.join("bin").join("bash.exe").exists() {
        eprintln!("PortableGit already installed at {:?}", install_dir);
        return Ok(());
    }

    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create git dir: {}", e))?;

    // Determine architecture: x64 or arm64 (64-bit only)
    let arch_suffix = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "64", // x86_64 and fallback
    };
    let filename = format!(
        "PortableGit-{}-{}-bit.7z.exe",
        GIT_PORTABLE_VERSION, arch_suffix
    );

    let sources: Vec<String> = if china {
        vec![
            // China: Huawei fastest, then npmmirror, GitHub last
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
        ]
    };

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15), // Fast failover between mirrors
        std::time::Duration::from_secs(300), // 5 min for large download
    )
    .await;

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for url in &sources {
        eprintln!("Trying PortableGit download: {}", url);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "git_downloading"
            }),
        );

        match download_with_progress(app, &client, url, "git_downloading").await {
            Ok(bytes) => {
                eprintln!("PortableGit download succeeded ({} bytes)", bytes.len());
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes =
        archive_bytes.ok_or_else(|| format!("All Git download sources failed: {}", last_err))?;

    // Write the .7z.exe to a temp file
    let temp_path = install_dir.join(&filename);
    std::fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write PortableGit archive: {}", e))?;

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "git_extracting"
        }),
    );

    // Run the self-extracting archive silently: -o<dir> -y
    eprintln!("Extracting PortableGit to {:?}...", install_dir);
    let extract_result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        Command::new(&temp_path)
            .args([&format!("-o{}", install_dir.display()), "-y"])
            .stdin(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output(),
    )
    .await;

    // Clean up the downloaded archive regardless of result
    let _ = std::fs::remove_file(&temp_path);

    match extract_result {
        Ok(Ok(output)) if output.status.success() => {
            eprintln!("PortableGit extraction succeeded");
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "PortableGit extraction failed (exit {}): {}",
                output.status, stderr
            ));
        }
        Ok(Err(e)) => {
            return Err(format!("Failed to run PortableGit extractor: {}", e));
        }
        Err(_) => {
            return Err("PortableGit extraction timed out after 120s".to_string());
        }
    }

    // Verify bash.exe exists
    let bash = install_dir.join("bin").join("bash.exe");
    if !bash.exists() {
        return Err("bash.exe not found after PortableGit extraction".to_string());
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "git_complete"
        }),
    );

    eprintln!("PortableGit installed to {:?}", install_dir);
    Ok(())
}

/// Download a URL with streaming progress events.
pub(crate) async fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    phase: &str,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        let percent = if total > 0 {
            (downloaded * 80 / total) as u8
        } else {
            0
        };
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": downloaded, "total": total, "percent": percent, "phase": phase
            }),
        );
    }

    Ok(bytes)
}

/// Extract a Node.js archive (tar.gz or zip) into the target directory.
pub(crate) fn extract_node_archive(
    data: &[u8],
    ext: &str,
    _archive_name: &str,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    match ext {
        "tar.gz" => {
            let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
            let mut archive = tar::Archive::new(decoder);

            // Node.js tar.gz extracts to a subdirectory like "node-v22.22.0-darwin-arm64/"
            // We want the contents directly in install_dir
            for entry in archive.entries().map_err(|e| format!("tar error: {}", e))? {
                let mut entry = entry.map_err(|e| format!("tar entry error: {}", e))?;
                let path = entry.path().map_err(|e| format!("path error: {}", e))?;

                // Strip the top-level directory (e.g., "node-v22.22.0-darwin-arm64/bin/node" -> "bin/node")
                let stripped: std::path::PathBuf = path
                    .components()
                    .skip(1) // skip "node-v22.22.0-platform/"
                    .collect();

                if stripped.as_os_str().is_empty() {
                    continue; // skip the top-level dir itself
                }

                let target = install_dir.join(&stripped);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                entry
                    .unpack(&target)
                    .map_err(|e| format!("unpack error for {:?}: {}", stripped, e))?;
            }
            Ok(())
        }
        "zip" => {
            let reader = std::io::Cursor::new(data);
            let mut archive =
                zip::ZipArchive::new(reader).map_err(|e| format!("zip open error: {}", e))?;

            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| format!("zip entry error: {}", e))?;

                let name = file.name().to_string();
                // Strip top-level directory (e.g., "node-v22.22.0-win-x64/node.exe" -> "node.exe")
                let stripped: String = name.splitn(2, '/').nth(1).unwrap_or("").to_string();
                if stripped.is_empty() {
                    continue;
                }

                let target = install_dir.join(&stripped);
                if file.is_dir() {
                    let _ = std::fs::create_dir_all(&target);
                } else {
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let mut outfile = std::fs::File::create(&target)
                        .map_err(|e| format!("create file error: {}", e))?;
                    std::io::copy(&mut file, &mut outfile)
                        .map_err(|e| format!("write error: {}", e))?;
                }
            }
            Ok(())
        }
        _ => Err(format!("Unsupported archive format: {}", ext)),
    }
}
