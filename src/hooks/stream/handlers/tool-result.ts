// 旧版 CLI 的顶层 tool_result 消息。
import { useChatStore, generateMessageId, type ChatMessage } from '../../../stores/chatStore';
import { toolResultText, type LegacyToolResultMessage } from '../../../lib/stream-message';
import { maybeRefreshFileTree } from '../file-tree-refresh';
import { type StreamContext } from '../context';

export function handleToolResult(ctx: StreamContext, msg: LegacyToolResultMessage): void {
  const { tabId, agentActions, agentDepth, addMessage } = ctx;

  const resultContent = Array.isArray(msg.content) || typeof msg.content === 'string'
    ? toolResultText(msg.content)
    : msg.output || '';

  const toolUseId = msg.tool_use_id;
  // Auto-refresh file tree when file-mutating tools complete
  maybeRefreshFileTree(tabId, toolUseId, msg.tool_name);

  if (toolUseId) {
    const currentMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
    const parentMsg = currentMessages.find((m) => m.id === toolUseId);
    if (parentMsg) {
      const updates: Partial<ChatMessage> = { toolResultContent: resultContent };

      // Backfill: if parent is AskUserQuestion created with empty questions
      // (due to streaming), or was mis-typed as tool_use, fix it now.
      if (parentMsg.toolName === 'AskUserQuestion') {
        if (parentMsg.type !== 'question') {
          updates.type = 'question';
          updates.resolved = false;
        }
        if (!parentMsg.questions || parentMsg.questions.length === 0) {
          // Try to extract questions from toolInput (may have been populated
          // by a later assistant message with complete content)
          const qs = parentMsg.toolInput?.questions;
          if (Array.isArray(qs) && qs.length > 0) {
            updates.questions = qs;
          }
        }
      }

      useChatStore.getState().updateMessage(tabId, toolUseId, updates);
      return;
    }
  }
  // Complete Agent Team agents when their tool result arrives
  if (toolUseId && agentActions?.agents.has(toolUseId)) {
    agentActions?.completeAgent(toolUseId, 'completed');
  }
  addMessage({
    id: msg.uuid || generateMessageId(),
    role: 'assistant',
    type: 'tool_result',
    content: resultContent,
    toolName: msg.tool_name,
    subAgentDepth: agentDepth,
    timestamp: Date.now(),
  });
}
