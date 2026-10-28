import { beforeEach, describe, expect, it, vi } from 'vitest';

// 测试环境是 node，没有 sessionStorage / localStorage
const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
};
vi.stubGlobal('sessionStorage', storage);
vi.stubGlobal('localStorage', storage);

const { useChatStore } = await import('../chatStore');

const TAB = 'activity_test_tab';
const status = () => useChatStore.getState().getTab(TAB)!.activityStatus;

describe('运行状态', () => {
  beforeEach(() => {
    useChatStore.getState().ensureTab(TAB);
    useChatStore.getState().resetTab(TAB);
  });

  it('连续两次同名工具：第二次的参数和运行中列表也要写进去', () => {
    const store = useChatStore.getState();
    store.setActivityStatus(TAB, { phase: 'tool', toolName: 'Read', toolInput: { file_path: 'a.ts' }, runningToolIds: ['t1'] });
    store.setActivityStatus(TAB, { phase: 'tool', toolName: 'Read', toolInput: { file_path: 'b.ts' }, runningToolIds: ['t1', 't2'] });
    expect(status().toolInput.file_path).toBe('b.ts');
    expect(status().runningToolIds).toEqual(['t1', 't2']);
  });

  it('等待确认后恢复成之前的工具；还有待确认卡片时继续等待', () => {
    const store = useChatStore.getState();
    store.setActivityStatus(TAB, { phase: 'tool', toolName: 'Bash', toolInput: { command: 'ls' }, runningToolIds: ['t1'] });
    store.awaitUser(TAB);
    expect(status().phase).toBe('awaiting');

    store.addMessage(TAB, { id: 'p1', role: 'assistant', type: 'permission', content: '', timestamp: 0, interactionState: 'pending' });
    store.resumeAfterAwaiting(TAB);
    expect(status().phase).toBe('awaiting');

    store.updateMessage(TAB, 'p1', { interactionState: 'resolved' });
    store.resumeAfterAwaiting(TAB);
    expect(status().phase).toBe('tool');
    expect(status().toolName).toBe('Bash');
  });

  it('等待前不是工具阶段时，回复后回到思考', () => {
    const store = useChatStore.getState();
    store.setActivityStatus(TAB, { phase: 'writing' });
    store.awaitUser(TAB);
    store.resumeAfterAwaiting(TAB);
    expect(status().phase).toBe('thinking');
  });
});
