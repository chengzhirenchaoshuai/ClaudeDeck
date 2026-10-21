import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore, type ChatMessage } from '../chatStore';

const TAB = 'pending_test_tab';

const bubble = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  type: 'text',
  content,
  timestamp: 0,
});

const pending = () => useChatStore.getState().getTab(TAB)?.pendingUserMessages ?? [];

describe('运行中发出的消息', () => {
  beforeEach(() => {
    useChatStore.getState().ensureTab(TAB);
    useChatStore.getState().clearPendingMessages(TAB);
  });

  it('按 CLI 回显的文本取出已发送的消息，忽略换行符差异', () => {
    const store = useChatStore.getState();
    store.addPendingMessage(TAB, { text: '第一条\r\n继续', message: bubble('a', '第一条'), sent: true });
    store.addPendingMessage(TAB, { text: '第二条', message: bubble('b', '第二条'), sent: true });

    expect(store.takeSentPendingMessage(TAB, '第二条')?.message?.id).toBe('b');
    expect(store.takeSentPendingMessage(TAB, '第一条\n继续 ')?.message?.id).toBe('a');
    expect(pending()).toHaveLength(0);
  });

  it('回显对不上时不取出任何消息', () => {
    const store = useChatStore.getState();
    store.addPendingMessage(TAB, { text: '已发送', message: bubble('a', '已发送'), sent: true });
    expect(store.takeSentPendingMessage(TAB, '别的消息')).toBeUndefined();
    expect(pending()).toHaveLength(1);
  });

  it('本轮结束时只取出排队（未发送）的消息', () => {
    const store = useChatStore.getState();
    store.addPendingMessage(TAB, { text: '已发送', message: bubble('a', '已发送'), sent: true });
    store.addPendingMessage(TAB, { text: '/cost', message: bubble('b', '/cost') });

    expect(store.shiftPendingMessage(TAB)?.text).toBe('/cost');
    expect(store.shiftPendingMessage(TAB)).toBeUndefined();
    expect(pending().map((p) => p.text)).toEqual(['已发送']);
  });

  it('进程被替换后已发送的消息改回排队', () => {
    const store = useChatStore.getState();
    store.addPendingMessage(TAB, { text: '一', message: bubble('a', '一'), sent: true });
    store.addPendingMessage(TAB, { text: '二', message: bubble('b', '二'), sent: true });

    store.markPendingUnsent(TAB, 'b');
    expect(pending().map((p) => !!p.sent)).toEqual([true, false]);

    store.markPendingUnsent(TAB);
    expect(pending().some((p) => p.sent)).toBe(false);
    expect(store.takeSentPendingMessage(TAB, '一')).toBeUndefined();
  });
});
