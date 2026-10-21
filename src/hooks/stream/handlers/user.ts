// user 消息：记录回溯用的 checkpoint UUID，并把工具结果回填到对应的工具卡。
import { useChatStore } from '../../../stores/chatStore';
import { toolResultText, type UserMessage } from '../../../lib/stream-message';
import { type StreamContext } from '../context';

export function handleUserMessage(ctx: StreamContext, msg: UserMessage): void {
  const { tabId } = ctx;

  // 运行中发出的消息被 CLI 处理了：此时才把气泡插进聊天记录，位置就是它进入对话的地方。
  // 要先于下面记录 checkpoint UUID，让 UUID 落到这条气泡上
  if (msg.isReplay && typeof msg.message?.content === 'string') {
    const sent = useChatStore.getState().takeSentPendingMessage(tabId, msg.message.content);
    if (sent?.message) ctx.addMessage({ ...sent.message, timestamp: Date.now() });
  }

  // Store CLI checkpoint UUID on the most recent user message (for rewind).
  // Only store from genuine user-input messages, NOT tool-result messages.
  // Tool-result user messages have content with tool_result blocks and their
  // UUIDs don't match the file-history-snapshot messageId used by --rewind-files.
  {
    const content = msg.message?.content;
    const isToolResult = Array.isArray(content)
      && content.some((b) => b.type === 'tool_result');
    if (msg.uuid && !isToolResult) {
      const allMsgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        if (allMsgs[i].role === 'user') {
          console.log('[stream] Storing checkpointUuid:', msg.uuid, 'on msg:', allMsgs[i].id);
          useChatStore.getState().updateMessage(tabId, allMsgs[i].id, { checkpointUuid: msg.uuid });
          break;
        }
      }
    }
  }

  const userContent = msg.message?.content;
  if (Array.isArray(userContent)) {
    for (const block of userContent) {
      if (block.type === 'tool_result') {
        const resultText = toolResultText(block.content);
        const tuId = block.tool_use_id;
        if (tuId && resultText) {
          const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const parent = msgs.find((m) => m.id === tuId);
          if (parent) {
            useChatStore.getState().updateMessage(tabId, tuId, { toolResultContent: resultText });
          }
        }
      }
    }
  }
  if (msg.tool_use_result) {
    const tur = msg.tool_use_result;
    const resultText = typeof tur === 'string' ? tur
      : typeof tur.stdout === 'string' ? tur.stdout
      : typeof tur.content === 'string' ? tur.content
      : Array.isArray(tur.content) ? tur.content.map((b) => typeof b.text === 'string' ? b.text : '').join('')
      : typeof tur.content === 'object' && tur.content?.text ? String(tur.content.text)
      : '';
    if (Array.isArray(userContent)) {
      for (const block of userContent) {
        if (block.type === 'tool_result' && block.tool_use_id && resultText) {
          const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const parent = msgs.find((m) => m.id === block.tool_use_id);
          if (parent) {
            useChatStore.getState().updateMessage(tabId, block.tool_use_id, { toolResultContent: resultText });
          }
        }
      }
    }
  }
}
