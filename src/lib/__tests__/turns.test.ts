import { describe, expect, it } from 'vitest';
import { findWithdrawableTurn } from '../turns';
import type { ChatMessage } from '../../stores/chatStore';

const msg = (id: string, role: ChatMessage['role'], timestamp: number): ChatMessage => ({
  id, role, type: 'text', content: id, timestamp,
});

const tab = (messages: ChatMessage[], over: Partial<Parameters<typeof findWithdrawableTurn>[0]> = {}) => ({
  messages,
  partialText: '',
  partialThinking: '',
  pendingUserMessages: [],
  sessionMeta: { turnStartTime: 100 },
  ...over,
});

describe('findWithdrawableTurn', () => {
  it('最后一条是刚发出的用户消息时可撤回', () => {
    const turn = findWithdrawableTurn(tab([msg('a', 'user', 10), msg('b', 'assistant', 20), msg('c', 'user', 100)]));
    expect(turn?.userMessageId).toBe('c');
    expect(turn?.startMsgIdx).toBe(2);
  });

  it('已有回应或正在流式输出时不可撤回', () => {
    expect(findWithdrawableTurn(tab([msg('a', 'user', 100), msg('b', 'assistant', 110)]))).toBeUndefined();
    expect(findWithdrawableTurn(tab([msg('a', 'user', 100)], { partialText: '正' }))).toBeUndefined();
    expect(findWithdrawableTurn(tab([msg('a', 'user', 100)], { partialThinking: '想' }))).toBeUndefined();
  });

  it('运行中插入的消息和还有排队消息时不可撤回', () => {
    expect(findWithdrawableTurn(tab([msg('a', 'user', 150)]))).toBeUndefined();
    expect(findWithdrawableTurn(tab([msg('a', 'user', 100)], { pendingUserMessages: [{}] }))).toBeUndefined();
  });

  it('没有消息或没有本轮开始时间时不可撤回', () => {
    expect(findWithdrawableTurn(tab([]))).toBeUndefined();
    expect(findWithdrawableTurn(tab([msg('a', 'user', 100)], { sessionMeta: {} }))).toBeUndefined();
  });
});
