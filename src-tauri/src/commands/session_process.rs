//! 会话进程命令：启动 CLI 会话（start_claude_session）、写 stdin、权限响应与控制请求、终止与退出时有序关闭。

use crate::*;

#[tauri::command]
pub(crate) async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    params: StartSessionParams,
) -> Result<SessionInfo, String> {
    let session_id = params
        .session_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Clean up any existing process with the same session_id
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;

    // Use persistent stream-json input mode instead of per-message -p mode.
    // This keeps the CLI process alive so slash commands (/rewind, /compact, /cost, etc.) work.
    let mut args = vec![
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--replay-user-messages".to_string(),
    ];

    // 默认跳过全部 MCP 服务器以加快冷启动：MCP 服务器（chrome-devtools、codex 等）
    // 需要逐个初始化，CLI 才会接受输入，可能多出 20-30 秒。
    // 用户在“MCP 服务器”页打开“会话中加载 MCP”后，按 CLI 自身的配置加载。
    if !params.enable_mcp.unwrap_or(false) {
        args.push("--strict-mcp-config".to_string());
    }

    // Resume an existing CLI session if requested
    if let Some(ref resume_id) = params.resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
        // 回退：续接到指定消息并分叉出新会话，模型只会记得该消息（含）之前的历史
        if let Some(ref at) = params.resume_session_at {
            if !at.is_empty() && at.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                args.push("--resume-session-at".to_string());
                args.push(at.clone());
                args.push("--fork-session".to_string());
            }
        }
    }

    if let Some(ref model) = params.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    if let Some(ref tools) = params.allowed_tools {
        for tool in tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }

    // Permission mode: all modes use --permission-prompt-tool stdio so the CLI
    // routes user interactions (AskUserQuestion, ExitPlanMode) via control_request.
    // In bypassPermissions mode the CLI auto-approves tool permissions internally
    // (zero overhead) but still sends control_requests for user interactions.
    let permission_mode = params.permission_mode.as_deref().unwrap_or("default");
    args.push("--permission-mode".to_string());
    args.push(permission_mode.to_string());
    args.push("--permission-prompt-tool".to_string());
    args.push("stdio".to_string());

    // 远程项目（cwd 为 ssh://<主机>/<路径>）：经 ssh 在远端运行 claude，使用远端自己的配置。
    // 不注入本机 Provider 环境变量与模型映射，也不需要本机的 claude / git-bash。
    // 挪到 --settings 构造之前：下面要根据是不是远程决定要不要加 statusLine 钩子
    // （钩子指向本机的 claudedeck.exe 路径，对远程主机毫无意义，不能带过去）。
    let remote_target = commands::remote::parse_remote_uri(&params.cwd);

    // Extended thinking + effort level
    let thinking_level = params.thinking_level.as_deref().unwrap_or("high");
    let mut settings_obj = serde_json::json!({
        "alwaysThinkingEnabled": thinking_level != "off",
    });
    // 5 小时 / 7 天用量只有 claude.ai Pro/Max 账户才有，CLI 不会主动通过
    // stream-json 的 rate_limit_event 可靠地带上具体百分比（不同版本字段不一样，
    // 部分版本干脆没有）。官方文档里唯一稳定带百分比的渠道是 statusLine 钩子：
    // CLI 每次助手回复后会调用这个命令，把包含 rate_limits.five_hour/seven_day
    // .used_percentage 的完整会话状态 JSON 喂给它。这里让 claudedeck.exe 自己
    // 兼任这个钩子（--statusline-write，见 main.rs），把摘出来的 rate_limits
    // 写到本地文件，前端再通过 get_session_rate_limits 读取。只对本机会话生效——
    // 远程主机上没有这个可执行文件，钩子指过去也跑不起来。
    if remote_target.is_none() {
        if let Ok(exe) = std::env::current_exe() {
            // 官方文档明确写了：Windows 上 statusLine 命令是通过 Git Bash（装了的话）
            // 或者 PowerShell 跑的；Git Bash 会把不在引号保护范围内的反斜杠当成转义符，
            // 路径分隔符直接被吃掉，命令静默失败、什么错误都不会冒出来——这正是钩子
            // 完全没生效、5h/7d 用量彻底不显示的真正原因。文档给的解决办法就是路径统一用
            // 正斜杠，Windows 的 CreateProcess/PowerShell/Git Bash 三边都认，不需要纠结
            // 引号规则。
            let exe_str = exe.display().to_string().replace('\\', "/");
            settings_obj["statusLine"] = serde_json::json!({
                "type": "command",
                "command": format!("\"{}\" --statusline-write", exe_str),
            });
        }
    }
    args.push("--settings".to_string());
    args.push(settings_obj.to_string());
    let (mut child, claude_bin, env_count) = if let Some((host_id, remote_path)) = remote_target {
        let host = commands::remote::find_host(&host_id)?;
        // 去掉本机专用的参数：--strict-mcp-config（远端沿用自己的 MCP 配置）、
        // --model（本机的模型映射对远端无意义，由远端配置决定）
        let mut remote_args: Vec<String> = Vec::new();
        let mut iter = args.iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--strict-mcp-config" => {}
                "--model" => {
                    iter.next();
                }
                _ => remote_args.push(arg.clone()),
            }
        }
        let effort = thinking_level.to_string();
        let mut remote_env: Vec<(&str, &str)> = vec![
            ("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1"),
            ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "64000"),
        ];
        if thinking_level != "off" {
            remote_env.push(("CLAUDE_CODE_EFFORT_LEVEL", effort.as_str()));
        }
        let remote_cmd = commands::remote::build_remote_claude_command(
            &remote_path,
            &remote_env,
            &remote_args,
        )?;
        let mut cmd = commands::remote::ssh_command(&host);
        cmd.arg(&remote_cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start ssh (is OpenSSH client installed?): {}", e))?;
        (child, format!("ssh:{}", host_id), remote_env.len())
    } else {
        // Resolve claude binary — it may not be on the default PATH
        let claude_bin = find_claude_binary().unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                "claude.cmd".to_string()
            }
            #[cfg(not(target_os = "windows"))]
            {
                "claude".to_string()
            }
        });

        // Build an enriched PATH for the child process
        let enriched_path = build_enriched_path();

        // Resolve provider environment variables from provider_id
        let (mut resolved_env, inherited_keys_to_remove, provider_extra_args) =
            resolve_provider_env(params.provider_id.as_deref())?;

        // Append provider-specific CLI args (e.g. --setting-sources project,local)
        args.extend(provider_extra_args);

        // Inject effort level env var for non-off thinking levels
        if thinking_level != "off" {
            resolved_env.insert(
                "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
                thinking_level.to_string(),
            );
        }

        // Raise the per-turn output token cap from the CLI default (32K) to 64K.
        // This prevents "response exceeded the 32000 output token maximum" errors
        // when generating large files (e.g. HTML presentations).
        resolved_env
            .entry("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string())
            .or_insert_with(|| "64000".to_string());

        // Enable CLI-managed file checkpoints for rewind functionality.
        // With --replay-user-messages, user messages in stream output carry a uuid
        // that identifies the checkpoint. The rewind_files command uses these UUIDs.
        resolved_env.insert(
            "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".to_string(),
            "1".to_string(),
        );

        // For long-context third-party routes, override Claude Code's internal compact window.
        // Some provider model names do not expose a 1M marker, so the frontend can declare it.
        let declared_context_window = params.context_window.unwrap_or_else(|| {
            params.model.as_deref().map(|model_name| {
                let m = model_name.to_lowercase();
                if m.contains("mimo") || m.contains("[1m]") { 1_000_000 } else { 200_000 }
            }).unwrap_or(200_000)
        });
        if declared_context_window >= 1_000_000 {
            resolved_env.insert(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
                declared_context_window.to_string(),
            );
            eprintln!(
                "[ClaudeDeck] Set CLAUDE_CODE_AUTO_COMPACT_WINDOW={} for model {:?}",
                declared_context_window,
                params.model
            );
        }

        // On Windows, disable MSYS2/Git Bash automatic path conversion.
        // Without this, MSYS2 converts Windows paths (e.g. F:\秀\input\file.xlsx)
        // to Unix-style paths (/f/秀/input/file.xlsx), which breaks file operations
        // especially with non-ASCII (Chinese) characters in paths.
        #[cfg(target_os = "windows")]
        {
            resolved_env.entry("MSYS_NO_PATHCONV".to_string())
                .or_insert_with(|| "1".to_string());
            resolved_env.entry("MSYS2_ARG_CONV_EXCL".to_string())
                .or_insert_with(|| "*".to_string());
        }

        // On Windows, auto-detect git-bash and inject CLAUDE_CODE_GIT_BASH_PATH
        // so Claude Code CLI can find bash.exe without user manual configuration.
        #[cfg(target_os = "windows")]
        {
            if !resolved_env.contains_key("CLAUDE_CODE_GIT_BASH_PATH") {
                if let Some(bash_path) = find_git_bash() {
                    resolved_env.insert("CLAUDE_CODE_GIT_BASH_PATH".to_string(), bash_path);
                } else {
                    // git-bash is a hard requirement for Claude Code on Windows.
                    // Fail fast with a clear error instead of spawning and getting a silent exit.
                    return Err("Claude Code requires Git Bash on Windows.\n\
                         Please reinstall Claude Code via Settings to auto-install Git,\n\
                         or install Git for Windows manually: https://git-scm.com/downloads/win"
                        .to_string());
                }
            }
        }

        // Auto-detect and inject proxy env vars into CLI subprocess.
        // GUI apps launched from Finder/Dock don't inherit shell proxy settings.
        // Detection order: login shell > macOS system proxy > local port probing.
        #[cfg(not(target_os = "windows"))]
        {
            let proxy_env = login_shell_proxy_env();
            for (k, v) in proxy_env {
                if !resolved_env.contains_key(k) && std::env::var(k).is_err() {
                    resolved_env.insert(k.clone(), v.clone());
                }
            }
        }

        // If still no proxy env vars, try system proxy + port probing
        {
            let has_proxy = resolved_env.keys().any(|k| {
                let kl = k.to_lowercase();
                kl == "https_proxy" || kl == "http_proxy" || kl == "all_proxy"
            });
            if !has_proxy {
                // resolve_proxy_url checks: process env > system proxy > login shell > port probing
                if let Some(url) = resolve_proxy_url() {
                    for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
                        resolved_env.insert(key.to_string(), url.clone());
                    }
                    if url.starts_with("socks") {
                        resolved_env.insert("all_proxy".to_string(), url.clone());
                        resolved_env.insert("ALL_PROXY".to_string(), url.clone());
                    }
                }
            }
        }

        // On Windows, .cmd/.bat files must be launched via cmd /C
        #[cfg(target_os = "windows")]
        let child = {
            // Helper: build and spawn a Command for the given binary
            let spawn_win = |bin: &str| {
                let needs_cmd = bin.ends_with(".cmd")
                    || bin.ends_with(".bat")
                    || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'));
                let mut cmd = if needs_cmd {
                    let mut c = Command::new("cmd");
                    c.arg("/C").arg(bin);
                    c
                } else {
                    Command::new(bin)
                };
                cmd.args(&args)
                    .current_dir(&params.cwd)
                    .env("PATH", &enriched_path)
                    .env_remove("CLAUDECODE");
                for key in &inherited_keys_to_remove {
                    cmd.env_remove(key);
                }
                for (key, value) in &resolved_env {
                    cmd.env(key, value);
                }
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .creation_flags(0x08000000)
                    .spawn()
            };

            match spawn_win(&claude_bin) {
                Ok(c) => c,
                Err(e) if e.raw_os_error() == Some(193) => {
                    // Error 193: not a valid Win32 application — binary is corrupt.
                    // Clean up the bad binary and try to find an alternative.
                    eprintln!("error 193 on '{}', cleaning up and retrying...", claude_bin);
                    if let Some(cli_dir) = cli_download_dir() {
                        let suspect = cli_dir.join("claude.exe");
                        if suspect.exists() {
                            let _ = std::fs::remove_file(&suspect);
                        }
                    }
                    let alt_bin = find_claude_binary().unwrap_or_else(|| "claude.cmd".to_string());
                    if alt_bin == claude_bin {
                        return Err(format!(
                            "Failed to spawn claude (tried '{}'): {}",
                            claude_bin, e
                        ));
                    }
                    eprintln!("Retrying with alternative: {}", alt_bin);
                    spawn_win(&alt_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}' then '{}'): {}",
                            claude_bin, alt_bin, e2
                        )
                    })?
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let child = {
            let spawn_unix = |bin: &str| -> std::io::Result<tokio::process::Child> {
                let mut cmd = Command::new(bin);
                cmd.args(&args)
                    .current_dir(&params.cwd)
                    .env("PATH", &enriched_path)
                    // Clear CLAUDECODE env var so the CLI doesn't refuse to start
                    // when ClaudeDeck itself is launched from within a Claude Code session.
                    .env_remove("CLAUDECODE");
                // Clear inherited ANTHROPIC_* env vars that conflict with our overrides
                for key in &inherited_keys_to_remove {
                    cmd.env_remove(key);
                }
                // Inject custom API provider env vars
                for (key, value) in &resolved_env {
                    cmd.env(key, value);
                }
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
            };

            match spawn_unix(&claude_bin) {
                Ok(c) => c,
                Err(e) if e.raw_os_error() == Some(13) => {
                    // EACCES
                    // Permission denied — attempt to fix execute permission and retry.
                    eprintln!(
                        "EACCES on '{}', attempting chmod +x and retrying...",
                        claude_bin
                    );
                    let path = std::path::Path::new(&claude_bin);
                    let fixed = (|| -> Result<(), std::io::Error> {
                        use std::os::unix::fs::PermissionsExt;
                        let metadata = std::fs::metadata(path)?;
                        let mut perms = metadata.permissions();
                        perms.set_mode(perms.mode() | 0o755);
                        std::fs::set_permissions(path, perms)?;
                        Ok(())
                    })();
                    if let Err(chmod_err) = fixed {
                        eprintln!("chmod +x failed: {}", chmod_err);
                        return Err(format!(
                            "Failed to spawn claude (tried '{}', permission denied, chmod fix also failed: {}): {}",
                            claude_bin, chmod_err, e
                        ));
                    }
                    eprintln!("chmod +x succeeded, retrying spawn...");
                    spawn_unix(&claude_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}', retried after chmod +x): {}",
                            claude_bin, e2
                        )
                    })?
                }
                Err(e) if e.raw_os_error() == Some(88) || e.raw_os_error() == Some(8) => {
                    // ENOEXEC (88 on macOS, 8 on Linux) — Malformed binary.
                    // Delete the corrupt binary and try to find an alternative.
                    eprintln!(
                        "ENOEXEC on '{}' (malformed binary), cleaning up and retrying...",
                        claude_bin
                    );
                    if let Some(cli_dir) = cli_download_dir() {
                        let suspect = cli_dir.join("claude");
                        if suspect.exists() {
                            let _ = std::fs::remove_file(&suspect);
                            eprintln!("Removed corrupt binary: {:?}", suspect);
                        }
                    }
                    let alt_bin = find_claude_binary().unwrap_or_else(|| "claude".to_string());
                    if alt_bin == claude_bin {
                        return Err(format!(
                            "Failed to spawn claude (tried '{}', binary is malformed/corrupt — \
                             please reinstall CLI from Settings): {}",
                            claude_bin, e
                        ));
                    }
                    eprintln!("Retrying with alternative: {}", alt_bin);
                    spawn_unix(&alt_bin).map_err(|e2| {
                        format!(
                            "Failed to spawn claude (tried '{}' then '{}'): {}",
                            claude_bin, alt_bin, e2
                        )
                    })?
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
            }
        };
        (child, claude_bin, resolved_env.len())
    };

    let pid = child.id().unwrap_or(0);
    eprintln!(
        "[ClaudeDeck] CLI spawned: pid={}, bin={}, permission_mode={}",
        pid, claude_bin, permission_mode
    );
    // Never log subprocess arguments, PATH, or environment values: provider
    // API keys and proxy credentials may be present in those values.
    eprintln!(
        "[ClaudeDeck] runtime config: args={}, env_keys={}",
        args.len(),
        env_count
    );
    eprintln!("[ClaudeDeck] cwd: {}", &params.cwd);

    // Capture stdin and store in StdinManager for sending follow-up messages
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    stdin_mgr.insert(session_id.clone(), stdin).await;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let sid = session_id.clone();

    state
        .insert(
            sid.clone(),
            ManagedProcess {
                child,
                session_id: sid.clone(),
            },
        )
        .await;

    // Helper: emit to the main webview using emit_to for reliable delivery
    fn emit_to_frontend(app: &AppHandle, event: &str, payload: Value) -> Result<(), String> {
        if let Err(e1) = app.emit_to("main", event, payload.clone()) {
            // Fallback: use global emit
            if let Err(e2) = app.emit(event, payload) {
                return Err(format!("emit_to failed: {}, emit failed: {}", e1, e2));
            }
        }
        Ok(())
    }

    // Spawn stdout reader — streams NDJSON to frontend, intercepts control_request
    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let stdin_clone = stdin_mgr.inner().clone();
    let is_bypass = permission_mode == "bypassPermissions";
    tokio::spawn(async move {
        let stream_event = format!("claude:stream:{}", sid_clone);
        // Use a large buffer (1MB) to efficiently read large NDJSON lines from Claude CLI.
        // Default 8KB buffer causes thousands of syscalls for large outputs (e.g. 24.8MB PDF),
        // which stalls on Windows pipes. 1MB buffer reduces syscalls by ~125x.
        let mut reader = BufReader::with_capacity(1024 * 1024, stdout);
        let mut line_count: u64 = 0;
        let mut emit_fail_count: u32 = 0;
        let spawn_time = std::time::Instant::now();
        loop {
            // 按字节读、lossy 转换，理由同 stderr 读取那边：不能因为某一行不是合法
            // UTF-8（理论上不该发生，但防御性地保证一次坏数据不会让整条流从此死掉）
            // 就让 .lines() 直接报错终止，之后所有正常输出也读不到了。
            let mut buf: Vec<u8> = Vec::new();
            let line = match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,  // normal EOF
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                        buf.pop();
                    }
                    String::from_utf8_lossy(&buf).into_owned()
                }
                Err(e) => {
                    eprintln!("[ClaudeDeck:CRITICAL] stdout read error after {} lines: {}", line_count, e);
                    break;
                }
            };
            line_count += 1;
            // Parse every line as a JSON Value first (avoids serde enum pitfalls)
            let json = match serde_json::from_str::<Value>(&line) {
                Ok(v) => v,
                Err(_) => continue, // skip non-JSON lines
            };
            // Keep startup diagnostics without persisting prompts, responses,
            // thinking text, tool input, or other user data in application logs.
            if line_count <= 10 {
                eprintln!(
                    "[ClaudeDeck:stdout] #{} @{}ms type={} subtype={} bytes={}",
                    line_count,
                    spawn_time.elapsed().as_millis(),
                    json.get("type").and_then(|v| v.as_str()).unwrap_or("?"),
                    json.get("subtype").and_then(|v| v.as_str()).unwrap_or("-"),
                    line.len(),
                );
            }

            // Intercept control_request messages for SDK control protocol routing.
            // All modes use --permission-prompt-tool stdio. In bypass mode, we
            // auto-approve tool permissions here (zero frontend overhead) but route
            // user interactions (AskUserQuestion) to the frontend.
            if let Some("control_request") = json.get("type").and_then(|v| v.as_str()) {
                let request_id = json
                    .get("request_id")
                    .or_else(|| json.get("requestId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(request) = json.get("request") {
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();

                    // Bypass mode: auto-approve everything except user interactions.
                    if is_bypass {
                        let tool_name = request
                            .get("tool_name")
                            .or_else(|| request.get("toolName"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if tool_name != "AskUserQuestion" {
                            let mut allow = serde_json::json!({ "behavior": "allow" });
                            if subtype == "can_use_tool" {
                                allow["updatedInput"] = request
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Object(serde_json::Map::new()));
                                if let Some(id) = request
                                    .get("tool_use_id")
                                    .or_else(|| request.get("toolUseId"))
                                    .and_then(|v| v.as_str())
                                {
                                    allow["toolUseID"] = Value::String(id.to_string());
                                }
                            }
                            let resp = serde_json::json!({
                                "type": "control_response",
                                "response": { "subtype": "success", "request_id": request_id, "response": allow }
                            });
                            let _ = stdin_clone.send(&sid_clone, &resp.to_string()).await;
                            continue;
                        }
                        // AskUserQuestion: fall through to frontend routing
                    }

                    match subtype {
                        "can_use_tool" => {
                            let tool_name = request
                                .get("tool_name")
                                .or_else(|| request.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input = request.get("input").cloned().unwrap_or(Value::Null);
                            let description = request
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let tool_use_id = request
                                .get("tool_use_id")
                                .or_else(|| request.get("toolUseId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);

                            eprintln!(
                                "[ClaudeDeck] permission request: tool={} request_id={}",
                                tool_name, request_id
                            );

                            // Emit as a special stream message (reuses the working stream channel)
                            let perm_payload = serde_json::json!({
                                "type": "tokenicode_permission_request",
                                "request_id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "description": description,
                                "tool_use_id": tool_use_id,
                            });
                            let _ = emit_to_frontend(&app_clone, &stream_event, perm_payload);
                            continue; // Don't forward to stream as normal msg
                        }
                        "hook_callback" => {
                            // Auto-allow hook callbacks (ClaudeDeck doesn't manage hooks)
                            let auto_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "allow" }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                            continue;
                        }
                        other => {
                            // Unknown control request subtype — deny by default (P0-4 fix)
                            eprintln!("[ClaudeDeck] control_request/{}: denying unknown subtype (request_id={})", other, request_id);
                            let deny_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "deny", "message": format!("Unknown permission type '{}' denied by ClaudeDeck", other) }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &deny_resp.to_string()).await;
                            continue;
                        }
                    }
                } else {
                    eprintln!(
                        "[ClaudeDeck] control_request missing 'request' field: {}",
                        &line[..line.len().min(200)]
                    );
                    // Auto-allow to avoid blocking CLI
                    let auto_resp = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": { "behavior": "allow" }
                        }
                    });
                    let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                    continue;
                }
            }

            // Normal message — forward to frontend stream.
            // For very large messages (e.g. PDF content, large file reads), truncate the
            // content before sending through Tauri IPC to avoid freezing the WebView.
            // Claude CLI already has the full content internally; the frontend only needs
            // a preview for display purposes.
            let json_to_emit = {
                let serialized_len = line.len();
                const MAX_IPC_BYTES: usize = 2 * 1024 * 1024; // 2MB threshold
                if serialized_len > MAX_IPC_BYTES {
                    let mut truncated = json.clone();
                    // Truncate content in tool_result blocks and message content
                    if let Some(content) = truncated.get_mut("content") {
                        truncate_large_content(content, MAX_IPC_BYTES / 2);
                    }
                    if let Some(msg) = truncated.get_mut("message") {
                        if let Some(content) = msg.get_mut("content") {
                            truncate_large_content(content, MAX_IPC_BYTES / 2);
                        }
                    }
                    truncated
                } else {
                    json
                }
            };
            if let Err(e) = emit_to_frontend(&app_clone, &stream_event, json_to_emit) {
                emit_fail_count += 1;
                eprintln!("[ClaudeDeck] emit_to_frontend failed (#{emit_fail_count}): {e}");
                // If emit fails repeatedly, the frontend is likely unreachable.
                // Break the loop to trigger process_exit cleanup (#64).
                if emit_fail_count >= 10 {
                    eprintln!("[ClaudeDeck:CRITICAL] {} consecutive emit failures — frontend unreachable, stopping stream", emit_fail_count);
                    break;
                }
            } else {
                emit_fail_count = 0;  // reset on success
            }
        }
        // Emit process_exit on the stream channel (primary detection)
        let _ = emit_to_frontend(
            &app_clone,
            &stream_event,
            serde_json::json!({"type": "process_exit"}),
        );
        // Also emit on the dedicated exit channel (backup detection via onSessionExit)
        let _ = emit_to_frontend(
            &app_clone,
            &format!("claude:exit:{}", sid_clone),
            serde_json::json!(null),
        );

        // Notify frontend that session list may have changed
        let _ = emit_to_frontend(&app_clone, "sessions:changed", serde_json::json!(null));
    });

    // Spawn stderr reader
    let app_clone2 = app.clone();
    let sid_clone2 = sid.clone();
    tokio::spawn(async move {
        // 不用 .lines()：它按 UTF-8 解码，一旦某一行不是合法 UTF-8（远程主机是中文
        // Windows 时，PowerShell 在没有控制台的情况下常常用系统 OEM 代码页而不是
        // UTF-8 输出错误信息）next_line() 就会返回 Err，这个 while-let 循环会直接
        // 静默退出、后面的内容再也读不到——用户看到的错误就会诡异地卡在第一行
        // （比如只有一句 "#< CLIXML" 没有下文）。改成按字节读到 \n，用 lossy 转换
        // （非法字节替换成 �），保证不管编码是否正确都能把内容读完整。
        let mut reader = BufReader::with_capacity(256 * 1024, stderr);
        loop {
            let mut buf: Vec<u8> = Vec::new();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
                        buf.pop();
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let _ = emit_to_frontend(
                        &app_clone2,
                        &format!("claude:stderr:{}", sid_clone2),
                        serde_json::json!(line),
                    );
                }
                Err(e) => {
                    eprintln!("[ClaudeDeck:CRITICAL] stderr read error: {}", e);
                    break;
                }
            }
        }
    });

    // Send the first message via stdin as NDJSON (skip if prompt is empty — pre-warm mode)
    if !params.prompt.is_empty() {
        let first_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": params.prompt
            }
        });
        stdin_mgr.send(&sid, &first_msg.to_string()).await?;
    }

    Ok(SessionInfo {
        session_id: sid,
        pid,
        cli_path: claude_bin.clone(),
    })
}

#[tauri::command]
pub(crate) async fn send_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // Wrap user text in stream-json NDJSON format
    let json_msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });
    stdin_mgr.send(&session_id, &json_msg.to_string()).await
}

#[tauri::command]
pub(crate) async fn send_raw_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    stdin_mgr.send(&session_id, &message).await
}

/// Respond to a structured permission request from the SDK control protocol.
/// Called by the frontend when the user approves or denies a tool use.
///
/// IMPORTANT: The SDK always sends `updatedInput` with the original tool input when allowing.
/// CLI internally relies on this field. For deny, only `message` is included.
/// Format mirrors exactly what the SDK constructs (from reverse-engineered source).
#[tauri::command]
pub(crate) async fn respond_permission(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
    tool_use_id: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    let mut inner = serde_json::Map::new();
    if allow {
        inner.insert("behavior".into(), Value::String("allow".into()));
        // SDK always includes updatedInput with the original tool input on allow
        inner.insert(
            "updatedInput".into(),
            updated_input.unwrap_or(Value::Object(serde_json::Map::new())),
        );
    } else {
        inner.insert("behavior".into(), Value::String("deny".into()));
        inner.insert(
            "message".into(),
            Value::String(message.unwrap_or_else(|| "User denied this operation".into())),
        );
    }
    if let Some(ref tuid) = tool_use_id {
        inner.insert("toolUseID".into(), Value::String(tuid.clone()));
    }

    let resp = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": inner,
        }
    });
    let json_str = resp.to_string();
    stdin_mgr.send(&session_id, &json_str).await
}

/// Send a runtime control request to the CLI (set_permission_mode, set_model, interrupt).
#[tauri::command]
pub(crate) async fn send_control_request(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    subtype: String,
    payload: Value,
) -> Result<(), String> {
    use protocol::ControlRequest;
    let req = match subtype.as_str() {
        "interrupt" => ControlRequest::interrupt(),
        "set_permission_mode" => {
            let mode = payload
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'mode' in payload")?
                .to_string();
            ControlRequest::set_permission_mode(mode)
        }
        "set_model" => {
            let model = payload
                .get("model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            ControlRequest::set_model(model)
        }
        "rewind_files" => {
            let user_message_id = payload
                .get("user_message_id")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'user_message_id' in payload")?
                .to_string();
            ControlRequest::rewind_files(user_message_id)
        }
        other => return Err(format!("Unknown control request subtype: {}", other)),
    };
    let json_str = serde_json::to_string(&req)
        .map_err(|e| format!("Failed to serialize control request: {}", e))?;
    stdin_mgr.send(&session_id, &json_str).await
}

#[tauri::command]
pub(crate) async fn kill_session(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
) -> Result<(), String> {
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;
    Ok(())
}
/// 应用退出前有序终止所有会话进程（本地 claude 与经 ssh 启动的远端 claude 一视同仁）：
/// 先发 interrupt 中断当前回合，稍候关闭 stdin（远端经 ssh 转发为 EOF），
/// 等进程自行退出，超时（3 秒）才强制结束，尽量避免留下孤儿进程。
#[tauri::command]
pub(crate) async fn shutdown_all_sessions(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
) -> Result<(), String> {
    let ids = state.active_ids().await;
    if ids.is_empty() {
        return Ok(());
    }
    if let Ok(interrupt) = serde_json::to_string(&protocol::ControlRequest::interrupt()) {
        for id in &ids {
            let _ = stdin_mgr.send(id, &interrupt).await;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    for id in &ids {
        stdin_mgr.remove(id).await;
    }
    state.wait_or_kill_all(std::time::Duration::from_secs(3)).await;
    Ok(())
}

/// TK-329: List all active stdinIds from ProcessManager.
/// Frontend uses this after refresh to detect and clean up orphaned backend processes.
#[tauri::command]
pub(crate) async fn list_active_processes(
    state: State<'_, ProcessManager>,
) -> Result<Vec<String>, String> {
    Ok(state.active_ids().await)
}
