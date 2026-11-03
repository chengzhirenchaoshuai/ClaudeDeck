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
    let mut cwd = String::new();
    let mut by_id: HashMap<String, MsgUsage> = HashMap::new();
    let mut anonymous: Vec<MsgUsage> = Vec::new();

    let Ok(file) = std::fs::File::open(path) else {
        return (cwd, vec![]);
    };
    // 跳过非 UTF-8 的坏行继续读，不因一行损坏丢掉整个文件后面的用量
    for line in jsonl_lines(std::io::BufReader::new(file)) {
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

/// 遍历本机全部会话文件里的助手消息用量（文件解析结果按修改时间和大小缓存）。
/// 续聊 / 回退会把历史消息复制进新文件，同一消息 ID 只交给回调一次，归属最早的文件。
/// 回调参数：会话 ID（文件名）、项目路径、消息用量。返回参与统计的文件数。
pub(crate) fn for_each_usage_msg(
    mut visit: impl FnMut(&str, &str, MsgUsage),
) -> Result<u64, String> {
    let dir = claude_projects_dir()?;
    if !dir.exists() {
        return Ok(0);
    }
    let cache = USAGE_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    // 收集全部会话文件。回退产生的旧分支同样是真实花费，因此不排除隐藏名单；只排除临时 ID。
    let mut files: Vec<(std::path::PathBuf, String, String, std::time::SystemTime, u64)> = vec![];
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
                files.push((path, stem, dir_name.clone(), modified, meta.len()));
            }
        }
    }
    // 早的文件优先：续聊 / 回退会把历史消息复制进新文件，同一消息 ID 只计一次，归属最早的文件
    files.sort_by_key(|f| f.3);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (path, stem, dir_name, modified, len) in &files {
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
            visit(stem, &project, m);
        }
    }
    Ok(files.len() as u64)
}

pub(crate) fn compute_usage_stats() -> Result<Value, String> {
    let mut agg: HashMap<(String, String, String), [u64; 6]> = HashMap::new();
    let session_count = for_each_usage_msg(|_, project, m| {
        let slot = agg
            .entry((m.hour, m.model, project.to_string()))
            .or_insert([0; 6]);
        slot[0] += m.input;
        slot[1] += m.output;
        slot[2] += m.cache_read;
        slot[3] += m.cache_5m;
        slot[4] += m.cache_1h;
        slot[5] += 1;
    })?;

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

/// 活动记录统计：与用量统计共用文件解析缓存和跨文件去重，文件没变时不再重新解析。
/// 会话数只计会话列表里可见的会话；token 与消息数和“用量与成本”口径一致（含回退产生的旧分支）。
pub(crate) fn compute_profile_stats() -> Result<Value, String> {
    let hidden = load_hidden_sessions();
    let mut daily: HashMap<String, ProfileDailyStats> = HashMap::new();
    let mut models: HashMap<String, ProfileModelStats> = HashMap::new();
    let mut sessions: std::collections::HashSet<String> = std::collections::HashSet::new();
    let (mut total_input, mut total_output, mut total_cache, mut message_count) = (0u64, 0u64, 0u64, 0u64);

    for_each_usage_msg(|session_id, _, m| {
        if is_listable_session(session_id, &hidden) {
            sessions.insert(session_id.to_string());
        }
        let cache = m.cache_read + m.cache_5m + m.cache_1h;
        let total = m.input + m.output + cache;
        total_input += m.input;
        total_output += m.output;
        total_cache += cache;
        message_count += 1;

        // 按 UTC 日期归档，与原实现一致
        let date = m.hour.get(0..10).unwrap_or("unknown").to_string();
        let day = daily.entry(date.clone()).or_insert_with(|| ProfileDailyStats {
            date,
            ..Default::default()
        });
        day.input_tokens += m.input;
        day.output_tokens += m.output;
        day.cache_tokens += cache;
        day.total_tokens += total;
        day.message_count += 1;

        if m.model != "unknown" {
            let entry = models.entry(m.model.clone()).or_insert_with(|| ProfileModelStats {
                model: m.model.clone(),
                ..Default::default()
            });
            entry.total_tokens += total;
            entry.message_count += 1;
        }
    })?;

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
        "sessionCount": sessions.len() as u64,
        "messageCount": message_count,
        "activeDays": daily_values.iter().filter(|d| d.date != "unknown").count() as u64,
        "peakDayTokens": peak_day_tokens,
        "daily": daily_values,
        "models": model_values,
    }))
}

#[tauri::command]
pub(crate) async fn get_profile_stats() -> Result<Value, String> {
    tokio::task::spawn_blocking(compute_profile_stats)
        .await
        .map_err(|e| format!("profile stats task failed: {}", e))?
}
