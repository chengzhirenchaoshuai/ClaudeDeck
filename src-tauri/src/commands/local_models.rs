//! 本地模型（Ollama）：服务检测、模型列表与拉取。

use crate::*;

#[derive(Serialize)]
pub(crate) struct LocalModelInfo {
    pub(crate) name: String,
    pub(crate) id: String,
    pub(crate) size: String,
    pub(crate) modified: String,
}

#[derive(Serialize)]
pub(crate) struct LocalModelServiceStatus {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
    pub(crate) models: Vec<LocalModelInfo>,
    pub(crate) error: Option<String>,
}

pub(crate) async fn run_ollama(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("ollama");
    cmd.args(args);
    // Windows 上不创建控制台窗口，否则每次调用都会闪出一个黑框
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run ollama: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        let msg = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        Err(if msg.is_empty() {
            format!("ollama exited with {}", output.status)
        } else {
            msg
        })
    }
}

pub(crate) async fn read_ollama_version() -> Result<(Option<String>, Option<String>), String> {
    let mut cmd = Command::new("ollama");
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run ollama: {}", e))?;

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = combined
        .lines()
        .find(|line| line.to_lowercase().contains("version"))
        .map(|line| line.trim().to_string());
    let error = if output.status.success() {
        None
    } else {
        let msg = combined.trim().to_string();
        if msg.is_empty() {
            Some(format!("ollama exited with {}", output.status))
        } else {
            Some(msg)
        }
    };

    Ok((version, error))
}

pub(crate) fn parse_ollama_list(output: &str) -> Vec<LocalModelInfo> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            let cols: Vec<&str> = trimmed.split_whitespace().collect();
            if cols.len() < 4 {
                return None;
            }

            Some(LocalModelInfo {
                name: cols[0].to_string(),
                id: cols[1].to_string(),
                size: format!("{} {}", cols[2], cols[3]),
                modified: if cols.len() > 4 {
                    cols[4..].join(" ")
                } else {
                    String::new()
                },
            })
        })
        .collect()
}

pub(crate) fn validate_ollama_model_name(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Model name is required".to_string());
    }
    if model.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Model name must not contain spaces or control characters".to_string());
    }
    Ok(model.to_string())
}

#[tauri::command]
pub(crate) async fn check_local_model_service() -> Result<LocalModelServiceStatus, String> {
    let (version, version_error) = match read_ollama_version().await {
        Ok(result) => result,
        Err(e) => {
            return Ok(LocalModelServiceStatus {
                installed: false,
                version: None,
                models: vec![],
                error: Some(e),
            });
        }
    };

    match run_ollama(&["list"]).await {
        Ok(list) => Ok(LocalModelServiceStatus {
            installed: true,
            version,
            models: parse_ollama_list(&list),
            error: None,
        }),
        Err(e) => Ok(LocalModelServiceStatus {
            installed: true,
            version,
            models: vec![],
            error: Some(version_error.unwrap_or(e)),
        }),
    }
}

#[tauri::command]
pub(crate) async fn list_local_models() -> Result<Vec<LocalModelInfo>, String> {
    let output = run_ollama(&["list"]).await?;
    Ok(parse_ollama_list(&output))
}

#[tauri::command]
pub(crate) async fn pull_local_model(app: AppHandle, model: String) -> Result<(), String> {
    let model = validate_ollama_model_name(&model)?;
    let mut pull_cmd = Command::new("ollama");
    pull_cmd
        .arg("pull")
        .arg(&model)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    pull_cmd.creation_flags(0x08000000);
    let mut child = pull_cmd
        .spawn()
        .map_err(|e| format!("Failed to start ollama pull: {}", e))?;

    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let model = model.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "local-model:pull-progress",
                    serde_json::json!({ "model": model, "stream": "stdout", "line": strip_ansi(&line) }),
                );
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let model = model.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "local-model:pull-progress",
                    serde_json::json!({ "model": model, "stream": "stderr", "line": strip_ansi(&line) }),
                );
            }
        }));
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ollama pull failed: {}", e))?;
    for reader in readers {
        let _ = reader.await;
    }

    if status.success() {
        let _ = app.emit(
            "local-model:pull-progress",
            serde_json::json!({ "model": model, "stream": "status", "line": "complete" }),
        );
        Ok(())
    } else {
        Err(format!("ollama pull exited with {}", status))
    }
}
