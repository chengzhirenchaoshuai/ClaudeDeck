import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 测试环境是 node，没有 sessionStorage；切换会话会写入上次会话 ID 和 stdin 映射
const memory = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
});
// 流事件监听器登记在 window 上
vi.stubGlobal('window', {});

const { useSessionStore } = await import('../../stores/sessionStore');
const { useChatStore } = await import('../../stores/chatStore');
const { bridge } = await import('../tauri-bridge');
const { installDraftCleanup } = await import('../draft-cleanup');

const DRAFT = 'draft_1_abc';
const OTHER = '350834e4-78bd-43c9-8678-a53c394af2da';

describe('空草稿会话自动清理', () => {
  let uninstall: () => void;
  const kill = vi.spyOn(bridge, 'killSession').mockResolvedValue();

  beforeEach(() => {
    kill.mockClear();
    useSessionStore.setState({ sessions: [], selectedSessionId: null });
    useChatStore.getState().removeTab(DRAFT);
    uninstall = installDraftCleanup();
    useChatStore.getState().ensureTab(DRAFT);
    useSessionStore.getState().addDraftSession(DRAFT, 'F:\\work');
  });
  afterEach(() => uninstall());

  it('没发消息就切走：移除草稿、标签页，并结束预热进程', () => {
    useChatStore.getState().setSessionMeta(DRAFT, { stdinId: 'desk_1' });
    useSessionStore.getState().setSelectedSession(null);

    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().getTab(DRAFT)).toBeUndefined();
    expect(kill).toHaveBeenCalledWith('desk_1');
  });

  it('输入框里写了内容的草稿保留', () => {
    useChatStore.getState().setInputDraft(DRAFT, '还没发出去的话');
    useSessionStore.getState().setSelectedSession(OTHER);

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([DRAFT]);
  });

  it('已有消息的草稿保留', () => {
    useChatStore.getState().addMessage(DRAFT, {
      id: 'm1', role: 'user', type: 'text', content: 'hi', timestamp: 0,
    });
    useSessionStore.getState().setSelectedSession(OTHER);

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([DRAFT]);
    expect(kill).not.toHaveBeenCalled();
  });
});
