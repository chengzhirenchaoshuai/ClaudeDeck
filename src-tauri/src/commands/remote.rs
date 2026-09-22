//! 远程连接：通过系统自带的 ssh，在远端 Windows 主机上运行 claude。
//!
//! 约定：
//! - 远程项目用 URI 表示：`ssh://<主机别名>/<远端路径>`，例如 `ssh://win-pc/C:/Users/me/proj`。
//!   这样前端的 cwd、会话分组等逻辑无需感知远程，只需在后端识别该前缀。
//! - 认证完全交给系统 ssh（密钥、ssh-agent、~/.ssh/config），本应用不保存任何密码。
//! - 远端默认 shell 需为 cmd.exe（Windows OpenSSH Server 的默认值）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub const REMOTE_SCHEME: &str = "ssh://";

/// 一个远程主机配置。`id` 同时作为 `ssh://<id>/...` 中的主机名。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    /// ssh 目标：~/.ssh/config 中的 Host 别名，或 user@host
    pub destination: String,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

fn hosts_path() -> Result<std::path::PathBuf, String> {
    crate::tokenicode_data_path("remote_hosts.json")
}

fn load_hosts() -> Result<Vec<RemoteHost>, String> {
    let path = hosts_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read remote hosts: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse remote hosts: {}", e))
}

fn save_hosts(hosts: &[RemoteHost]) -> Result<(), String> {
    let path = hosts_path()?;
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("Failed to serialize remote hosts: {}", e))?;
    // 先写临时文件再重命名，避免中途失败损坏配置
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write remote hosts: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to save remote hosts: {}", e))
}

pub fn find_host(id: &str) -> Result<RemoteHost, String> {
    load_hosts()?
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("Remote host '{}' not found", id))
}

fn validate_host(host: &RemoteHost) -> Result<(), String> {
    let id_ok = !host.id.is_empty()
        && host.id.len() <= 32
        && host
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !id_ok {
        return Err("名称只能包含字母、数字、-、_、.，且不超过 32 个字符".to_string());
    }
    let dest = host.destination.trim();
    // 以 - 开头会被 ssh 当作选项（如 -oProxyCommand=...），必须拒绝
    if dest.is_empty() || dest.starts_with('-') || dest.chars().any(|c| c.is_whitespace()) {
        return Err("连接目标不能为空、不能以 - 开头、不能包含空白字符".to_string());
    }
    Ok(())
}

/// 解析 `ssh://<主机>/<路径>`，返回 (主机 id, 远端路径)。非远程 URI 返回 None。
pub fn parse_remote_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix(REMOTE_SCHEME)?;
    let (host, path) = rest.split_once('/')?;
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// 构造带公共选项的 ssh 命令（不含远端命令）。
/// BatchMode 禁止交互式询问密码，认证失败会直接报错而不是卡住。
/// accept-new：首次连接自动记住主机指纹，之后指纹变化会拒绝连接。
pub fn ssh_command(host: &RemoteHost) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-T")
        .arg("-C") // 开启 ssh 压缩：会话列表、用量统计等脚本输出的都是高度可压缩的文本/JSON，
                   // 网速较慢时能明显缩短等待时间，对已经是二进制的部分（如登录握手）影响可忽略
        .args(["-o", "BatchMode=yes"])
        .args(["-o", "ConnectTimeout=15"])
        .args(["-o", "ServerAliveInterval=30"])
        .args(["-o", "StrictHostKeyChecking=accept-new"]);
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(identity) = &host.identity_file {
        if !identity.trim().is_empty() {
            cmd.arg("-i").arg(identity.trim());
        }
    }
    cmd.arg(host.destination.trim());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

/// 把参数按 cmd.exe + MSVC 运行库规则加双引号。
/// 含有 cmd 元字符或会触发变量展开的字符时直接拒绝，避免命令注入。
fn quote_cmd_arg(arg: &str) -> Result<String, String> {
    if arg.chars().any(|c| matches!(c, '%' | '&' | '|' | '<' | '>' | '^' | '\n' | '\r' | '\0')) {
        return Err(format!("远程会话参数含有不支持的字符: {}", arg));
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    Ok(out)
}

/// 构造在远端执行的 cmd 命令：切换目录、设置环境变量后启动 claude。
/// 远端 claude 使用远端自己的配置（settings.json、MCP、skills 等）。
pub fn build_remote_claude_command(
    remote_path: &str,
    env: &[(&str, &str)],
    args: &[String],
) -> Result<String, String> {
    if remote_path.chars().any(|c| matches!(c, '"' | '%' | '\n' | '\r' | '\0')) {
        return Err("远程路径含有不支持的字符".to_string());
    }
    let win_path = remote_path.replace('/', "\\");
    let mut parts = vec![format!("cd /d \"{}\"", win_path)];
    for (key, value) in env {
        parts.push(format!("set {}", quote_cmd_arg(&format!("{}={}", key, value))?));
    }
    let mut claude = String::from("claude");
    for arg in args {
        claude.push(' ');
        claude.push_str(&quote_cmd_arg(arg)?);
    }
    parts.push(claude);
    Ok(parts.join(" && "))
}

/// 在远端执行一条命令并等待结束，返回 (stdout, stderr, 退出码)。
pub async fn run_remote(
    host: &RemoteHost,
    remote_cmd: &str,
    timeout: Duration,
) -> Result<(String, String, i32), String> {
    let mut cmd = ssh_command(host);
    cmd.arg(remote_cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("无法启动 ssh（请确认系统已安装 OpenSSH 客户端）: {}", e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

/// 注入到每个远端脚本开头的辅助函数：把 JSON 中的非 ASCII 字符转成 \uXXXX。
/// 经 ssh 运行 PowerShell 时通常没有控制台，脚本里设置 [Console]::OutputEncoding 会静默失败，
/// 输出退回系统 OEM 代码页（中文系统是 GBK），本端按 UTF-8 解码就会全部乱码。
/// 输出纯 ASCII 后，与任何编码设置都无关。
const PS_ASCII_HELPER: &str = r#"
function Out-AsciiJson($json) {
  [regex]::Replace([string]$json, '[^\x00-\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) ('\u{0:x4}' -f [int][char]$m.Value) })
}
"#;

/// 把 PowerShell 脚本编码为 -EncodedCommand 形式的远端命令，避免经 cmd 传递时的引号转义问题。
fn powershell_command(script: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let script = format!("{}{}", PS_ASCII_HELPER, script);
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    format!(
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

/// 列出远端 CLI 会话的脚本：遍历 <配置目录>/projects/*/*.jsonl，读取前 100 行提取 cwd 与首条用户消息。
/// 配置目录同样遵循远端的 CLAUDE_CONFIG_DIR。
const LIST_SESSIONS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$proj = Join-Path $root 'projects'
$out = @()
if (Test-Path -LiteralPath $proj) {
  foreach ($d in Get-ChildItem -LiteralPath $proj -Directory) {
    foreach ($f in Get-ChildItem -LiteralPath $d.FullName -Filter *.jsonl -File) {
      $cwd = ''; $prev = ''
      foreach ($line in (Get-Content -LiteralPath $f.FullName -TotalCount 100 -Encoding UTF8)) {
        try { $j = $line | ConvertFrom-Json } catch { continue }
        if (-not $cwd -and $j.cwd) { $cwd = [string]$j.cwd }
        if (-not $prev -and ($j.type -eq 'user' -or $j.type -eq 'human' -or $j.message.role -eq 'user')) {
          $c = $j.message.content
          if ($c -is [string]) { $t = $c } else { $t = ($c | Where-Object { $_.text } | Select-Object -First 1).text }
          if ($t) { $prev = ([string]$t).Trim() }
        }
        if ($cwd -and $prev) { break }
      }
      if ($prev.Length -gt 120) { $prev = $prev.Substring(0, 120) }
      $ms = [int64](([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds())
      $out += [pscustomobject]@{ id = $f.BaseName; path = $f.FullName; projectDir = $d.Name; modifiedAt = $ms; cwd = $cwd; preview = $prev }
    }
  }
}
Out-AsciiJson (ConvertTo-Json -InputObject @($out) -Compress)
"#;

/// 读取远端 Claude 配置的脚本：settings.json、.claude.json 中的 MCP、skills 与自定义命令名称。
const READ_CONFIG_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$cfgJson = if ($env:CLAUDE_CONFIG_DIR) { Join-Path $root '.claude.json' } else { Join-Path $HOME '.claude.json' }
function ReadJson($p) {
  if (Test-Path -LiteralPath $p) { try { return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null } }
  return $null
}
$settings = ReadJson (Join-Path $root 'settings.json')
$global = ReadJson $cfgJson
$mcp = @()
if ($global -and $global.mcpServers) {
  foreach ($p in $global.mcpServers.PSObject.Properties) {
    $mcp += [pscustomobject]@{ name = $p.Name; type = [string]$p.Value.type; command = [string]$p.Value.command; url = [string]$p.Value.url }
  }
}
$skills = @(); $sd = Join-Path $root 'skills'
if (Test-Path -LiteralPath $sd) { $skills = @(Get-ChildItem -LiteralPath $sd -Directory | ForEach-Object { $_.Name }) }
$cmds = @(); $cd = Join-Path $root 'commands'
if (Test-Path -LiteralPath $cd) { $cmds = @(Get-ChildItem -LiteralPath $cd -Filter *.md -File | ForEach-Object { $_.BaseName }) }
$result = [pscustomobject]@{ configDir = $root; settings = $settings; mcpServers = @($mcp); skills = @($skills); commands = @($cmds) }
Out-AsciiJson (ConvertTo-Json -InputObject $result -Depth 20 -Compress)
"#;

/// 递归脱敏：键名含 key/token/secret/password/auth 的字符串值不回传，只保留“已设置”标记。
fn mask_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                let lower = key.to_ascii_lowercase();
                let sensitive = ["key", "token", "secret", "password", "auth"]
                    .iter()
                    .any(|w| lower.contains(w));
                if sensitive && v.is_string() {
                    *v = Value::String("***（已设置）".to_string());
                } else {
                    mask_secrets(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask_secrets),
        _ => {}
    }
}

/// 读取远端 Claude 配置（只读）。密钥脱敏；MCP 只返回名称、类型、命令或去掉查询串的 URL，
/// 不返回 args / env / headers，因为其中常含令牌。
#[tauri::command]
pub async fn read_remote_config(host_id: String) -> Result<Value, String> {
    let host = find_host(&host_id)?;
    let (stdout, stderr, code) =
        run_remote(&host, &powershell_command(READ_CONFIG_SCRIPT), Duration::from_secs(60)).await?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("读取远端配置失败（退出码 {}）", code)
        } else {
            stderr.trim().to_string()
        });
    }
    let text = stdout.trim().trim_start_matches('\u{feff}');
    let mut config: Value =
        serde_json::from_str(text).map_err(|e| format!("解析远端配置失败: {}", e))?;
    mask_secrets(&mut config["settings"]);
    if let Some(servers) = config["mcpServers"].as_array_mut() {
        for server in servers {
            if let Some(url) = server["url"].as_str() {
                let stripped = url.split('?').next().unwrap_or("").to_string();
                server["url"] = Value::String(stripped);
            }
        }
    }
    Ok(config)
}

/// 把远端 Windows 路径转为 URI 里的路径部分（反斜杠改为正斜杠）。
fn to_uri(host_id: &str, path: &str) -> String {
    format!("{}{}/{}", REMOTE_SCHEME, host_id, path.replace('\\', "/"))
}

/// 远端用量统计脚本：与本机 get_usage_stats 语义一致——
/// 文件内同一消息保留 output 最大的一条，按修改时间从早到晚跨文件按消息 ID 去重，
/// 按 (UTC 小时, 模型, 项目) 聚合后输出 JSON。只对包含 usage 的助手行做完整解析以节省时间。
const USAGE_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$proj = Join-Path $root 'projects'
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$agg = @{}
$files = @()
if (Test-Path -LiteralPath $proj) {
  foreach ($d in Get-ChildItem -LiteralPath $proj -Directory) {
    foreach ($f in Get-ChildItem -LiteralPath $d.FullName -Filter *.jsonl -File) {
      if ($f.BaseName -notlike 'desk_*') {
        $files += [pscustomobject]@{ Path = $f.FullName; Dir = $d.Name; Time = $f.LastWriteTimeUtc }
      }
    }
  }
}
$files = @($files | Sort-Object Time)
$anon = 0
foreach ($f in $files) {
  $cwd = ''
  $byId = @{}
  foreach ($line in [System.IO.File]::ReadLines($f.Path)) {
    if (-not $cwd -and $line.Contains('"cwd":"')) {
      $m = [regex]::Match($line, '"cwd":"((?:[^"\\]|\\.)*)"')
      if ($m.Success) { $cwd = [regex]::Unescape($m.Groups[1].Value) }
    }
    if (-not $line.Contains('"usage":{')) { continue }
    if (-not $line.Contains('"type":"assistant"')) { continue }
    try { $j = $line | ConvertFrom-Json } catch { continue }
    if ($j.type -ne 'assistant') { continue }
    $u = $j.message.usage
    if (-not $u) { continue }
    $in = [int64]$u.input_tokens
    $out = [int64]$u.output_tokens
    $cr = [int64]$u.cache_read_input_tokens
    $cc = $u.cache_creation
    if ($cc) { $c5 = [int64]$cc.ephemeral_5m_input_tokens; $c1 = [int64]$cc.ephemeral_1h_input_tokens }
    else { $c5 = [int64]$u.cache_creation_input_tokens; $c1 = [int64]0 }
    if (($in + $out + $cr + $c5 + $c1) -eq 0) { continue }
    $id = [string]$j.message.id
    if (-not $id) { $id = [string]$j.uuid }
    if (-not $id) { $anon++; $id = "anon-$anon" }
    $hm = [regex]::Match($line, '"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2})')
    $hour = if ($hm.Success) { $hm.Groups[1].Value } else { 'unknown' }
    $model = [string]$j.message.model
    if (-not $model) { $model = 'unknown' }
    if (-not $byId.ContainsKey($id) -or $byId[$id][3] -lt $out) {
      $byId[$id] = @($hour, $model, $in, $out, $cr, $c5, $c1)
    }
  }
  $project = if ($cwd) { $cwd } else { $f.Dir }
  foreach ($id in $byId.Keys) {
    if (-not $seen.Add($id)) { continue }
    $r = $byId[$id]
    $key = $r[0] + '|' + $r[1] + '|' + $project
    if (-not $agg.ContainsKey($key)) { $agg[$key] = @($r[0], $r[1], $project, [int64]0, [int64]0, [int64]0, [int64]0, [int64]0, [int64]0) }
    $a = $agg[$key]
    $a[3] += $r[2]; $a[4] += $r[3]; $a[5] += $r[4]; $a[6] += $r[5]; $a[7] += $r[6]; $a[8] += 1
  }
}
$rows = foreach ($a in $agg.Values) {
  [pscustomobject]@{ hour = $a[0]; model = $a[1]; project = $a[2]; input = $a[3]; output = $a[4]; cacheRead = $a[5]; cache5m = $a[6]; cache1h = $a[7]; messages = $a[8] }
}
Out-AsciiJson (ConvertTo-Json -InputObject @{ rows = @($rows); sessionCount = $files.Count } -Compress -Depth 4)
"#;

/// 读取远端主机上的用量统计，返回与本机 `get_usage_stats` 相同结构的行，
/// 其中 project 为 ssh:// URI，并附带 host 字段。远端需要解析全部会话文件，耗时较长（超时 5 分钟）。
#[tauri::command]
pub async fn get_remote_usage(host_id: String) -> Result<Value, String> {
    let host = find_host(&host_id)?;
    let (stdout, stderr, code) =
        run_remote(&host, &powershell_command(USAGE_SCRIPT), Duration::from_secs(300)).await?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("读取远端用量失败（退出码 {}）", code)
        } else {
            stderr.trim().to_string()
        });
    }
    let text = stdout.trim().trim_start_matches('\u{feff}');
    let mut result: Value =
        serde_json::from_str(text).map_err(|e| format!("解析远端用量失败: {}", e))?;
    if let Some(rows) = result["rows"].as_array_mut() {
        for row in rows {
            let project = row["project"].as_str().unwrap_or("").to_string();
            row["project"] = Value::String(to_uri(&host_id, &project));
            row["host"] = Value::String(host_id.clone());
        }
    }
    Ok(result)
}

/// 列出远端主机上的 CLI 会话，返回结构与本机 `list_sessions` 一致，
/// 其中 project、path 均为 ssh:// URI，另附 host 字段。
#[tauri::command]
pub async fn list_remote_sessions(host_id: String) -> Result<Vec<Value>, String> {
    let host = find_host(&host_id)?;
    let (stdout, stderr, code) =
        run_remote(&host, &powershell_command(LIST_SESSIONS_SCRIPT), Duration::from_secs(90)).await?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("读取远端会话失败（退出码 {}）", code)
        } else {
            stderr.trim().to_string()
        });
    }
    let text = stdout.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Ok(vec![]);
    }
    let items: Vec<Value> =
        serde_json::from_str(text).map_err(|e| format!("解析远端会话列表失败: {}", e))?;
    let hidden = crate::load_hidden_sessions();

    let mut sessions: Vec<Value> = items
        .into_iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?.to_string();
            if !crate::is_listable_session(&id, &hidden) {
                return None;
            }
            let path = item["path"].as_str()?;
            let project_dir = item["projectDir"].as_str().unwrap_or("");
            // cwd 是权威来源；缺失时退回目录名（有损编码，仅作兜底显示）
            let cwd = item["cwd"].as_str().filter(|c| !c.is_empty()).unwrap_or(project_dir);
            Some(json!({
                "id": id,
                "path": to_uri(&host_id, path),
                "project": to_uri(&host_id, cwd),
                "projectDir": project_dir,
                "modifiedAt": item["modifiedAt"].as_u64().unwrap_or(0),
                "preview": item["preview"].as_str().unwrap_or(""),
                "host": host_id,
            }))
        })
        .collect();
    sessions.sort_by(|a, b| {
        b["modifiedAt"].as_u64().unwrap_or(0).cmp(&a["modifiedAt"].as_u64().unwrap_or(0))
    });
    Ok(sessions)
}

/// 读取远端会话 JSONL 并解析为消息列表。只允许读取 .jsonl 文件。
pub async fn load_remote_session(uri: &str) -> Result<Vec<Value>, String> {
    let (host_id, path) = parse_remote_uri(uri).ok_or("无效的远程路径")?;
    if !path.to_ascii_lowercase().ends_with(".jsonl") {
        return Err("只能读取 .jsonl 会话文件".to_string());
    }
    if path.chars().any(|c| matches!(c, '"' | '%' | '\n' | '\r' | '\0')) {
        return Err("远程路径含有不支持的字符".to_string());
    }
    let host = find_host(&host_id)?;
    // 会话文件可能有几 MB，网速不好时传输是主要耗时：先在远端用 gzip 压缩再 base64 输出，
    // JSONL 高度重复、压缩比通常有 5-10 倍，比直接传原始字节快得多；ssh_command 里的 -C
    // 只能再小幅压缩已经压缩过的数据，两者不冲突
    let win_path = path.replace('/', "\\").replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference = 'Stop'; \
         $bytes = [System.IO.File]::ReadAllBytes('{}'); \
         $ms = New-Object System.IO.MemoryStream; \
         $gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress); \
         $gz.Write($bytes, 0, $bytes.Length); $gz.Close(); \
         [Convert]::ToBase64String($ms.ToArray())",
        win_path
    );
    let (stdout, stderr, code) =
        run_remote(&host, &powershell_command(&script), Duration::from_secs(120)).await?;
    if code != 0 {
        return Err(format!("读取远端会话失败: {}", stderr.trim()));
    }
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let compressed = STANDARD
        .decode(stdout.trim().as_bytes())
        .map_err(|e| format!("解码远端会话失败: {}", e))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::GzDecoder::new(std::io::Cursor::new(compressed)),
        &mut bytes,
    )
    .map_err(|e| format!("解压远端会话失败: {}", e))?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

/// 删除远端会话：只允许删除 CLI projects 目录内的 .jsonl 文件，和本机 delete_session 的白名单逻辑一致。
pub async fn delete_remote_session(uri: &str) -> Result<(), String> {
    let (host_id, path) = parse_remote_uri(uri).ok_or("无效的远程路径")?;
    if !path.to_ascii_lowercase().ends_with(".jsonl") {
        return Err("只能删除 .jsonl 会话文件".to_string());
    }
    if path.chars().any(|c| matches!(c, '"' | '%' | '\n' | '\r' | '\0')) {
        return Err("远程路径含有不支持的字符".to_string());
    }
    let host = find_host(&host_id)?;
    let win_path = path.replace('/', "\\").replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference = 'Stop'; \
         $root = if ($env:CLAUDE_CONFIG_DIR) {{ $env:CLAUDE_CONFIG_DIR }} else {{ Join-Path $HOME '.claude' }}; \
         $proj = (Resolve-Path -LiteralPath (Join-Path $root 'projects')).Path; \
         $target = (Resolve-Path -LiteralPath '{}').Path; \
         if (-not $target.StartsWith($proj, [System.StringComparison]::OrdinalIgnoreCase)) {{ throw '拒绝删除 projects 目录之外的文件' }}; \
         Remove-Item -LiteralPath $target -Force",
        win_path
    );
    let (_, stderr, code) =
        run_remote(&host, &powershell_command(&script), Duration::from_secs(30)).await?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("删除远端会话失败（退出码 {}）", code)
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn list_remote_hosts() -> Result<Vec<RemoteHost>, String> {
    load_hosts()
}

/// 新增或更新（按 id）一个远程主机。
#[tauri::command]
pub async fn save_remote_host(host: RemoteHost) -> Result<(), String> {
    validate_host(&host)?;
    let mut hosts = load_hosts()?;
    match hosts.iter_mut().find(|h| h.id == host.id) {
        Some(existing) => *existing = host,
        None => hosts.push(host),
    }
    save_hosts(&hosts)
}

#[tauri::command]
pub async fn delete_remote_host(id: String) -> Result<(), String> {
    let mut hosts = load_hosts()?;
    hosts.retain(|h| h.id != id);
    save_hosts(&hosts)
}

/// 读取 ~/.ssh/config 中不含通配符的 Host 别名，供添加主机时选择。
#[tauri::command]
pub async fn list_ssh_config_hosts() -> Result<Vec<String>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(vec![]);
    };
    let Ok(content) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Ok(vec![]);
    };
    let mut names = vec![];
    for line in content.lines() {
        let mut words = line.split_whitespace();
        if words.next().map(|w| w.eq_ignore_ascii_case("host")) != Some(true) {
            continue;
        }
        for name in words {
            if !name.contains(['*', '?', '!']) && !names.iter().any(|n| n == name) {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}

/// 测试连接：验证 ssh 可达、认证通过、远端 shell 为 cmd、claude 可用。
#[tauri::command]
pub async fn test_remote_connection(id: String) -> Result<Value, String> {
    let host = find_host(&id)?;
    // cmd 下 %OS% 会展开为 Windows_NT；若原样输出说明远端默认 shell 不是 cmd
    let (stdout, stderr, code) =
        run_remote(&host, "echo %OS% && claude --version", Duration::from_secs(30)).await?;
    let mut lines = stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
    let os_line = lines.next().unwrap_or("");
    let shell_is_cmd = os_line == "Windows_NT";
    let version = lines.next().unwrap_or("").to_string();
    let ok = code == 0 && shell_is_cmd && !version.is_empty();
    let message = if ok {
        format!("连接成功，远端 claude 版本：{}", version)
    } else if !shell_is_cmd && !os_line.is_empty() {
        "已连接，但远端默认 shell 不是 cmd.exe，暂不支持".to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("连接失败（退出码 {}）", code)
    };
    Ok(json!({
        "ok": ok,
        "shellIsCmd": shell_is_cmd,
        "claudeVersion": version,
        "message": message,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_uri() {
        assert_eq!(
            parse_remote_uri("ssh://win-pc/C:/Users/me/proj"),
            Some(("win-pc".to_string(), "C:/Users/me/proj".to_string()))
        );
        assert_eq!(parse_remote_uri("C:/Users/me"), None);
        assert_eq!(parse_remote_uri("ssh:///C:/x"), None);
    }

    #[test]
    fn quote_json_arg() {
        assert_eq!(
            quote_cmd_arg(r#"{"a":true}"#).unwrap(),
            r#""{\"a\":true}""#
        );
        assert!(quote_cmd_arg("a&b").is_err());
    }

    #[test]
    fn build_command() {
        let cmd = build_remote_claude_command(
            "C:/Users/me/my proj",
            &[("K", "V")],
            &["--model".to_string(), "x".to_string()],
        )
        .unwrap();
        assert_eq!(
            cmd,
            r#"cd /d "C:\Users\me\my proj" && set "K=V" && claude "--model" "x""#
        );
    }
}
