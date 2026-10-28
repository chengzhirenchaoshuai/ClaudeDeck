/**
 * Turn parsing utilities for the Rewind feature.
 * Pure functions — no store dependencies, fully testable.
 */
import type { ChatMessage } from '../stores/chatStore';

export interface CodeChange {
  filePath: string;
  toolName: string;
  action: 'edited' | 'created' | 'terminal';
}

export interface Turn {
  /** 1-based turn number */
  index: number;
  /** ID of the user message that starts this turn */
  userMessageId: string;
  /** Preview of the user message (truncated to 80 chars) */
  userContent: string;
  /** Timestamp of the user message */
  timestamp: number;
  /** Index in the messages[] array where this turn starts */
  startMsgIdx: number;
  /** Files modified during this turn */
  codeChanges: CodeChange[];
  /** CLI checkpoint UUID for file restoration (from --replay-user-messages) */
  checkpointUuid?: string;
}

/**
 * Parse a flat messages array into Turn objects.
 * A new turn begins at every `role === 'user'` message.
 */
export function parseTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let turnIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    turnIndex++;
    const content = msg.content || '';
    const nextUserIdx = findNextUserIndex(messages, i + 1);

    turns.push({
      index: turnIndex,
      userMessageId: msg.id,
      userContent: content.length > 80 ? content.slice(0, 80) + '…' : content,
      timestamp: msg.timestamp,
      startMsgIdx: i,
      codeChanges: extractCodeChanges(messages, i + 1, nextUserIdx),
      checkpointUuid: msg.checkpointUuid,
    });
  }

  return turns;
}

/**
 * Find the index of the next user message starting from `fromIdx`.
 * Returns `messages.length` if no more user messages exist.
 */
function findNextUserIndex(messages: ChatMessage[], fromIdx: number): number {
  for (let j = fromIdx; j < messages.length; j++) {
    if (messages[j].role === 'user') return j;
  }
  return messages.length;
}

/**
 * Extract code changes from assistant messages in a turn range.
 * Scans for tool_use messages with Edit, Write, or Bash tool names.
 */
export function extractCodeChanges(
  messages: ChatMessage[],
  startIdx: number,
  endIdx: number,
): CodeChange[] {
  const changes: CodeChange[] = [];
  const seenFiles = new Set<string>();

  for (let i = startIdx; i < endIdx; i++) {
    const msg = messages[i];
    if (msg.type !== 'tool_use' || !msg.toolName) continue;

    const input = msg.toolInput;
    if (!input) continue;

    if (msg.toolName === 'Edit' && input.file_path) {
      const fp = input.file_path as string;
      if (!seenFiles.has(fp)) {
        seenFiles.add(fp);
        changes.push({ filePath: fp, toolName: 'Edit', action: 'edited' });
      }
    } else if (msg.toolName === 'Write' && input.file_path) {
      const fp = input.file_path as string;
      if (!seenFiles.has(fp)) {
        seenFiles.add(fp);
        changes.push({ filePath: fp, toolName: 'Write', action: 'created' });
      }
    } else if (msg.toolName === 'Bash' && input.command) {
      const cmd = (input.command as string).slice(0, 40);
      changes.push({ filePath: cmd, toolName: 'Bash', action: 'terminal' });
    }
  }

  return changes;
}

/**
 * Get a short filename from a full path.
 */
export function shortFilePath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || filePath;
}

/**
 * Format a relative time string (e.g., "2m ago", "1h ago").
 */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** 消息时间戳转毫秒：实时消息是毫秒数，从磁盘 JSONL 加载的是 ISO 字符串 */
function toMillis(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return new Date(ts).getTime();
  return NaN;
}

/**
 * 每轮的用时（从用户发出消息到这一轮最后一条回复），返回 Map：这一轮最后一条消息的 ID → 毫秒数。
 * 磁盘上的 JSONL 没有记录 CLI 的用时，统一用消息时间戳计算，历史会话和实时会话结果一致。
 * running 为 true 时最后一轮还没结束，不计算。
 */
export function computeTurnDurations(messages: ChatMessage[], running: boolean): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    const end = findNextUserIndex(messages, i + 1);
    if (end === i + 1) continue; // 这一轮没有任何回复
    if (end === messages.length && running) continue;
    const last = messages[end - 1];
    const ms = toMillis(last.timestamp) - toMillis(messages[i].timestamp);
    if (Number.isFinite(ms) && ms > 0) result.set(last.id, ms);
  }
  return result;
}
