// system 消息：init 模型、错误、思考 token、压缩边界、后台任务数。
import { useChatStore, generateMessageId } from '../../../stores/chatStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { CLI_DEFAULT, useSettingsStore } from '../../../stores/settingsStore';
import { formatErrorForUser } from '../errors';
import { persistTokenState } from '../token-state';
import { type SystemMessage } from '../../../lib/stream-message';
import { createCompactNotice } from '../../../lib/compact-notice';
import { type StreamContext } from '../context';

export function handleSystemMessage(ctx: StreamContext, msg: SystemMessage): void {
  const { tabId, addMessage, setSessionMeta } = ctx;

  if (msg.subtype === 'init') {
    setSessionMeta({ model: msg.model });
    // 以「CLI 默认」启动的会话：记下 CLI 实际选用的模型，供下次新会话在 CLI 上报前估算上下文窗口
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
    const spawned = meta?.spawnedModel ?? useSettingsStore.getState().selectedModel;
    if (msg.model && spawned === CLI_DEFAULT) useSettingsStore.getState().setLastCliModel(msg.model);
  } else if (msg.subtype === 'error') {
    // FI-3: Surface system-level errors instead of silently dropping them
    const rawError = msg.message || msg.error || 'System error';
    addMessage({
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content: formatErrorForUser(rawError),
      timestamp: Date.now(),
    });
  } else if (msg.subtype === 'thinking_tokens') {
    // Track estimated thinking token usage (Claude CLI stream-json)
    // Updates sessionMeta with thinking token estimates for display
    const thinkingTokens = msg.estimated_tokens;
    if (typeof thinkingTokens === 'number') {
      const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
      setSessionMeta({
        thinkingTokens,
        totalThinkingTokens: (meta.totalThinkingTokens || 0) + (msg.estimated_tokens_delta || 0),
      });
    }
  } else if (msg.subtype === 'background_tasks_changed') {
    // tasks 是当前全部存活的后台任务，直接覆盖计数；ambient 是 CLI 自身的任务，不计入
    const count = (msg.tasks ?? []).filter((task) => !task.ambient).length;
    useSessionStore.getState().setBackgroundTasks(tabId, count);
  } else if (
    msg.subtype === 'task_started' || msg.subtype === 'task_progress'
    || msg.subtype === 'task_updated' || msg.subtype === 'task_notification'
  ) {
    // 单个任务的事件：后台任务数以 background_tasks_changed 的完整列表为准，这里不处理
  } else if (msg.subtype === 'status') {
    // Session status updates (e.g. "requesting") — informational, silently tracked
    // We don't surface these as user-visible messages; they're internal CLI state
  } else if (msg.subtype === 'compact_boundary') {
    // 压缩完成：CLI 会用这条事件给出压缩后的真实 token 数，
    // 不处理的话右上角的上下文占用会一直停留在压缩前的旧数值，直到下一轮真实对话才刷新
    // 实时流里是蛇形命名 compact_metadata.post_tokens（驼峰的 compactMetadata 只出现在磁盘 JSONL 里）
    const postTokens = msg.compact_metadata?.post_tokens;
    const preTokens = msg.compact_metadata?.pre_tokens;
    // 不是从应用的处理卡片发起的压缩（CLI 自动触发，或 CLI 自己处理的 /compact）：
    // 在对话里插一条压缩提示，否则用户看不出上下文已经被压缩过
    if (!useChatStore.getState().getTab(tabId)?.sessionMeta?.pendingCommandMsgId) {
      addMessage(createCompactNotice(generateMessageId(), Date.now(), {
        trigger: msg.compact_metadata?.trigger,
        preTokens,
        postTokens,
      }));
    }
    if (typeof postTokens === 'number') {
      setSessionMeta({
        inputTokens: postTokens,
        outputTokens: 0,
        contextInputTokens: postTokens,
        contextOutputTokens: 0,
      });
      const boundaryMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
      if (boundaryMeta) persistTokenState(tabId, boundaryMeta);

      // 把压缩前后的 token 数写进处理卡片，让用户知道这次压缩大概做了什么
      const boundaryCmdMsgId = boundaryMeta?.pendingCommandMsgId;
      if (boundaryCmdMsgId) {
        const boundaryCmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? [])
          .find((m) => m.id === boundaryCmdMsgId);
        if (boundaryCmdMsg) {
          useChatStore.getState().updateMessage(tabId, boundaryCmdMsgId, {
            commandData: {
              ...boundaryCmdMsg.commandData,
              compactSummary: { preTokens, postTokens },
            },
          });
        }
      }
    }
  } else {
    // FI-3: Log unknown subtypes so we know what we're missing
    console.warn('[ClaudeDeck] Unhandled system subtype:', msg.subtype, msg);
  }
}
