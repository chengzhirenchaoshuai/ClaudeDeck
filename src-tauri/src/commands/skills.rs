//! 斜杠命令与技能：扫描、读写、启用/禁用，以及借助服务商翻译技能元数据和文档（带磁盘缓存）。

use crate::*;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SlashCommand {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) source: String,
    pub(crate) has_args: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct UnifiedCommand {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) source: String,   // "builtin" | "global" | "project"
    pub(crate) category: String, // "builtin" | "command" | "skill"
    pub(crate) has_args: bool,
    pub(crate) path: Option<String>, // Only for skills, points to SKILL.md
    pub(crate) immediate: bool,      // true = execute immediately (no message sent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) execution: Option<String>, // "ui" | "cli" | "session" — how command is executed
}

/// Scan and return all available slash commands (built-in + custom .md files)
#[tauri::command]
pub(crate) async fn list_slash_commands(cwd: Option<String>) -> Result<Vec<SlashCommand>, String> {
    let mut commands: Vec<SlashCommand> = vec![];

    // Built-in commands: (name, description, has_args)
    let builtins: [(&str, &str, bool); 29] = [
        ("/ask", "Ask a question without making changes", false),
        ("/bug", "Report a bug with Claude Code", false),
        ("/clear", "Clear conversation history", false),
        ("/code", "Switch to code mode (default)", false),
        ("/compact", "Compact conversation to reduce context", false),
        ("/config", "Open settings panel", false),
        ("/context", "Manage context files and directories", false),
        ("/cost", "Show session cost and token usage", false),
        ("/doctor", "Check Claude Code health status", false),
        ("/exit", "Close the application", false),
        ("/export", "Export conversation to markdown", true),
        ("/help", "Show available commands", false),
        ("/init", "Initialize project configuration", false),
        ("/mcp", "Manage MCP server connections", false),
        ("/memory", "View or edit MEMORY.md files", false),
        ("/model", "Switch the AI model", false),
        ("/permissions", "View and manage tool permissions", false),
        ("/plan", "Enter plan mode for complex tasks", false),
        ("/rename", "Rename the current session", true),
        ("/resume", "Resume a previous session", true),
        ("/rewind", "Rewind conversation to a previous turn", false),
        ("/stats", "Show session statistics", false),
        ("/status", "Show session status", false),
        ("/statusline", "Configure status line display", false),
        ("/tasks", "View running background tasks", false),
        ("/teleport", "Teleport context to a new session", false),
        ("/theme", "Toggle light/dark/system theme", false),
        ("/todos", "View todo items from the session", false),
        ("/usage", "Show detailed token usage breakdown", false),
    ];
    for (name, desc, has_args) in &builtins {
        commands.push(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "builtin".to_string(),
            has_args: *has_args,
        });
    }

    // Helper: scan a directory for .md command files
    fn scan_commands_dir(dir: &std::path::Path, source: &str) -> Vec<SlashCommand> {
        let mut cmds = vec![];
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return cmds,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "md") {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name = format!("/{}", stem);

                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let description = content
                    .lines()
                    .next()
                    .map(|line| line.trim_start_matches('#').trim().to_string())
                    .unwrap_or_else(|| stem.clone());
                let has_args = content.contains("$ARGUMENTS");

                cmds.push(SlashCommand {
                    name,
                    description,
                    source: source.to_string(),
                    has_args,
                });
            }
        }
        cmds
    }

    // Global custom commands: ~/.claude/commands/*.md
    if let Ok(config_dir) = claude_config_dir() {
        let global_dir = config_dir.join("commands");
        commands.extend(scan_commands_dir(&global_dir, "global"));
    }

    // Project custom commands: {cwd}/.claude/commands/*.md
    if let Some(ref cwd_path) = cwd {
        let project_dir = std::path::Path::new(cwd_path)
            .join(".claude")
            .join("commands");
        commands.extend(scan_commands_dir(&project_dir, "project"));
    }

    Ok(commands)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SkillInfo {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
    pub(crate) scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) disable_model_invocation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) argument_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslationItem {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslation {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTranslationConfig {
    pub(crate) base_url: String,
    pub(crate) api_format: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) proxy_url: Option<String>,
}

pub(crate) fn skill_translation_config_path() -> Result<std::path::PathBuf, String> {
    app_paths::config_path("skill-translation.json")
}

#[tauri::command]
pub(crate) fn load_skill_translation_config() -> Result<Option<SkillTranslationConfig>, String> {
    let path = skill_translation_config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read skill translation config: {}", e))?;
    let json = decrypt_providers(&raw)?;
    serde_json::from_str(&json)
        .map(Some)
        .map_err(|e| format!("Cannot parse skill translation config: {}", e))
}

#[tauri::command]
pub(crate) fn save_skill_translation_config(config: SkillTranslationConfig) -> Result<(), String> {
    let path = skill_translation_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
    }
    let json = serde_json::to_string(&config)
        .map_err(|e| format!("Serialize error: {}", e))?;
    let sealed = encrypt_providers(&json)?;
    std::fs::write(&path, sealed).map_err(|e| format!("Write error: {}", e))?;
    harden_path_permissions(&path);
    Ok(())
}

/// YAML frontmatter fields for SKILL.md files
#[derive(Debug, Deserialize, Default)]
pub(crate) struct SkillFrontmatter {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default, rename = "disable-model-invocation")]
    pub(crate) disable_model_invocation: Option<bool>,
    #[serde(default, rename = "user-invocable")]
    pub(crate) user_invocable: Option<bool>,
    #[serde(
        default,
        rename = "allowed-tools",
        deserialize_with = "deserialize_optional_string_list"
    )]
    pub(crate) allowed_tools: Option<Vec<String>>,
    #[serde(default, rename = "argument-hint")]
    pub(crate) argument_hint: Option<String>,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) context: Option<String>,
    #[serde(default)]
    pub(crate) agent: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
}

pub(crate) fn deserialize_optional_string_list<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_yaml::Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    let tools = match value {
        serde_yaml::Value::Sequence(items) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_yaml::Value::String(s) => Some(s.trim().to_string()),
                other => other.as_str().map(|s| s.trim().to_string()),
            })
            .filter(|s| !s.is_empty())
            .collect(),
        serde_yaml::Value::String(s) => s
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        _ => Vec::new(),
    };

    Ok(Some(tools))
}

/// Parse YAML frontmatter from a SKILL.md file content.
/// Returns (parsed frontmatter, body text after frontmatter).
pub(crate) fn parse_skill_frontmatter(content: &str) -> (SkillFrontmatter, &str) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (SkillFrontmatter::default(), content);
    }
    // Find the closing ---
    let after_open = &trimmed[3..];
    if let Some(close_idx) = after_open.find("\n---") {
        let yaml_str = &after_open[..close_idx];
        let body_start = 3 + close_idx + 4; // "---" + yaml + "\n---"
        let body = trimmed.get(body_start..).unwrap_or("");
        // Skip leading newline in body
        let body = body.strip_prefix('\n').unwrap_or(body);
        match serde_yaml::from_str::<SkillFrontmatter>(yaml_str) {
            Ok(fm) => (fm, body),
            Err(_) => (SkillFrontmatter::default(), content),
        }
    } else {
        (SkillFrontmatter::default(), content)
    }
}

/// Update or insert a single YAML frontmatter field.
/// If value is None, the field is removed. If no frontmatter exists, one is created.
pub(crate) fn update_frontmatter_field(content: &str, field: &str, value: Option<&str>) -> String {
    let trimmed = content.trim_start();
    if let Some(after_open) = trimmed.strip_prefix("---") {
        if let Some(close_idx) = after_open.find("\n---") {
            let yaml_section = &after_open[..close_idx];
            let body = &trimmed[3 + close_idx + 4..];

            // Filter out existing field line
            let mut lines: Vec<&str> = yaml_section
                .lines()
                .filter(|line| {
                    let trimmed_line = line.trim();
                    !trimmed_line.starts_with(&format!("{}:", field))
                })
                .collect();

            // Add field if value is provided
            if let Some(val) = value {
                lines.push(""); // will be replaced
                let new_line = format!("{}: {}", field, val);
                // Replace the empty placeholder
                let last = lines.len() - 1;
                lines.remove(last);
                let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
                let mut result = String::from("---\n");
                for line in &owned_lines {
                    result.push_str(line);
                    result.push('\n');
                }
                result.push_str(&new_line);
                result.push_str("\n---");
                result.push_str(body);
                return result;
            }

            // Just remove the field
            let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            if owned_lines.iter().all(|l| l.trim().is_empty()) {
                // No fields left, remove frontmatter entirely
                let body = body.strip_prefix('\n').unwrap_or(body);
                return body.to_string();
            }
            let mut result = String::from("---\n");
            for line in &owned_lines {
                result.push_str(line);
                result.push('\n');
            }
            result.push_str("---");
            result.push_str(body);
            return result;
        }
    }

    // No existing frontmatter — add one if value is provided
    if let Some(val) = value {
        return format!("---\n{}: {}\n---\n{}", field, val, content);
    }

    content.to_string()
}

pub(crate) fn collect_skill_files(dir: &std::path::Path, max_depth: usize) -> Vec<std::path::PathBuf> {
    fn visit(
        dir: &std::path::Path,
        depth: usize,
        max_depth: usize,
        found: &mut Vec<std::path::PathBuf>,
    ) {
        if depth > max_depth {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                found.push(skill_file);
            } else {
                visit(&path, depth + 1, max_depth, found);
            }
        }
    }

    let mut found = Vec::new();
    let direct = dir.join("SKILL.md");
    if direct.exists() {
        found.push(direct);
        return found;
    }
    visit(dir, 0, max_depth, &mut found);
    found
}

pub(crate) fn skill_display_fields(
    skill_file: &std::path::Path,
) -> (String, String, SkillFrontmatter) {
    let fallback_name = skill_file
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let content = std::fs::read_to_string(skill_file).unwrap_or_default();
    let (fm, body) = parse_skill_frontmatter(&content);

    let name = fm
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback_name);

    let description = fm
        .description
        .clone()
        .filter(|description| !description.trim().is_empty())
        .or_else(|| {
            body.lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim_start_matches('#').trim().to_string())
        })
        .unwrap_or_else(|| name.clone());

    (name, description, fm)
}

pub(crate) fn scan_skill_infos(dir: &std::path::Path, scope: &str) -> Vec<SkillInfo> {
    collect_skill_files(dir, 8)
        .into_iter()
        .map(|skill_file| {
            let (name, description, fm) = skill_display_fields(&skill_file);
            SkillInfo {
                name,
                description,
                path: skill_file.to_string_lossy().to_string(),
                scope: scope.to_string(),
                disable_model_invocation: fm.disable_model_invocation,
                user_invocable: fm.user_invocable,
                allowed_tools: fm.allowed_tools,
                argument_hint: fm.argument_hint,
                model: fm.model,
                context: fm.context,
                agent: fm.agent,
                version: fm.version,
            }
        })
        .collect()
}

pub(crate) fn scan_skill_commands(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
    collect_skill_files(dir, 8)
        .into_iter()
        .map(|skill_file| {
            let (_display_name, description, fm) = skill_display_fields(&skill_file);
            // Claude invokes a skill by its directory name, not an optional
            // human-facing `name` in frontmatter.
            let command_name = skill_file
                .parent()
                .and_then(|path| path.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            UnifiedCommand {
                name: format!("/{}", command_name),
                description,
                source: source.to_string(),
                category: "skill".to_string(),
                has_args: fm.argument_hint.is_some(),
                path: Some(skill_file.to_string_lossy().to_string()),
                immediate: false,
                execution: None,
            }
        })
        .collect()
}

pub(crate) fn dedupe_skill_infos(skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(skills.len());
    for skill in skills {
        let key = format!("{}:{}", skill.scope, skill.name.to_lowercase());
        if seen.insert(key) {
            deduped.push(skill);
        }
    }
    deduped
}

pub(crate) fn dedupe_unified_skill_commands(commands: Vec<UnifiedCommand>) -> Vec<UnifiedCommand> {
    let mut seen_skills = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(commands.len());
    for command in commands {
        if command.category == "skill" {
            let key = format!("{}:{}", command.source, command.name.to_lowercase());
            if !seen_skills.insert(key) {
                continue;
            }
        }
        deduped.push(command);
    }
    deduped
}

/// Scan and return all available skills (global + project)
#[tauri::command]
pub(crate) async fn list_skills(cwd: Option<String>, additional_dirs: Option<Vec<String>>) -> Result<Vec<SkillInfo>, String> {
    let mut skills: Vec<SkillInfo> = vec![];

    // Only Claude's native skill directory is scanned by default. Codex and
    // other agent-specific skills are not necessarily compatible with Claude.
    if let Ok(config_dir) = claude_config_dir() {
        skills.extend(scan_skill_infos(&config_dir.join("skills"), "global"));
    }

    // Project-local Claude skills.
    if let Some(ref cwd_path) = cwd {
        let cwd = std::path::Path::new(cwd_path);
        skills.extend(scan_skill_infos(&cwd.join(".claude").join("skills"), "project"));
    }

    for dir in additional_dirs.unwrap_or_default() {
        let path = std::path::PathBuf::from(dir);
        if path.is_absolute() {
            skills.extend(scan_skill_infos(&path, "global"));
        }
    }

    Ok(dedupe_skill_infos(skills))
}

pub(crate) fn extract_json_array(text: &str) -> Result<Vec<SkillTranslation>, String> {
    if let Ok(parsed) = serde_json::from_str::<Vec<SkillTranslation>>(text.trim()) {
        return Ok(parsed);
    }

    let start = text
        .find('[')
        .ok_or_else(|| "Translation response did not contain a JSON array".to_string())?;
    let end = text
        .rfind(']')
        .ok_or_else(|| "Translation response did not contain a complete JSON array".to_string())?;
    if end <= start {
        return Err("Translation response JSON array was malformed".to_string());
    }

    serde_json::from_str::<Vec<SkillTranslation>>(&text[start..=end])
        .map_err(|e| format!("Cannot parse translation response: {}", e))
}

pub(crate) fn resolve_translation_provider(provider_id: Option<String>) -> Result<ApiProvider, String> {
    let providers_file = load_providers()?;
    let selected_id = provider_id.or(providers_file.active_provider_id.clone());
    let Some(selected_id) = selected_id else {
        return Err("No active provider configured".to_string());
    };

    providers_file
        .providers
        .into_iter()
        .find(|provider| provider.id == selected_id)
        .ok_or_else(|| format!("Provider '{}' not found", selected_id))
}

pub(crate) fn translation_provider_from_config(config: SkillTranslationConfig) -> Result<ApiProvider, String> {
    if config.base_url.trim().is_empty() {
        return Err("Translation API base URL is not configured".to_string());
    }
    if config.api_key.trim().is_empty() {
        return Err("Translation API key is not configured".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("Translation API model is not configured".to_string());
    }

    Ok(ApiProvider {
        id: "skill-translation".to_string(),
        name: "Skill Translation".to_string(),
        base_url: config.base_url,
        api_format: config.api_format,
        api_key: Some(config.api_key),
        model_mappings: vec![ModelMapping {
            tier: "translation".to_string(),
            provider_model: config.model,
        }],
        extra_env: None,
        proxy_url: config.proxy_url,
        preset: None,
        created_at: 0,
        updated_at: 0,
    })
}

pub(crate) fn resolve_translation_model(provider: &ApiProvider) -> String {
    for tier in ["flash", "haiku", "sonnet", "opus", "pro"] {
        if let Some(mapping) = provider
            .model_mappings
            .iter()
            .find(|mapping| mapping.tier.to_lowercase().contains(tier) && !mapping.provider_model.trim().is_empty())
        {
            return normalize_deepseek_model_name(&mapping.provider_model);
        }
    }

    provider
        .model_mappings
        .iter()
        .find(|mapping| !mapping.provider_model.trim().is_empty())
        .map(|mapping| normalize_deepseek_model_name(&mapping.provider_model))
        .unwrap_or_else(|| "deepseek-v4-flash".to_string())
}

// --- Skill translation cache (perf) ---
// Skill docs are re-translated on every preview, so the same SKILL.md hits the
// cache on repeat views. The cache key is content-addressed
// (provider.id | model | source), so identical inputs always return the cached
// translation. Effective hit rate during normal skill browsing approaches ~100%.
// Persisted to disk so it also survives app restarts.

pub(crate) const TRANSLATION_CACHE_META_FILE: &str = "translation-cache-meta.json";
pub(crate) const TRANSLATION_CACHE_MD_FILE: &str = "translation-cache-md.json";

pub(crate) type MetaCache = std::collections::HashMap<String, Vec<SkillTranslation>>;
pub(crate) type MdCache = std::collections::HashMap<String, String>;

pub(crate) static TRANSLATION_CACHE_META: std::sync::OnceLock<std::sync::Mutex<MetaCache>> = std::sync::OnceLock::new();
pub(crate) static TRANSLATION_CACHE_MD: std::sync::OnceLock<std::sync::Mutex<MdCache>> = std::sync::OnceLock::new();

pub(crate) fn load_translation_cache_file<T: serde::de::DeserializeOwned>(name: &str) -> Result<T, String> {
    let path = app_paths::cache_path(name)?;
    if !path.exists() {
        return Err("no cache".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读翻译缓存失败: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析翻译缓存失败: {}", e))
}

pub(crate) fn persist_translation_cache_file<T: serde::Serialize>(name: &str, cache: &T) {
    if let Ok(dir) = app_paths::cache_dir() {
        let path = dir.join(name);
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(&path, json);
        }
    }
}

pub(crate) fn translation_meta_cache() -> &'static std::sync::Mutex<MetaCache> {
    TRANSLATION_CACHE_META.get_or_init(|| {
        std::sync::Mutex::new(
            load_translation_cache_file::<MetaCache>(TRANSLATION_CACHE_META_FILE).unwrap_or_default(),
        )
    })
}

pub(crate) fn translation_md_cache() -> &'static std::sync::Mutex<MdCache> {
    TRANSLATION_CACHE_MD.get_or_init(|| {
        std::sync::Mutex::new(
            load_translation_cache_file::<MdCache>(TRANSLATION_CACHE_MD_FILE).unwrap_or_default(),
        )
    })
}

pub(crate) fn translation_cache_key(provider_id: &str, model: &str, source: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(provider_id.as_bytes());
    hasher.update(b"|");
    hasher.update(model.as_bytes());
    hasher.update(b"|");
    hasher.update(source.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Translate skill names/descriptions through the active third-party provider.
#[tauri::command]
pub(crate) async fn translate_skill_metadata(
    items: Vec<SkillTranslationItem>,
    provider_id: Option<String>,
    config: Option<SkillTranslationConfig>,
) -> Result<Vec<SkillTranslation>, String> {
    if items.is_empty() {
        return Ok(vec![]);
    }

    let provider = match config {
        Some(config) => translation_provider_from_config(config)?,
        None => resolve_translation_provider(provider_id)?,
    };
    let api_key = provider
        .api_key
        .clone()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Active provider has no API key".to_string())?;
    if provider.base_url.trim().is_empty() {
        return Err("Active provider has no base URL".to_string());
    }

    let client = if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.trim().is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                if is_proxy_reachable(proxy_url).await {
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(60))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(60),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(60),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(60),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(60),
        )
        .await
    };

    let model = resolve_translation_model(&provider);
    let compact_items: Vec<SkillTranslationItem> = items
        .into_iter()
        .map(|item| SkillTranslationItem {
            key: item.key,
            name: item.name.chars().take(120).collect(),
            description: item.description.chars().take(800).collect(),
        })
        .collect();
    let items_json = serde_json::to_string(&compact_items)
        .map_err(|e| format!("Cannot serialize translation input: {}", e))?;

    // --- translation cache: identical metadata input → cached result ---
    let cache_key = translation_cache_key(&provider.id, &model, &items_json);
    if let Some(hit) = translation_meta_cache().lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }

    let prompt = format!(
        "Translate these Codex skill metadata entries into concise Simplified Chinese. Preserve every key exactly. Return ONLY a JSON array, no markdown. Each item must have key, name, and description. Keep names short and natural; keep descriptions one sentence when possible.\n\n{}",
        items_json
    );

    let api_format = provider.api_format.to_lowercase();
    let (url, body) = if api_format == "openai" {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": "You are a precise product UI translator."},
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    } else {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    };

    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&body);
    if api_format == "openai" {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    } else {
        request = request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Translation request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!(
            "Cannot read translation response: {}. Check that Base URL is the real API endpoint and Proxy URL is only a network proxy; if a local proxy is used, disable response compression/rewrite or leave Proxy URL empty.",
            e
        ))?;
    if !status.is_success() {
        return Err(format!(
            "Translation API returned HTTP {}: {}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }

    let content = if api_format == "openai" {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_str())
                    .map(|content| content.to_string())
            })
            .ok_or_else(|| "OpenAI translation response had no message content".to_string())?
    } else {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("content")
                    .and_then(|content| content.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| "Anthropic translation response had no text content".to_string())?
    };

    let result = extract_json_array(&content)?;
    {
        let mut cache = translation_meta_cache().lock().unwrap();
        cache.insert(cache_key.clone(), result.clone());
        persist_translation_cache_file(TRANSLATION_CACHE_META_FILE, &*cache);
    }
    Ok(result)
}

/// Translate the full SKILL.md preview text without modifying the source file.
#[tauri::command]
pub(crate) async fn translate_skill_markdown(
    content: String,
    config: SkillTranslationConfig,
) -> Result<String, String> {
    let provider = translation_provider_from_config(config)?;
    let api_key = provider
        .api_key
        .clone()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Translation API key is not configured".to_string())?;

    let client = if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.trim().is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                if is_proxy_reachable(proxy_url).await {
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(120))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(120),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(120),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(120),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(120),
        )
        .await
    };

    let model = resolve_translation_model(&provider);

    // --- translation cache: identical markdown input → cached result ---
    let cache_key = translation_cache_key(&provider.id, &model, &content);
    if let Some(hit) = translation_md_cache().lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }

    let prompt = format!(
        "Translate this Codex SKILL.md into Simplified Chinese for reading in a UI preview. Preserve Markdown structure, headings, lists, tables, frontmatter keys, code fences, inline code, commands, paths, URLs, placeholders, and model/tool names exactly. Translate only human-readable prose. Return ONLY the translated Markdown.\n\n{}",
        content
    );

    let api_format = provider.api_format.to_lowercase();
    let (url, body) = if api_format == "openai" {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": "You are a precise technical translator."},
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    } else {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    };

    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&body);
    if api_format == "openai" {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    } else {
        request = request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Translation request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!(
            "Cannot read translation response: {}. Check that Base URL is the real API endpoint and Proxy URL is only a network proxy; if a local proxy is used, disable response compression/rewrite or leave Proxy URL empty.",
            e
        ))?;
    if !status.is_success() {
        return Err(format!(
            "Translation API returned HTTP {}: {}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }

    let result = if api_format == "openai" {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_str())
                    .map(|content| content.trim().to_string())
            })
            .filter(|content| !content.is_empty())
            .ok_or_else(|| "OpenAI translation response had no message content".to_string())
    } else {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("content")
                    .and_then(|content| content.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty())
            .ok_or_else(|| "Anthropic translation response had no text content".to_string())
    };
    let translated = result?;
    {
        let mut cache = translation_md_cache().lock().unwrap();
        cache.insert(cache_key.clone(), translated.clone());
        persist_translation_cache_file(TRANSLATION_CACHE_MD_FILE, &*cache);
    }
    Ok(translated)
}

/// Read a skill file and return its content
#[tauri::command]
pub(crate) async fn read_skill(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read skill file: {}", e))
}

/// Write content to a skill file, creating parent directories if needed
#[tauri::command]
pub(crate) async fn write_skill(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write skill file: {}", e))
}

/// Delete a skill file; remove the parent directory if it becomes empty
#[tauri::command]
pub(crate) async fn delete_skill(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    std::fs::remove_file(p).map_err(|e| format!("Failed to delete skill file: {}", e))?;

    // If the parent directory is now empty, remove it too
    if let Some(parent) = p.parent() {
        if parent.is_dir() {
            let is_empty = std::fs::read_dir(parent)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if is_empty {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    Ok(())
}

/// Unified endpoint that returns all commands and skills in a single call
#[tauri::command]
pub(crate) async fn list_all_commands(cwd: Option<String>, additional_dirs: Option<Vec<String>>) -> Result<Vec<UnifiedCommand>, String> {
    let mut commands: Vec<UnifiedCommand> = vec![];

    // 1. Built-in commands: (name, description, has_args, execution)
    // execution: "ui" = handled in frontend, "cli" = run as separate CLI process, "session" = needs active CLI session
    let builtins: [(&str, &str, bool, &str); 24] = [
        ("/ask", "Ask a question without making changes", false, "ui"),
        ("/bug", "Report a bug with Claude Code", false, "ui"),
        (
            "/bypass",
            "Switch to bypass mode (skip all permission prompts)",
            false,
            "ui",
        ),
        ("/clear", "Clear conversation history", false, "ui"),
        ("/code", "Switch to code mode (default)", false, "ui"),
        (
            "/compact",
            "Compact conversation to reduce context",
            false,
            "session",
        ),
        (
            "/context",
            "Manage context files and directories",
            false,
            "session",
        ),
        ("/cost", "Show session cost and token usage", false, "ui"),
        (
            "/doctor",
            "Check Claude Code health status",
            false,
            "session",
        ),
        ("/export", "Export conversation to markdown", true, "ui"),
        ("/help", "Show available commands", false, "ui"),
        (
            "/init",
            "Initialize project configuration",
            false,
            "session",
        ),
        ("/mcp", "Manage MCP server connections", false, "session"),
        ("/memory", "View or edit MEMORY.md files", false, "session"),
        (
            "/permissions",
            "View and manage tool permissions",
            false,
            "session",
        ),
        ("/plan", "Enter plan mode for complex tasks", false, "ui"),
        ("/rename", "Rename the current session", true, "ui"),
        (
            "/rewind",
            "Rewind conversation to a previous turn",
            false,
            "ui",
        ),
        ("/stats", "Show session statistics", false, "session"),
        (
            "/statusline",
            "Configure status line display",
            false,
            "session",
        ),
        ("/tasks", "View running background tasks", false, "session"),
        (
            "/teleport",
            "Teleport context to a new session",
            false,
            "session",
        ),
        (
            "/todos",
            "View todo items from the session",
            false,
            "session",
        ),
        ("/usage", "Show detailed token usage breakdown", false, "ui"),
    ];
    for (name, desc, has_args, execution) in &builtins {
        commands.push(UnifiedCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "builtin".to_string(),
            category: "builtin".to_string(),
            has_args: *has_args,
            path: None,
            immediate: true,
            execution: Some(execution.to_string()),
        });
    }

    // Helper: scan a directory for .md command files
    fn scan_commands_dir(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
        let mut cmds = vec![];
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return cmds,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "md") {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let name = format!("/{}", stem);

                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let description = content
                    .lines()
                    .next()
                    .map(|line| line.trim_start_matches('#').trim().to_string())
                    .unwrap_or_else(|| stem.clone());
                let has_args = content.contains("$ARGUMENTS");

                cmds.push(UnifiedCommand {
                    name,
                    description,
                    source: source.to_string(),
                    category: "command".to_string(),
                    has_args,
                    path: None,
                    immediate: false,
                    execution: None,
                });
            }
        }
        cmds
    }

    // 2. Global custom commands: ~/.claude/commands/*.md
    if let Ok(config_dir) = claude_config_dir() {
        let global_dir = config_dir.join("commands");
        commands.extend(scan_commands_dir(&global_dir, "global"));
    }

    // 3. Project custom commands: {cwd}/.claude/commands/*.md
    if let Some(ref cwd_path) = cwd {
        let project_dir = std::path::Path::new(cwd_path)
            .join(".claude")
            .join("commands");
        commands.extend(scan_commands_dir(&project_dir, "project"));
    }

    // 4. Global Claude skills only.
    if let Ok(config_dir) = claude_config_dir() {
        commands.extend(scan_skill_commands(&config_dir.join("skills"), "global"));
    }

    // 5. Project-local Claude skills.
    if let Some(ref cwd_path) = cwd {
        let cwd = std::path::Path::new(cwd_path);
        commands.extend(scan_skill_commands(&cwd.join(".claude").join("skills"), "project"));
    }

    // 6. User-selected compatible skill roots.
    for dir in additional_dirs.unwrap_or_default() {
        let path = std::path::PathBuf::from(dir);
        if path.is_absolute() {
            commands.extend(scan_skill_commands(&path, "global"));
        }
    }

    Ok(dedupe_unified_skill_commands(commands))
}

/// Toggle a skill's enabled/disabled state by writing/removing
/// `disable-model-invocation` in its YAML frontmatter.
#[tauri::command]
pub(crate) async fn toggle_skill_enabled(path: String, enabled: bool) -> Result<(), String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read skill file: {}", e))?;
    let new_content = if enabled {
        // Remove disable-model-invocation (or set to false)
        update_frontmatter_field(&content, "disable-model-invocation", None)
    } else {
        // Set disable-model-invocation: true
        update_frontmatter_field(&content, "disable-model-invocation", Some("true"))
    };
    std::fs::write(&path, &new_content).map_err(|e| format!("Cannot write skill file: {}", e))
}

