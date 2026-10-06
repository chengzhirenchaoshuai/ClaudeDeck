//! Git 命令执行与回溯时的文件恢复（rewind_files）。

use crate::*;

/// Run a git command in a specific working directory and return stdout.
/// Only allows safe, read-or-restore git operations.
#[tauri::command]
pub(crate) async fn run_git_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    // Allowlist: only safe git subcommands
    let allowed_subcommands = [
        "status",
        "diff",
        "log",
        "show",
        "stash",
        "checkout",
        "rev-parse",
        "hash-object",
        "cat-file",
    ];
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("");
    if !allowed_subcommands.contains(&subcmd) {
        return Err(format!("Git subcommand '{}' not allowed", subcmd));
    }

    // P1-1: Reject null bytes in args (could truncate strings in C-level APIs)
    for arg in &args {
        if arg.contains('\0') {
            return Err("Arguments must not contain null bytes".to_string());
        }
    }

    // P1-1: Validate cwd is an existing directory
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {}", cwd));
    }

    // P1-1: Reject dangerous git flags that could enable command execution
    let dangerous_prefixes = ["-c", "--exec", "--upload-pack", "--receive-pack"];
    for arg in &args[1..] {
        let lower = arg.to_lowercase();
        for prefix in &dangerous_prefixes {
            if lower == *prefix || lower.starts_with(&format!("{}=", prefix)) {
                return Err(format!("Git flag '{}' not allowed", arg));
            }
        }
    }

    let git_bin = "git";

    let mut cmd = Command::new(git_bin);
    cmd.args(&args).current_dir(&cwd);
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git {} failed: {}", subcmd, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Rewind files to a CLI checkpoint via `claude --resume <session_id> --rewind-files <uuid>`.
/// This delegates file restoration to the CLI's native checkpoint system.
#[tauri::command]
pub(crate) async fn rewind_files(
    session_id: String,
    checkpoint_uuid: String,
    cwd: String,
) -> Result<String, String> {
    // P1-1: Validate session_id and checkpoint_uuid look like UUIDs (hex + hyphens only)
    fn is_uuid_like(s: &str) -> bool {
        s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    }
    if !is_uuid_like(&session_id) {
        return Err(format!("Invalid session_id format: {}", session_id));
    }
    if !is_uuid_like(&checkpoint_uuid) {
        return Err(format!(
            "Invalid checkpoint_uuid format: {}",
            checkpoint_uuid
        ));
    }

    let claude_bin = find_claude_binary().unwrap_or_else(|| {
        {
            "claude.cmd".to_string()
        }
    });

    let enriched_path = build_enriched_path();

    let mut rewind_cmd = tokio::process::Command::new(&claude_bin);
    rewind_cmd.args(&["--resume", &session_id, "--rewind-files", &checkpoint_uuid])
        .current_dir(&cwd)
        .env("PATH", &enriched_path)
        .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
        .env_remove("CLAUDECODE");
    // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
    rewind_cmd.env("MSYS_NO_PATHCONV", "1").env("MSYS2_ARG_CONV_EXCL", "*");

    let output = rewind_cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run claude --rewind-files: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("rewind_files failed: {}", stderr))
    }
}
