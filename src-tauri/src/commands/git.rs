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

/// 一次采集得到的原始输出。本机由 `probe_local_git` 逐条执行命令收集，
/// 远程主机由 remote.rs 的 GIT_PROBE_SCRIPT 收集后以 JSON 返回，两边字段一致，解析逻辑共用。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct GitProbe {
    is_repo: bool,
    /// `git branch --show-current`，游离 HEAD 时为空
    branch: String,
    /// 已确认 origin 上存在的 origin/HEAD 指向（去掉 `origin/` 前缀）
    origin_head: String,
    has_origin_main: bool,
    has_origin_master: bool,
    /// `git config --show-scope --get user.name`，形如 `local\t名字`
    user_name: String,
    user_email: String,
    remote_url: String,
    changed_files: u32,
    gh_installed: bool,
    /// `gh auth token` 的退出码，None 表示超时
    gh_token_code: Option<i32>,
    gh_token_stderr: String,
    /// `gh auth status` 的退出码，None 表示超时
    gh_status_code: Option<i32>,
    /// `gh auth status` 的 stdout + stderr（令牌在其中是打码的），只用于解析账号名，不回传前端
    gh_status_output: String,
}

/// 返回给前端的 Git 信息。分支、主分支、user.name 的取法与 CLI 写入系统提示的 gitStatus 一致，
/// gh 登录状态的判断与 CLI 检测 GitHub CLI 的逻辑一致。
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct GitInfo {
    is_repo: bool,
    /// 当前分支；游离 HEAD 时为 "HEAD"（与 CLI 相同）
    branch: String,
    main_branch: String,
    user_name: Option<String>,
    /// 配置来源：local / global / system 等
    user_name_scope: Option<String>,
    user_email: Option<String>,
    user_email_scope: Option<String>,
    /// origin 地址，已去掉其中可能内嵌的账号和令牌
    remote_url: Option<String>,
    changed_files: u32,
    /// not_installed / authenticated / not_authenticated / unknown
    gh_status: String,
    gh_error: Option<String>,
    /// gh 当前活动账号（来自 `gh auth status`，未登录但留有账号记录时也会有值）
    gh_account: Option<String>,
    /// `gh auth status` 报告令牌失效（CLI 只看令牌是否存在，这里额外提示）
    gh_token_invalid: bool,
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// 拆分 `--show-scope` 的输出 `scope\tvalue`
fn split_scoped(raw: &str) -> (Option<String>, Option<String>) {
    match raw.trim().split_once('\t') {
        Some((scope, value)) => (non_empty(value), non_empty(scope)),
        None => (non_empty(raw), None),
    }
}

/// 去掉 URL 里的 userinfo（`https://user:token@host/...`），scp 形式（`git@host:path`）原样保留
fn strip_url_credentials(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        let authority_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..authority_end].rfind('@') {
            return format!("{}://{}", scheme, &rest[at + 1..]);
        }
    }
    url.to_string()
}

/// 从 `gh auth status` 输出中取活动账号。新版格式 `account NAME (...)` 后跟 `Active account: true`，
/// 旧版格式 `Logged in to HOST as NAME (...)`。找不到活动标记时取第一个账号。
fn parse_gh_account(output: &str) -> Option<String> {
    let mut accounts: Vec<(String, bool)> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.contains("Active account: true") {
            if let Some(last) = accounts.last_mut() {
                last.1 = true;
            }
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if !lower.contains("log in to") && !lower.contains("logged in to") {
            continue;
        }
        let name = line
            .split_once(" account ")
            .or_else(|| line.split_once(" as "))
            .and_then(|(_, rest)| rest.split_whitespace().next());
        if let Some(name) = name {
            accounts.push((name.to_string(), false));
        }
    }
    accounts
        .iter()
        .find(|(_, active)| *active)
        .or(accounts.first())
        .map(|(name, _)| name.clone())
}

/// gh 登录状态，照搬 CLI 的判断：先看 `gh auth token`，版本过旧没有该子命令时退回 `gh auth status`
fn gh_auth_status(p: &GitProbe) -> (&'static str, Option<String>) {
    if !p.gh_installed {
        return ("not_installed", None);
    }
    let stderr = p.gh_token_stderr.trim();
    let lower = stderr.to_ascii_lowercase();
    match p.gh_token_code {
        Some(0) => return ("authenticated", None),
        None => return ("unknown", Some("`gh auth token` timed out".to_string())),
        Some(_) => {}
    }
    if lower.contains("not logged in") || lower.contains("no oauth token") {
        return ("not_authenticated", None);
    }
    if lower.contains("unknown command") || stderr.is_empty() {
        let status_lower = p.gh_status_output.to_ascii_lowercase();
        return match p.gh_status_code {
            Some(0) => ("authenticated", None),
            None => ("unknown", Some("`gh auth status` timed out".to_string())),
            _ if status_lower.contains("logged in to") => ("authenticated", None),
            _ if status_lower.contains("not logged in") => ("not_authenticated", None),
            _ => ("unknown", Some(non_empty(&p.gh_status_output).unwrap_or_else(|| "`gh auth status` failed to run".to_string()))),
        };
    }
    ("unknown", Some(stderr.to_string()))
}

fn build_git_info(p: &GitProbe) -> GitInfo {
    let (user_name, user_name_scope) = split_scoped(&p.user_name);
    let (user_email, user_email_scope) = split_scoped(&p.user_email);
    // 主分支：origin/HEAD → origin/main → origin/master → "main"，与 CLI 相同
    let main_branch = if !p.origin_head.trim().is_empty() {
        p.origin_head.trim().to_string()
    } else if p.has_origin_master && !p.has_origin_main {
        "master".to_string()
    } else {
        "main".to_string()
    };
    let (gh_status, gh_error) = gh_auth_status(p);
    let status_lower = p.gh_status_output.to_ascii_lowercase();
    GitInfo {
        is_repo: p.is_repo,
        branch: non_empty(&p.branch).unwrap_or_else(|| "HEAD".to_string()),
        main_branch,
        user_name,
        user_name_scope,
        user_email,
        user_email_scope,
        remote_url: non_empty(&p.remote_url).map(|u| strip_url_credentials(&u)),
        changed_files: p.changed_files,
        gh_status: gh_status.to_string(),
        gh_error,
        gh_account: parse_gh_account(&p.gh_status_output),
        gh_token_invalid: status_lower.contains("failed to log in") || status_lower.contains("is invalid"),
    }
}

/// 本机执行一条命令：Ok(Some(code)) 正常结束，Ok(None) 超时，Err 无法启动。
/// `keep_stdout` 为 false 时丢弃标准输出（用于 `gh auth token`，其输出就是令牌）。
async fn run_probe(
    bin: &str,
    args: &[&str],
    cwd: &str,
    path_env: &str,
    keep_stdout: bool,
    timeout_secs: u64,
) -> Result<(Option<i32>, String, String), ()> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .stdout(if keep_stdout { Stdio::piped() } else { Stdio::null() })
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.creation_flags(0x08000000);
    let child = cmd.spawn().map_err(|_| ())?;
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(out)) => Ok((
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )),
        Ok(Err(_)) => Err(()),
        Err(_) => Ok((None, String::new(), String::new())),
    }
}

/// 在本机目录下采集 Git / gh 信息，命令与远端脚本一一对应
async fn probe_local_git(cwd: &str) -> GitProbe {
    let path_env = build_enriched_path();
    let git = |args: &'static [&'static str]| {
        let path_env = path_env.clone();
        let cwd = cwd.to_string();
        async move {
            let mut full = vec!["--no-optional-locks"];
            full.extend_from_slice(args);
            match run_probe("git", &full, &cwd, &path_env, true, 5).await {
                Ok((Some(0), out, _)) => Some(out),
                _ => None,
            }
        }
    };
    let mut p = GitProbe::default();
    if git(&["rev-parse", "--is-inside-work-tree"]).await.as_deref() == Some("true") {
        p.is_repo = true;
        let origin_head = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        let (branch, origin_head, has_main, has_master, user_name, user_email, remote_url, status) = tokio::join!(
            git(&["branch", "--show-current"]),
            origin_head,
            git(&["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"]),
            git(&["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"]),
            git(&["config", "--show-scope", "--get", "user.name"]),
            git(&["config", "--show-scope", "--get", "user.email"]),
            git(&["remote", "get-url", "origin"]),
            git(&["status", "--porcelain"]),
        );
        p.branch = branch.unwrap_or_default();
        p.has_origin_main = has_main.is_some();
        p.has_origin_master = has_master.is_some();
        p.user_name = user_name.unwrap_or_default();
        p.user_email = user_email.unwrap_or_default();
        p.remote_url = remote_url.unwrap_or_default();
        p.changed_files = status
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0);
        // origin/HEAD 指向的分支必须在 origin 上确实存在
        if let Some(head) = origin_head {
            let head = head.trim().trim_start_matches("origin/").to_string();
            let refname = format!("refs/remotes/origin/{}", head);
            let ok = run_probe(
                "git",
                &["--no-optional-locks", "show-ref", "--verify", "--quiet", &refname],
                cwd,
                &path_env,
                true,
                5,
            )
            .await;
            if !head.is_empty() && matches!(ok, Ok((Some(0), _, _))) {
                p.origin_head = head;
            }
        }
    }
    if let Ok((code, _, stderr)) = run_probe("gh", &["auth", "token"], cwd, &path_env, false, 5).await {
        p.gh_installed = true;
        p.gh_token_code = code;
        p.gh_token_stderr = stderr;
        if let Ok((code, out, err)) = run_probe("gh", &["auth", "status"], cwd, &path_env, true, 8).await {
            p.gh_status_code = code;
            p.gh_status_output = format!("{}\n{}", out, err);
        }
    }
    p
}

/// 读取项目目录的 Git 信息与 gh 登录状态；`ssh://` 项目经 ssh 在远端采集
#[tauri::command]
pub(crate) async fn get_git_info(cwd: String) -> Result<GitInfo, String> {
    let probe = if let Some((host_id, remote_path)) = commands::remote::parse_remote_uri(&cwd) {
        let raw = commands::remote::probe_remote_git(&host_id, &remote_path).await?;
        serde_json::from_value(raw).map_err(|e| format!("解析远端 Git 信息失败: {}", e))?
    } else {
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("Working directory does not exist: {}", cwd));
        }
        probe_local_git(&cwd).await
    };
    Ok(build_git_info(&probe))
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

    // 远程项目：本机的 claude 碰不到远端文件，改为经 ssh 在远端执行同样的命令
    if let Some((host_id, remote_path)) = commands::remote::parse_remote_uri(&cwd) {
        return commands::remote::rewind_remote_files(&host_id, &remote_path, &session_id, &checkpoint_uuid)
            .await;
    }

    let claude_bin = find_claude_binary().unwrap_or_else(|| "claude.cmd".to_string());

    let enriched_path = build_enriched_path();

    // .cmd/.bat 需经 cmd /C 启动；不弹出控制台窗口
    let mut rewind_cmd = if claude_needs_cmd_wrapper(&claude_bin) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&claude_bin);
        c
    } else {
        tokio::process::Command::new(&claude_bin)
    };
    rewind_cmd.creation_flags(0x08000000);
    rewind_cmd.args(["--resume", &session_id, "--rewind-files", &checkpoint_uuid])
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 用远端脚本实测得到的输出构造：gh 留有账号记录但经 SSH 读不到令牌
    fn ssh_probe() -> GitProbe {
        serde_json::from_str(r#"{"isRepo":true,"branch":"main","originHead":"","hasOriginMain":true,"hasOriginMaster":false,"userName":"local\tchengzhiren66","userEmail":"local\tchengzhiren66@gmail.com","remoteUrl":"https://github.com/chengzhirenchaoshuai/ClaudeDeck.git","changedFiles":3,"ghInstalled":true,"ghTokenCode":1,"ghTokenStderr":"no oauth token found for github.com","ghStatusCode":1,"ghStatusOutput":"\ngithub.com\n  X Failed to log in to github.com account chengzhirenchaoshuai (default)\n  - Active account: true\n  - The token in default is invalid.\n"}"#).unwrap()
    }

    #[test]
    fn parse_remote_probe() {
        let info = build_git_info(&ssh_probe());
        assert!(info.is_repo);
        assert_eq!(info.branch, "main");
        assert_eq!(info.main_branch, "main");
        assert_eq!(info.user_name.as_deref(), Some("chengzhiren66"));
        assert_eq!(info.user_name_scope.as_deref(), Some("local"));
        assert_eq!(info.user_email.as_deref(), Some("chengzhiren66@gmail.com"));
        assert_eq!(info.changed_files, 3);
        assert_eq!(info.gh_status, "not_authenticated");
        assert_eq!(info.gh_account.as_deref(), Some("chengzhirenchaoshuai"));
        assert!(info.gh_token_invalid);
    }

    #[test]
    fn missing_fields_and_detached_head() {
        let info = build_git_info(&serde_json::from_str::<GitProbe>(r#"{"isRepo":true,"ghTokenCode":null}"#).unwrap());
        assert_eq!(info.branch, "HEAD");
        assert_eq!(info.user_name, None);
        assert_eq!(info.gh_status, "not_installed");
    }

    #[test]
    fn main_branch_fallback() {
        let mut p = GitProbe { has_origin_master: true, ..Default::default() };
        assert_eq!(build_git_info(&p).main_branch, "master");
        p.has_origin_main = true;
        assert_eq!(build_git_info(&p).main_branch, "main");
        p.origin_head = "develop".into();
        assert_eq!(build_git_info(&p).main_branch, "develop");
    }

    #[test]
    fn gh_auth_detection() {
        let mut p = GitProbe { gh_installed: true, gh_token_code: Some(0), ..Default::default() };
        assert_eq!(gh_auth_status(&p).0, "authenticated");
        p.gh_token_code = None;
        assert_eq!(gh_auth_status(&p).0, "unknown");
        // 旧版 gh 没有 auth token 子命令，退回 auth status
        p.gh_token_code = Some(1);
        p.gh_token_stderr = "unknown command \"token\" for \"gh auth\"".into();
        p.gh_status_code = Some(1);
        p.gh_status_output = "github.com\n  ✓ Logged in to github.com as olduser (oauth_token)".into();
        assert_eq!(gh_auth_status(&p).0, "authenticated");
        assert_eq!(parse_gh_account(&p.gh_status_output).as_deref(), Some("olduser"));
        p.gh_token_stderr = "something else".into();
        assert_eq!(gh_auth_status(&p), ("unknown", Some("something else".to_string())));
    }

    #[test]
    fn gh_active_account() {
        let out = "github.com\n  ✓ Logged in to github.com account a (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account b (keyring)\n  - Active account: true\n";
        assert_eq!(parse_gh_account(out).as_deref(), Some("b"));
        assert_eq!(parse_gh_account("You are not logged into any GitHub hosts."), None);
    }

    #[test]
    fn strip_credentials() {
        assert_eq!(strip_url_credentials("https://u:ghp_x@github.com/a/b.git"), "https://github.com/a/b.git");
        assert_eq!(strip_url_credentials("https://github.com/a/b.git"), "https://github.com/a/b.git");
        assert_eq!(strip_url_credentials("git@github.com:a/b.git"), "git@github.com:a/b.git");
        assert_eq!(strip_url_credentials("ssh://git@host:22/a@b"), "ssh://host:22/a@b");
    }
}
