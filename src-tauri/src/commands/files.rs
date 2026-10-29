//! 文件操作：文件树、读写/复制/重命名/删除、目录监听（批量去抖）、临时附件，以及用外部程序打开、分享。

use crate::*;

/// Holds a watcher and its background flush task; dropping stops both.
pub(crate) struct WatchHandle {
    pub(crate) _watcher: notify::RecommendedWatcher,
    pub(crate) _shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Manages active file watchers with debounced event batching
#[derive(Default)]
pub(crate) struct WatcherManager {
    pub(crate) watchers: Arc<TokioMutex<HashMap<String, WatchHandle>>>,
}


/// 远程文件在远端，不能交给本机程序：cmd start 会把 ssh:// 当协议链接打开
fn reject_remote_path(path: &str) -> Result<(), String> {
    if path.starts_with(commands::remote::REMOTE_SCHEME) {
        return Err("远程文件不能用本机程序打开".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_in_vscode(path: String) -> Result<(), String> {
    reject_remote_path(&path)?;
    let mut cmd = Command::new("code");
    cmd.arg(&path);
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn reveal_in_finder(path: String) -> Result<(), String> {
    reject_remote_path(&path)?;
    let mut cmd = Command::new("explorer");
    cmd.args(["/select,", &path]);
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_with_default_app(path: String) -> Result<(), String> {
    reject_remote_path(&path)?;
    Command::new("cmd")
        .args(["/C", "start", "", &path])
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_folder_in_terminal(path: String) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_folder_in_terminal_admin(path: String) -> Result<(), String> {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct FileNode {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) children: Option<Vec<FileNode>>,
}

#[tauri::command]
pub(crate) async fn read_file_tree(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let max_depth = depth.unwrap_or(5);
    // 远程项目：经 ssh 一次读回整棵树
    if let Some((host_id, remote_path)) = commands::remote::parse_remote_uri(&path) {
        let data = commands::remote::scan_remote_tree(&host_id, &remote_path, max_depth).await?;
        return Ok(nodes_from_remote(&data["nodes"]));
    }
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err("Directory does not exist".to_string());
    }
    Ok(read_dir_recursive(root, 0, max_depth))
}

/// 远端读回来的节点转成 FileNode，同一层内目录在前、名称小写比较，与本机 read_dir_recursive 的顺序一致
fn nodes_from_remote(value: &Value) -> Vec<FileNode> {
    let mut nodes: Vec<FileNode> = value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let is_dir = item["is_dir"].as_bool().unwrap_or(false);
            FileNode {
                name: item["name"].as_str().unwrap_or("").to_string(),
                path: item["path"].as_str().unwrap_or("").to_string(),
                is_dir,
                children: if is_dir { Some(nodes_from_remote(&item["children"])) } else { None },
            }
        })
        .collect();
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    nodes
}

pub(crate) fn read_dir_recursive(dir: &std::path::Path, current_depth: u32, max_depth: u32) -> Vec<FileNode> {
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
pub(crate) fn reject_unsafe_path(path: &str) -> Result<(), String> {
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
pub(crate) async fn read_file_content(path: String) -> Result<String, String> {
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
#[tauri::command]
pub(crate) async fn check_file_access(path: String) -> Result<bool, String> {
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
pub(crate) async fn read_file_base64(path: String) -> Result<String, String> {
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
pub(crate) async fn write_file_content(path: String, content: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
pub(crate) async fn copy_file(src: String, dest: String) -> Result<(), String> {
    reject_unsafe_path(&src)?;
    reject_unsafe_path(&dest)?;
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| format!("Cannot copy file: {}", e))
}

/// 另存为：把预览中的文件存到本机任意位置（目标路径来自保存对话框）。
/// 远程文件经 ssh 读出原始字节再写入本机，本机文件直接复制。
#[tauri::command]
pub(crate) async fn save_file_as(src: String, dest: String) -> Result<(), String> {
    reject_unsafe_path(&dest)?;
    reject_remote_path(&dest)?;
    if src.starts_with(commands::remote::REMOTE_SCHEME) {
        let bytes = commands::remote::read_remote_file(&src, 100_000_000).await?;
        return std::fs::write(&dest, bytes).map_err(|e| format!("保存失败: {}", e));
    }
    reject_unsafe_path(&src)?;
    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|e| format!("保存失败: {}", e))
}

#[tauri::command]
pub(crate) async fn rename_file(src: String, dest: String) -> Result<(), String> {
    reject_unsafe_path(&src)?;
    reject_unsafe_path(&dest)?;
    std::fs::rename(&src, &dest).map_err(|e| format!("Cannot rename file: {}", e))
}

#[tauri::command]
pub(crate) async fn delete_file(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    // Move to system trash/recycle bin (recoverable) instead of permanent delete
    trash::delete(&path).map_err(|e| format!("Cannot move to trash: {}", e))
}

#[tauri::command]
pub(crate) async fn create_directory(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot create directory: {}", e))
}

/// Start watching a directory for file changes, emit batched events to frontend.
/// Events are collected into 200ms windows to avoid IPC storms on high-frequency dirs.
#[tauri::command]
pub(crate) async fn watch_directory(
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
    type PendingEvents = Arc<Mutex<Vec<(String, Vec<String>)>>>;
    let pending: PendingEvents = Arc::new(Mutex::new(Vec::new()));
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
pub(crate) async fn unwatch_directory(state: State<'_, WatcherManager>, path: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().await;
    watchers.remove(&path);
    Ok(())
}

/// Get file size in bytes for a given path
#[tauri::command]
pub(crate) async fn get_file_size(path: String) -> Result<u64, String> {
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    Ok(metadata.len())
}

/// Save a file to a temp directory and return its path.
/// Uses a unique suffix to avoid name collisions (e.g. multiple pasted images all named "image.png").
#[tauri::command]
pub(crate) async fn save_temp_file(
    name: String,
    data: Vec<u8>,
    cwd: Option<String>,
) -> Result<String, String> {
    // 远程项目：上传到远端 <项目>/.tokenicode/tmp，返回远端路径（本机路径远端 claude 读不到）
    if let Some(dir) = cwd.as_deref().filter(|d| d.starts_with(commands::remote::REMOTE_SCHEME)) {
        return commands::remote::save_remote_temp_file(dir, &unique_temp_name(&name), &data).await;
    }
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

    let path = tmp.join(unique_temp_name(&name));
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 生成不重名的临时文件名：<主名>_<毫秒时间戳><计数><扩展名>（例如多张都叫 image.png 的粘贴图片）
fn unique_temp_name(name: &str) -> String {
    let path_buf = std::path::PathBuf::from(name);
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
    format!("{}_{}{}{}", stem, ts, count, ext)
}

/// 远程项目里拖入的本机文件：读出内容上传到远端 <项目>/.tokenicode/tmp，返回远端路径。
/// 大小上限与读取远端文件一致（50MB）。
#[tauri::command]
pub(crate) async fn upload_temp_file_to_remote(src_path: String, cwd: String) -> Result<String, String> {
    if !cwd.starts_with(commands::remote::REMOTE_SCHEME) {
        return Err("当前工作目录不是远程项目".to_string());
    }
    let meta = std::fs::metadata(&src_path).map_err(|e| format!("读取文件失败: {}", e))?;
    if !meta.is_file() {
        return Err("只能上传文件，不能上传目录".to_string());
    }
    if meta.len() > 50_000_000 {
        return Err(format!("文件太大（{} 字节）", meta.len()));
    }
    let data = std::fs::read(&src_path).map_err(|e| format!("读取文件失败: {}", e))?;
    let name = std::path::Path::new(&src_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    commands::remote::save_remote_temp_file(&cwd, &unique_temp_name(&name), &data).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 远端目录树转 FileNode：同层目录在前、名称按小写比较，子目录递归排序，文件没有 children
    #[test]
    fn remote_tree_is_sorted_like_local() {
        let data = json!([
            { "name": "b.txt", "path": "ssh://h/C:/p/b.txt", "is_dir": false, "children": null },
            { "name": "Src", "path": "ssh://h/C:/p/Src", "is_dir": true, "children": [
                { "name": "z.rs", "path": "ssh://h/C:/p/Src/z.rs", "is_dir": false },
                { "name": "A.rs", "path": "ssh://h/C:/p/Src/A.rs", "is_dir": false },
            ] },
            { "name": "A.txt", "path": "ssh://h/C:/p/A.txt", "is_dir": false },
            { "name": "docs", "path": "ssh://h/C:/p/docs", "is_dir": true, "children": [] },
        ]);
        let nodes = nodes_from_remote(&data);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["docs", "Src", "A.txt", "b.txt"]);
        assert!(nodes[0].children.as_ref().unwrap().is_empty());
        assert!(nodes[2].children.is_none());
        let inner: Vec<&str> = nodes[1].children.as_ref().unwrap().iter().map(|n| n.name.as_str()).collect();
        assert_eq!(inner, ["A.rs", "z.rs"]);
    }
}
