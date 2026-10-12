// token 状态与 Claude 会话 UUID 的 sessionStorage 缓存（F5 刷新后恢复用）。
import {
  getContextInputTokens,
  getContextOutputTokens,
  hasMeaningfulContextUsage,
  type TokenUsage,
} from '../../lib/context-usage';

// --- Token state cache + Claude UUID index (survives F5 via sessionStorage) ---
// Token persistence: real-time cache for F5 recovery during active streaming.
// UUID index: maps tabId → Claude session UUID for JSONL cross-check on reconnect.

const TOKEN_STATE_KEY = 'tokenicode_token_state_v2';
const UUID_INDEX_KEY = 'tokenicode_claude_uuids';

export function persistTokenState(tabId: string, meta: {
  inputTokens?: number;
  outputTokens?: number;
  contextInputTokens?: number;
  contextOutputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}) {
  try {
    const data = JSON.parse(sessionStorage.getItem(TOKEN_STATE_KEY) || '{}');
    data[tabId] = {
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      contextInputTokens: meta.contextInputTokens,
      contextOutputTokens: meta.contextOutputTokens,
      totalInputTokens: meta.totalInputTokens,
      totalOutputTokens: meta.totalOutputTokens,
    };
    sessionStorage.setItem(TOKEN_STATE_KEY, JSON.stringify(data));
  } catch {/* ignore */}
}

export function contextSnapshot(usage: TokenUsage | undefined): {
  contextInputTokens: number;
  contextOutputTokens: number;
} | null {
  if (!hasMeaningfulContextUsage(usage)) return null;
  return {
    contextInputTokens: getContextInputTokens(usage),
    contextOutputTokens: getContextOutputTokens(usage),
  };
}

export function persistClaudeUuid(tabId: string, claudeUuid: string) {
  try {
    const data = JSON.parse(sessionStorage.getItem(UUID_INDEX_KEY) || '{}');
    data[tabId] = claudeUuid;
    sessionStorage.setItem(UUID_INDEX_KEY, JSON.stringify(data));
  } catch {/* ignore */}
}

export function loadClaudeUuid(tabId: string): string | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(UUID_INDEX_KEY) || '{}');
    return data[tabId] || null;
  } catch {
    return null;
  }
}
