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


#[tauri::command]
pub(crate) async fn open_in_vscode(path: String) -> Result<(), String> {
    let mut cmd = Command::new("code");
    cmd.arg(&path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn reveal_in_finder(path: String) -> Result<(), String> {
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
pub(crate) async fn open_with_default_app(path: String) -> Result<(), String> {
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
pub(crate) async fn open_folder_in_terminal(path: String) -> Result<(), String> {
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
pub(crate) async fn open_folder_in_terminal_admin(path: String) -> Result<(), String> {
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
pub(crate) async fn share_file(path: String, app: AppHandle) -> Result<(), String> {
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
pub(crate) async fn share_to_wechat(path: String, app: AppHandle) -> Result<(), String> {
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
pub(crate) struct FileNode {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) children: Option<Vec<FileNode>>,
}

#[tauri::command]
pub(crate) async fn read_file_tree(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let max_depth = depth.unwrap_or(5);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err("Directory does not exist".to_string());
    }
    Ok(read_dir_recursive(root, 0, max_depth))
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
/// Used at startup to detect macOS TCC restrictions.
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
