//! CLI 会话管理：列表、搜索、加载、删除/隐藏、导出、项目路径编解码、会话元数据（名称/置顶/归档）与标题生成。

use crate::*;

/// 在阻塞线程池里执行同步文件 IO：会话目录很大时，列表/搜索/加载不再占住 tokio 工作线程。
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task failed: {}", e))?
}

/// 隐藏名单文件：只记录“回退”产生的被替换旧分支。
/// 会话列表以 CLI 的 projects 目录为准，这里的 ID 仅在列表中不显示，jsonl 文件保留以便恢复。
pub(crate) fn hidden_sessions_path() -> Result<std::path::PathBuf, String> {
    app_paths::config_path("hidden_sessions.txt")
}

/// 读取隐藏名单。文件不存在或读取失败时视为空。
pub(crate) fn load_hidden_sessions() -> std::collections::HashSet<String> {
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
pub(crate) fn is_listable_session(id: &str, hidden: &std::collections::HashSet<String>) -> bool {
    !id.starts_with("desk_") && !hidden.contains(id)
}

/// 从列表中隐藏一个被替换的会话（不删除 JSONL 文件）。回退功能用它替换可见分支。
#[tauri::command]
pub(crate) async fn hide_session(session_id: String) -> Result<(), String> {
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
pub(crate) fn start_sessions_watcher(app: AppHandle) {
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
                .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
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
pub(crate) async fn delete_session(_session_id: String, session_path: String) -> Result<(), String> {
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
pub(crate) async fn list_sessions() -> Result<Vec<Value>, String> {
    run_blocking(list_sessions_blocking).await
}

fn list_sessions_blocking() -> Result<Vec<Value>, String> {
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
                        if path.extension().is_some_and(|e| e == "jsonl") {
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
pub(crate) async fn search_sessions(query: String) -> Result<Vec<Value>, String> {
    run_blocking(move || search_sessions_blocking(query)).await
}

fn search_sessions_blocking(query: String) -> Result<Vec<Value>, String> {
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
                        if path.extension().is_some_and(|e| e == "jsonl") {
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
pub(crate) fn search_session_file(path: &std::path::Path, query_lower: &str) -> Option<serde_json::Value> {
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
                let start = char_pos.saturating_sub(75);
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
pub(crate) fn extract_session_info(path: &std::path::Path) -> (String, String) {
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
pub(crate) fn encode_project_dir(path: &str) -> String {
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
pub(crate) fn resolve_project_path(cwd: &str, project_dir: &str) -> String {
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

pub(crate) fn decode_project_name(encoded: &str) -> String {
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

/// 去掉会话记录里前端用不到的大块数据，只影响传给前端的副本，不改动磁盘文件：
/// - `toolUseResult`：工具结果的结构化副本（截图时是完整 base64），前端只判断它是否存在，对象/数组替换为 true；
/// - `image` 内容块（含 tool_result 里的截图）：前端提取文字时本就忽略图片。
///
/// 截图多的会话里这两部分可占文件体积的 95% 以上（实测 155MB → 约 4MB），
/// 不瘦身的话每次打开都要经 IPC 传输并在界面主线程上解析，切换会话会明显卡顿。
/// 记录本身一条不删：回退要沿 parentUuid 回溯消息链。
pub(crate) fn slim_session_record(record: &mut Value) {
    let Some(obj) = record.as_object_mut() else { return };
    // 只替换对象/数组（大块数据都在这里）；字符串等原样保留，避免改变前端的真假判断
    if let Some(v) = obj.get_mut("toolUseResult") {
        if v.is_object() || v.is_array() {
            *v = Value::Bool(true);
        }
    }
    let Some(blocks) = obj
        .get_mut("message")
        .and_then(|m| m.get_mut("content"))
        .and_then(|c| c.as_array_mut())
    else {
        return;
    };
    blocks.retain(|b| b["type"].as_str() != Some("image"));
    for block in blocks.iter_mut() {
        if block["type"].as_str() != Some("tool_result") {
            continue;
        }
        if let Some(inner) = block.get_mut("content").and_then(|c| c.as_array_mut()) {
            inner.retain(|b| b["type"].as_str() != Some("image"));
        }
    }
}

#[tauri::command]
pub(crate) async fn load_session(path: String) -> Result<Vec<Value>, String> {
    // 远程会话（ssh:// URI）经 ssh 读取
    if path.starts_with(commands::remote::REMOTE_SCHEME) {
        let mut records = commands::remote::load_remote_session(&path).await?;
        records.iter_mut().for_each(slim_session_record);
        return Ok(records);
    }
    run_blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
        let reader = std::io::BufReader::new(file);
        let mut messages = vec![];
        for line in jsonl_lines(reader) {
            if let Ok(mut json) = serde_json::from_str::<Value>(&line) {
                slim_session_record(&mut json);
                messages.push(json);
            }
        }
        Ok(messages)
    })
    .await
}

/// Compute billing totals and the latest occupied-context snapshot from a
/// persisted Claude session JSONL file. Assistant records may be repeated once
/// per content block, so totals are de-duplicated by message id.
pub(crate) fn compute_session_tokens<R: std::io::BufRead>(reader: R) -> Value {
    let mut seen_message_ids = std::collections::HashSet::new();
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut context_input_tokens: u64 = 0;
    let mut context_output_tokens: u64 = 0;
    // 最后一次真实 API 调用的模型，前端据此判断上下文窗口（200K / 1M）
    let mut model = String::new();

    for line in jsonl_lines(reader) {
        let Ok(json) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // 压缩边界：之后的上下文以压缩后的 token 数为准（磁盘 JSONL 里是驼峰的 compactMetadata）。
        // 否则压缩后还没有新回复的会话会一直显示压缩前的数值。
        if json["type"].as_str() == Some("system") && json["subtype"].as_str() == Some("compact_boundary") {
            context_input_tokens = json["compactMetadata"]["postTokens"].as_u64().unwrap_or(0);
            context_output_tokens = 0;
            continue;
        }
        if json["type"].as_str() != Some("assistant") {
            continue;
        }
        let message = &json["message"];
        let usage = &message["usage"];
        if !usage.is_object() {
            continue;
        }
        // CLI 自己合成的消息（如报错提示）用量全为 0，不是真实的上下文快照
        if message["model"].as_str() == Some("<synthetic>") {
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
        if let Some(m) = message["model"].as_str() {
            if !m.is_empty() {
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
pub(crate) async fn get_session_tokens(session_id: String) -> Result<Value, String> {
    run_blocking(move || get_session_tokens_blocking(session_id)).await
}

fn get_session_tokens_blocking(session_id: String) -> Result<Value, String> {
    // Find the JSONL file: <CLI 配置目录>/projects/<any-project>/<session_id>.jsonl
    let projects_dir = claude_projects_dir()?;
    let mut jsonl_path = None;

    if projects_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let candidate = entry.path().join(format!("{}.jsonl", session_id));
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
pub(crate) async fn export_session_markdown(path: String, output_path: String, conversation_only: bool) -> Result<(), String> {
    use std::io::Write;
    // 远程会话（ssh:// URI）经 ssh 读取，和 load_session 保持一致
    let records: Vec<Value> = if path.starts_with(commands::remote::REMOTE_SCHEME) {
        commands::remote::load_remote_session(&path).await?
    } else {
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
        jsonl_lines(std::io::BufReader::new(file))
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
pub(crate) async fn export_session_json(path: String, output_path: String) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in jsonl_lines(reader) {
        if let Ok(json) = serde_json::from_str::<Value>(&line) {
            messages.push(json);
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
pub(crate) async fn list_recent_projects() -> Result<Vec<Value>, String> {
    run_blocking(list_recent_projects_blocking).await
}

fn list_recent_projects_blocking() -> Result<Vec<Value>, String> {
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

/// Path to the session-names metadata file (<CLI 配置目录>/tokenicode_session_names.json).
pub(crate) fn session_names_path() -> Result<std::path::PathBuf, String> {
    Ok(claude_config_dir()?.join("tokenicode_session_names.json"))
}

/// Load custom session display names from disk.
#[tauri::command]
pub(crate) async fn load_custom_previews() -> Result<Value, String> {
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
pub(crate) async fn save_custom_previews(data: Value) -> Result<(), String> {
    let path = session_names_path()?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize session names: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write session names: {}", e))
}

/// Load pinned session IDs from disk.
#[tauri::command]
pub(crate) async fn load_pinned_sessions() -> Result<Value, String> {
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
pub(crate) async fn save_pinned_sessions(data: Value) -> Result<(), String> {
    let path = app_paths::config_path("pinned.json")?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize pinned sessions: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write pinned sessions: {}", e))
}

/// Load archived session IDs from disk.
#[tauri::command]
pub(crate) async fn load_archived_sessions() -> Result<Value, String> {
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
pub(crate) async fn save_archived_sessions(data: Value) -> Result<(), String> {
    let path = app_paths::config_path("archived.json")?;
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize archived sessions: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write archived sessions: {}", e))
}

pub(crate) fn normalize_deepseek_model_name(model: &str) -> String {
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
pub(crate) async fn generate_session_title(
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
    cmd.env("MSYS_NO_PATHCONV", "1").env("MSYS2_ARG_CONV_EXCL", "*");

    // Inject provider env vars
    for (k, v) in &provider_env {
        cmd.env(k, v);
    }
    for k in &provider_keys_to_remove {
        cmd.env_remove(k);
    }

    // Suppress console window on Windows
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
