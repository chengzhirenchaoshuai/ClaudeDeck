//! 应用内网页预览与独立浏览窗口。

use crate::*;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum PreviewCommand {
    Open { url: String },
    Refresh,
    Back,
    Forward,
}

pub(crate) fn normalize_preview_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Preview URL is empty".to_string());
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:")
        || lower.starts_with("data:")
        || lower.starts_with("about:")
    {
        return Ok(trimmed.to_string());
    }
    if lower.starts_with("localhost")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("[::1]")
    {
        return Ok(format!("http://{}", trimmed));
    }
    Ok(format!("https://{}", trimmed))
}

pub(crate) fn emit_preview_command(app: &AppHandle, command: PreviewCommand) -> Result<(), String> {
    app.emit("tokenicode-preview-command", command)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn preview_open_url(app: AppHandle, url: String) -> Result<String, String> {
    let normalized = normalize_preview_url(&url)?;
    emit_preview_command(
        &app,
        PreviewCommand::Open {
            url: normalized.clone(),
        },
    )?;
    Ok(normalized)
}

#[tauri::command]
pub(crate) async fn preview_refresh(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Refresh)
}

#[tauri::command]
pub(crate) async fn preview_back(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Back)
}

#[tauri::command]
pub(crate) async fn preview_forward(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Forward)
}

/// 在应用内的独立浏览窗口中打开外部网页。由后端创建是为了指定和主窗口相同的
/// WebView 数据目录——前端 JS 接口无法指定，会在默认位置另建一份数据。
#[tauri::command]
pub(crate) async fn open_browser_window(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("无效的网址: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 http/https 网址".to_string());
    }
    let label = format!("browser-{}", uuid::Uuid::new_v4().simple());
    let data_dir = app_paths::webview_dir()?;
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title(&url)
        .inner_size(1100.0, 760.0)
        .center()
        .data_directory(data_dir)
        .build()
        .map(|w| crate::app_icon::apply(&w))
        .map_err(|e| format!("打开浏览窗口失败: {}", e))
}
