import type { ChatMessage } from '../stores/chatStore';
import { generateMessageId } from '../stores/chatStore';
import type { AgentPhase } from '../stores/agentStore';
import { compactFileFromAttachment, createCompactNotice, withCompactFile, type CompactNoticeData } from './compact-notice';

export interface AgentData {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  startTime: number;
  endTime: number;
  isMain: boolean;
}

export interface LoadedSession {
  messages: ChatMessage[];
  agents: AgentData[];
  mainAgentStartTime: number;
}

/** Detect system-injected content that should not be shown to users */
function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<')                            // XML tags like <system-reminder>
    || t.startsWith('This session is being continued') // continuation summaries
    || /^Analysis:\s*\n/.test(t)                       // continuation analysis blocks
    || /^Summary:\s*\n/.test(t)                        // continuation summary blocks
    || t.startsWith('In this environment you have access to') // tool definitions
    || t.startsWith('Human:')                          // raw conversation format leaks
    || t.includes('<system-reminder>')                 // embedded system reminders
    || t.includes('</system-reminder>');
}

/** Parse raw JSONL messages into structured session data */
export function parseSessionMessages(rawMessages: any[]): LoadedSession {
  const messages: ChatMessage[] = [];
  const agents: AgentData[] = [];

  // Create main agent with session start time
  const firstMsg = rawMessages[0];
  const sessionStartTime = firstMsg?.timestamp
    ? new Date(firstMsg.timestamp).getTime()
    : Date.now();

  agents.push({
    id: 'main',
    parentId: null,
    description: 'Main',
    phase: 'completed',
    startTime: sessionStartTime,
    endTime: Date.now(),
    isMain: true,
  });

  // Collect tool_use_id → index mapping for binding tool results
  const toolUseIdToIndex = new Map<string, number>();
  const seenSourceRecords = new Set<string>();
  // 最近一条压缩提示在 messages 里的位置；压缩边界之后紧跟的摘要与文件记录补到它上面，
  // 遇到下一条真正的对话内容后不再补（之后的 attachment 是用户 @ 引用等，与压缩无关）
  let compactIdx = -1;
  const patchCompact = (update: (d: CompactNoticeData) => CompactNoticeData) => {
    const m = messages[compactIdx];
    messages[compactIdx] = { ...m, commandData: { ...update((m.commandData ?? {}) as CompactNoticeData) } };
  };

  for (const msg of rawMessages) {
    // 压缩边界（磁盘上是驼峰的 compactMetadata）
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const meta = msg.compactMetadata ?? {};
      messages.push(createCompactNotice(
        typeof msg.uuid === 'string' && msg.uuid ? `compact-${msg.uuid}` : generateMessageId(),
        msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
        {
          trigger: meta.trigger === 'manual' ? 'manual' : meta.trigger === 'auto' ? 'auto' : undefined,
          preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : undefined,
          postTokens: typeof meta.postTokens === 'number' ? meta.postTokens : undefined,
        },
      ));
      compactIdx = messages.length - 1;
      continue;
    }
    if (msg.isCompactSummary) {
      const content = msg.message?.content;
      const summary = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('') : '';
      if (compactIdx >= 0 && summary) patchCompact((d) => ({ ...d, summary }));
      continue;
    }
    if (msg.type === 'attachment') {
      const file = compactIdx >= 0 ? compactFileFromAttachment(msg.attachment) : null;
      if (file) patchCompact((d) => withCompactFile(d, file));
      continue;
    }

    // Skip system-injected meta messages
    if (msg.isMeta) continue;

    // Rewind/resume can replay an already persisted JSONL record. Source UUIDs
    // are stable, so discard record replays without collapsing legitimate
    // repeated prompts that have different UUIDs.
    if (typeof msg.uuid === 'string' && msg.uuid) {
      const sourceKey = `${msg.type || msg.role || 'unknown'}:${msg.uuid}`;
      if (seenSourceRecords.has(sourceKey)) continue;
      seenSourceRecords.add(sourceKey);
    }

    // Handle tool_result messages: attach result to parent tool_use card
    if (msg.toolUseResult || msg.type === 'tool_result') {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.tool_use_id) {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => c.text || c.content || '').join('')
              : '';
          if (resultText) {
            const idx = toolUseIdToIndex.get(b.tool_use_id);
            if (idx !== undefined && messages[idx]) {
              messages[idx] = { ...messages[idx], toolResultContent: resultText };
            }
          }
        }
      }
      continue;
    }

    if (msg.type === 'human' || msg.type === 'user' || msg.role === 'user') {
      // Extract text blocks, filtering out system-injected content
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const userTexts: string[] = [];
      for (const b of blocks) {
        const text = typeof b === 'string' ? b : b?.type === 'text' ? b.text : '';
        if (text && !isSystemText(text)) userTexts.push(text);
      }
      // Fallback for plain string content
      if (blocks.length === 0 && typeof msg.message?.content === 'string') {
        const text = msg.message.content;
        if (!isSystemText(text)) userTexts.push(text);
      }
      let content = userTexts.join('');
      // Extract file attachments from text
      const attachments: Array<{ name: string; path: string; isImage: boolean }> = [];
      const attachRegex = /\n?\n?\[(?:附加的文件|Attached files)\]\n([\s\S]+)$/;
      const attachMatch = content.match(attachRegex);
      if (attachMatch) {
        content = content.slice(0, attachMatch.index!).trimEnd();
        const paths = attachMatch[1].split('\n').map(p => p.trim()).filter(Boolean);
        for (const p of paths) {
          const name = p.split(/[\\/]/).pop() || p;
          const ext = name.split('.').pop()?.toLowerCase() || '';
          const isImage = ['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext);
          attachments.push({ name, path: p, isImage });
        }
      }
      if (content.trim()) {
        compactIdx = -1;
        messages.push({
          id: msg.uuid || generateMessageId(),
          role: 'user',
          type: 'text',
          content,
          timestamp: msg.timestamp || Date.now(),
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      }
    } else if (msg.type === 'assistant') {
      compactIdx = -1;
      const blocks = msg.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'text') {
            if (isSystemText(block.text || '')) continue;
            messages.push({
              id: msg.uuid || generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: block.text,
              timestamp: msg.timestamp || Date.now(),
            });
          } else if (block.type === 'tool_use') {
            // Rebuild agent tree from Agent/Task tool_use blocks
            if (block.name === 'Task' || block.name === 'Agent') {
              agents.push({
                id: block.id || generateMessageId(),
                parentId: 'main',
                description: block.input?.description || block.input?.prompt || 'Agent',
                phase: 'completed',
                startTime: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
                endTime: Date.now(),
                isMain: false,
              });
            }

            let chatMsg: ChatMessage;
            if (block.name === 'AskUserQuestion' && block.input?.questions) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: block.input.questions,
                resolved: true,
                timestamp: msg.timestamp || Date.now(),
              };
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                timestamp: msg.timestamp || Date.now(),
              };
            } else {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                timestamp: msg.timestamp || Date.now(),
              };
            }
            // Record tool_use_id for later result binding
            if (block.id) {
              toolUseIdToIndex.set(block.id, messages.length);
            }
            messages.push(chatMsg);
          } else if (block.type === 'tool_result') {
            const resultText = Array.isArray(block.content)
              ? block.content.map((b: any) => b.text || b.content || '').join('')
              : typeof block.content === 'string'
                ? block.content
                : block.output || '';
            if (block.tool_use_id && resultText) {
              const idx = toolUseIdToIndex.get(block.tool_use_id);
              if (idx !== undefined && messages[idx]) {
                messages[idx] = { ...messages[idx], toolResultContent: resultText };
              }
            }
          } else if (block.type === 'thinking') {
            messages.push({
              id: msg.uuid ? `${msg.uuid}_thinking_${messages.length}` : generateMessageId(),
              role: 'assistant',
              type: 'thinking',
              content: block.thinking || '',
              timestamp: msg.timestamp || Date.now(),
            });
          }
        }
      }
    }
  }

  return { messages, agents, mainAgentStartTime: sessionStartTime };
}
