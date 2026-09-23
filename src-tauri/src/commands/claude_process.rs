use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub cli_path: String,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct ManagedProcess {
    pub child: Child,
    pub session_id: String,
}

#[derive(Debug, Default)]
pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<ManagedProcess>>>>>,
}

/// Manages stdin handles for sending user responses to Claude processes
#[derive(Debug, Default, Clone)]
pub struct StdinManager {
    handles: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

impl StdinManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, stdin: ChildStdin) {
        let mut map = self.handles.lock().await;
        map.insert(id, stdin);
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut map = self.handles.lock().await;
        if let Some(stdin) = map.get_mut(id) {
            // Atomic write: message + newline in one call to prevent interleaving (P1-2 fix)
            let payload = format!("{}\n", message);
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            Ok(())
        } else {
            Err(format!("No stdin handle for session: {}", id))
        }
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.handles.lock().await;
        map.remove(id);
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, process: ManagedProcess) {
        let mut map = self.processes.lock().await;
        map.insert(id, Arc::new(Mutex::new(process)));
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.processes.lock().await;
        if let Some(proc) = map.remove(id) {
            // Actually kill the child process to prevent zombie leaks (P0-2 fix)
            let mut managed = proc.lock().await;
            if let Err(e) = managed.child.kill().await {
                eprintln!(
                    "[ClaudeDeck] Failed to kill process for session {}: {}",
                    id, e
                );
            }
        }
    }

    /// 等待所有进程在 grace 时间内自行退出，超时的强制结束，并清空进程表。
    /// 各进程并行等待；用于应用退出时的有序收尾（此前应已关闭各进程的 stdin）。
    pub async fn wait_or_kill_all(&self, grace: std::time::Duration) {
        let procs: Vec<(String, Arc<Mutex<ManagedProcess>>)> = {
            let mut map = self.processes.lock().await;
            map.drain().collect()
        };
        let waits = procs.into_iter().map(|(id, proc)| async move {
            let mut managed = proc.lock().await;
            if tokio::time::timeout(grace, managed.child.wait()).await.is_err() {
                if let Err(e) = managed.child.kill().await {
                    eprintln!("[ClaudeDeck] Failed to kill process for session {}: {}", id, e);
                }
            }
        });
        futures_util::future::join_all(waits).await;
    }

    /// TK-329: List all active stdinIds so the frontend can detect orphaned processes
    /// after a browser refresh (frontend state is wiped but backend keeps processes alive).
    pub async fn active_ids(&self) -> Vec<String> {
        let map = self.processes.lock().await;
        map.keys().cloned().collect()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StartSessionParams {
    pub prompt: String,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    /// When set, resume an existing Claude CLI session instead of starting a new one.
    /// The value should be the Claude CLI session ID (UUID).
    pub resume_session_id: Option<String>,
    /// Thinking effort level: "off", "low", "medium", "high", or "max".
    pub thinking_level: Option<String>,
    /// Session mode: "ask", "plan", or "auto" (default).
    pub session_mode: Option<String>,
    /// Active provider ID from providers.json.
    /// When set, the provider's env vars are injected into the CLI process.
    pub provider_id: Option<String>,
    /// Declared model context window. Used to override Claude Code auto-compact window.
    pub context_window: Option<u32>,
    /// Permission mode for CLI. Maps from frontend session modes:
    ///   "acceptEdits" (code mode) | "default" (ask mode) | "plan" | "bypassPermissions" (bypass)
    /// When not "bypassPermissions", enables --permission-prompt-tool stdio for structured
    /// permission requests via the SDK control protocol.
    pub permission_mode: Option<String>,
    /// 是否在会话中加载 MCP 服务器（默认 false）。
    /// false 时带 --strict-mcp-config 跳过全部 MCP，启动更快；true 时按 CLI 自身配置加载。
    pub enable_mcp: Option<bool>,
    /// 回退用：续接（resume_session_id）时只保留到该消息（含）之前的历史，并分叉出新会话。
    /// 值为 JSONL 里助手消息记录的 uuid。
    pub resume_session_at: Option<String>,
}
