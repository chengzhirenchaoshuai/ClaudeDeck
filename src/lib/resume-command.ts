import type { SessionListItem } from './tauri-bridge';

/** 会话所在的目录（Windows 路径）：远程会话去掉 ssh://<主机>/ 前缀，本机会话直接用 project */
function sessionDirectory(session: SessionListItem): string {
  const match = session.project.match(/^ssh:\/\/[^/]+\/(.+)$/);
  return match ? match[1].replace(/\//g, '\\') : session.project;
}

/**
 * 在终端里恢复该会话的命令（PowerShell 语法）。
 * ClaudeDeck 以 stream-json 启动 claude，会话被标记为 SDK 入口，claude 的 /resume 选择器
 * 会隐藏这类会话，只能按会话 ID 恢复；会话按目录存放，必须先进入原目录。
 * 远程会话需要先 ssh 登录到对应主机，再在远端终端里执行。
 */
export function buildResumeCommand(session: SessionListItem): string {
  const dir = sessionDirectory(session).replace(/'/g, "''");
  return `Set-Location -LiteralPath '${dir}'; claude --resume ${session.id}`;
}
