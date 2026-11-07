import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/chatStore';
import { collectInputHistory, stepHistory } from '../useInputHistory';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: content, role, type: 'text', content, timestamp: 0, ...extra,
});

describe('collectInputHistory', () => {
  it('只收集用户发的文本消息，跳过空白和连续重复', () => {
    expect(collectInputHistory([
      msg('user', '第一条'),
      msg('assistant', '回复'),
      msg('user', '第二条'),
      msg('user', '第二条 '),
      msg('user', '  '),
      msg('user', '第一条'),
    ])).toEqual(['第一条', '第二条', '第一条']);
  });

  it('优先用发送时的原始输入（气泡里显示的是技能名等）', () => {
    expect(collectInputHistory([
      msg('user', '/review', { sendContext: { rawInput: '帮我看看这段', prefixes: [] } }),
    ])).toEqual(['帮我看看这段']);
  });

  it('工具结果等非文本的用户消息不算', () => {
    expect(collectInputHistory([msg('user', 'x', { type: 'tool_result' })])).toEqual([]);
  });
});

describe('stepHistory', () => {
  it('没在翻看时上键显示最新一条', () => {
    expect(stepHistory(3, null, true)).toEqual({ kind: 'show', index: 2 });
  });

  it('翻看中继续上键往前，到最早一条后停住', () => {
    expect(stepHistory(3, 1, true)).toEqual({ kind: 'show', index: 0 });
    expect(stepHistory(3, 0, true)).toEqual({ kind: 'stay' });
  });

  it('下键往后，翻过最新一条时回到空输入框', () => {
    expect(stepHistory(3, 0, false)).toEqual({ kind: 'show', index: 1 });
    expect(stepHistory(3, 2, false)).toEqual({ kind: 'clear' });
  });
});
