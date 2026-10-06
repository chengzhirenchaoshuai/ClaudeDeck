//! 用量统计：读取 CLI 会话文件，按小时 / 模型 / 项目聚合 token；以及个人资料页的每日与模型统计。

use crate::*;

/// 单条助手消息的用量（已按消息 ID 在文件内去重）
#[derive(Clone)]
pub(crate) struct MsgUsage {
    pub(crate) id: String,
    /// 时间戳前 13 位（UTC），如 2026-09-21T14；前端按本地时区归到自然日
    pub(crate) hour: String,
    pub(crate) model: String,
    pub(crate) input: u64,
    pub(crate) output: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_5m: u64,
    pub(crate) cache_1h: u64,
}

pub(crate) struct CachedUsage {
    pub(crate) modified: std::time::SystemTime,
    pub(crate) len: u64,
    pub(crate) cwd: String,
    pub(crate) msgs: Vec<MsgUsage>,
}

pub(crate) static USAGE_CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, CachedUsage>>,
> = std::sync::OnceLock::new();

/// 解析一个会话文件。同一条消息可能按内容块重复写入多行，保留 output 最大（即最终）的那一条。
pub(crate) fn parse_usage_file(path: &std::path::Path) -> (String, Vec<MsgUsage>) {
    use std::io::BufRead;
    let mut cwd = String::new();
    let mut by_id: HashMap<String, MsgUsage> = HashMap::new();
    let mut anonymous: Vec<MsgUsage> = Vec::new();

    let Ok(file) = std::fs::File::open(path) else {
        return (cwd, vec![]);
    };
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if cwd.is_empty() {
            if let Some(c) = value["cwd"].as_str() {
                cwd = c.to_string();
            }
        }
        if value["type"].as_str() != Some("assistant") {
            continue;
        }
        let message = &value["message"];
        let usage = &message["usage"];
        if !usage.is_object() {
            continue;
        }
        let input = usage_u64(usage, "input_tokens");
        let output = usage_u64(usage, "output_tokens");
        let cache_read = usage_u64(usage, "cache_read_input_tokens");
        // 有 5m / 1h 明细时以明细为准，否则整体按 5m 计
        let (cache_5m, cache_1h) = match usage.get("cache_creation") {
            Some(nested) if nested.is_object() => (
                usage_u64(nested, "ephemeral_5m_input_tokens"),
                usage_u64(nested, "ephemeral_1h_input_tokens"),
            ),
            _ => (usage_u64(usage, "cache_creation_input_tokens"), 0),
        };
        if input + output + cache_read + cache_5m + cache_1h == 0 {
            continue;
        }
        let id = message["id"]
            .as_str()
            .or_else(|| value["uuid"].as_str())
            .unwrap_or("")
            .to_string();
        let record = MsgUsage {
            id: id.clone(),
            hour: value["timestamp"]
                .as_str()
                .and_then(|s| s.get(0..13))
                .unwrap_or("unknown")
                .to_string(),
            model: message["model"].as_str().unwrap_or("unknown").to_string(),
            input,
            output,
            cache_read,
            cache_5m,
            cache_1h,
        };
        if id.is_empty() {
            anonymous.push(record);
        } else {
            match by_id.get(&id) {
                Some(existing) if existing.output >= record.output => {}
                _ => {
                    by_id.insert(id, record);
                }
            }
        }
    }
    let mut msgs: Vec<MsgUsage> = by_id.into_values().collect();
    msgs.extend(anonymous);
    (cwd, msgs)
}

pub(crate) fn compute_usage_stats() -> Result<Value, String> {
    let dir = claude_projects_dir()?;
    if !dir.exists() {
        return Ok(serde_json::json!({ "rows": [], "sessionCount": 0u64 }));
    }
    let cache = USAGE_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    // 收集全部会话文件。回退产生的旧分支同样是真实花费，因此不排除隐藏名单；只排除临时 ID。
    let mut files: Vec<(std::path::PathBuf, String, std::time::SystemTime, u64)> = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            let Ok(children) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for child in children.flatten() {
                let path = child.path();
                if !path.extension().is_some_and(|e| e == "jsonl") {
                    continue;
                }
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if stem.starts_with("desk_") {
                    continue;
                }
                let Ok(meta) = child.metadata() else { continue };
                let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                files.push((path, dir_name.clone(), modified, meta.len()));
            }
        }
    }
    // 早的文件优先：续聊 / 回退会把历史消息复制进新文件，同一消息 ID 只计一次，归属最早的文件
    files.sort_by_key(|f| f.2);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut agg: HashMap<(String, String, String), [u64; 6]> = HashMap::new();
    let session_count = files.len() as u64;

    for (path, dir_name, modified, len) in &files {
        let cached = {
            let guard = cache.lock().map_err(|_| "usage cache poisoned".to_string())?;
            guard
                .get(path)
                .filter(|c| c.modified == *modified && c.len == *len)
                .map(|c| (c.cwd.clone(), c.msgs.clone()))
        };
        let (cwd, msgs) = match cached {
            Some(hit) => hit,
            None => {
                let (cwd, msgs) = parse_usage_file(path);
                if let Ok(mut guard) = cache.lock() {
                    guard.insert(
                        path.clone(),
                        CachedUsage {
                            modified: *modified,
                            len: *len,
                            cwd: cwd.clone(),
                            msgs: msgs.clone(),
                        },
                    );
                }
                (cwd, msgs)
            }
        };
        let project = resolve_project_path(&cwd, dir_name);
        for m in msgs {
            if !m.id.is_empty() && !seen.insert(m.id.clone()) {
                continue;
            }
            let slot = agg
                .entry((m.hour, m.model, project.clone()))
                .or_insert([0; 6]);
            slot[0] += m.input;
            slot[1] += m.output;
            slot[2] += m.cache_read;
            slot[3] += m.cache_5m;
            slot[4] += m.cache_1h;
            slot[5] += 1;
        }
    }

    let rows: Vec<Value> = agg
        .into_iter()
        .map(|((hour, model, project), v)| {
            serde_json::json!({
                "hour": hour, "model": model, "project": project,
                "input": v[0], "output": v[1], "cacheRead": v[2],
                "cache5m": v[3], "cache1h": v[4], "messages": v[5],
            })
        })
        .collect();
    Ok(serde_json::json!({ "rows": rows, "sessionCount": session_count }))
}

/// 用量统计（含按项目、缓存读写拆分）。文件解析结果按 (修改时间, 大小) 缓存，重复调用很快。
#[tauri::command]
pub(crate) async fn get_usage_stats() -> Result<Value, String> {
    tokio::task::spawn_blocking(compute_usage_stats)
        .await
        .map_err(|e| format!("usage task failed: {}", e))?
}
#[derive(Default, serde::Serialize, Clone)]
pub(crate) struct ProfileDailyStats {
    pub(crate) date: String,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) message_count: u64,
}

#[derive(Default, serde::Serialize, Clone)]
pub(crate) struct ProfileModelStats {
    pub(crate) model: String,
    pub(crate) total_tokens: u64,
    pub(crate) message_count: u64,
}

pub(crate) fn usage_u64(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

pub(crate) fn cache_creation_tokens(usage: &Value) -> u64 {
    let top_level = usage_u64(usage, "cache_creation_input_tokens");
    let nested = usage.get("cache_creation").map(|v| {
        usage_u64(v, "ephemeral_1h_input_tokens") + usage_u64(v, "ephemeral_5m_input_tokens")
    }).unwrap_or(0);
    top_level + nested
}

#[tauri::command]
pub(crate) async fn get_profile_stats() -> Result<Value, String> {
    use std::collections::{HashMap, HashSet};
    let claude_dir = claude_projects_dir()?;
    if !claude_dir.exists() {
        return Ok(serde_json::json!({
            "totalInputTokens": 0u64,
            "totalOutputTokens": 0u64,
            "totalCacheTokens": 0u64,
            "totalTokens": 0u64,
            "sessionCount": 0u64,
            "messageCount": 0u64,
            "activeDays": 0u64,
            "peakDayTokens": 0u64,
            "daily": [],
            "models": [],
        }));
    }

    let hidden = load_hidden_sessions();
    let mut daily: HashMap<String, ProfileDailyStats> = HashMap::new();
    let mut models: HashMap<String, ProfileModelStats> = HashMap::new();
    let mut counted_sessions: HashSet<String> = HashSet::new();

    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache = 0u64;
    let mut message_count = 0u64;

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if !path.extension().is_some_and(|e| e == "jsonl") {
                    continue;
                }
                let Some(name) = path.file_stem() else {
                    continue;
                };
                let session_id = name.to_string_lossy().to_string();
                if !is_listable_session(&session_id, &hidden) {
                    continue;
                }
                counted_sessions.insert(session_id.clone());

                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let reader = std::io::BufReader::new(file);
                let mut seen_message_ids: HashSet<String> = HashSet::new();

                for line in jsonl_lines(reader) {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
                        continue;
                    }
                    let Some(message) = value.get("message") else {
                        continue;
                    };
                    let Some(usage) = message.get("usage") else {
                        continue;
                    };

                    let message_key = message
                        .get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| value.get("uuid").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    if !message_key.is_empty() && !seen_message_ids.insert(message_key.to_string()) {
                        continue;
                    }

                    let input_tokens = usage_u64(usage, "input_tokens");
                    let output_tokens = usage_u64(usage, "output_tokens");
                    let cache_tokens = usage_u64(usage, "cache_read_input_tokens")
                        + cache_creation_tokens(usage);
                    let total_tokens = input_tokens + output_tokens + cache_tokens;
                    if total_tokens == 0 {
                        continue;
                    }

                    total_input += input_tokens;
                    total_output += output_tokens;
                    total_cache += cache_tokens;
                    message_count += 1;

                    let date = value
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.get(0..10))
                        .unwrap_or("unknown")
                        .to_string();
                    let entry = daily.entry(date.clone()).or_insert_with(|| ProfileDailyStats {
                        date,
                        ..Default::default()
                    });
                    entry.input_tokens += input_tokens;
                    entry.output_tokens += output_tokens;
                    entry.cache_tokens += cache_tokens;
                    entry.total_tokens += total_tokens;
                    entry.message_count += 1;

                    if let Some(model) = message.get("model").and_then(|v| v.as_str()) {
                        let model_entry = models.entry(model.to_string()).or_insert_with(|| ProfileModelStats {
                            model: model.to_string(),
                            ..Default::default()
                        });
                        model_entry.total_tokens += total_tokens;
                        model_entry.message_count += 1;
                    }
                }
            }
        }
    }

    let mut daily_values: Vec<ProfileDailyStats> = daily.into_values().collect();
    daily_values.sort_by(|a, b| a.date.cmp(&b.date));
    let peak_day_tokens = daily_values.iter().map(|d| d.total_tokens).max().unwrap_or(0);

    let mut model_values: Vec<ProfileModelStats> = models.into_values().collect();
    model_values.sort_by_key(|m| std::cmp::Reverse(m.total_tokens));
    model_values.truncate(8);

    Ok(serde_json::json!({
        "totalInputTokens": total_input,
        "totalOutputTokens": total_output,
        "totalCacheTokens": total_cache,
        "totalTokens": total_input + total_output + total_cache,
        "sessionCount": counted_sessions.len() as u64,
        "messageCount": message_count,
        "activeDays": daily_values.iter().filter(|d| d.date != "unknown").count() as u64,
        "peakDayTokens": peak_day_tokens,
        "daily": daily_values,
        "models": model_values,
    }))
}
