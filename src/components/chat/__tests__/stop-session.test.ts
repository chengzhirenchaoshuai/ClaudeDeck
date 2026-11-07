import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
};
vi.stubGlobal('sessionStorage', memoryStorage());
vi.stubGlobal('localStorage', memoryStorage());

const { useChatStore } = await import('../../../stores/chatStore');
const { useSessionStore } = await import('../../../stores/sessionStore');
const { bridge } = await import('../../../lib/tauri-bridge');
const { stopCurrentSession } = await import('../stop-session');
import type { ChatMessage } from '../../../stores/chatStore';
import type { SpawningSessions } from '../stop-session';

const TAB = 'stop_session_tab';
const tab = () => useChatStore.getState().getTab(TAB)!;

describe('stopCurrentSession', () => {
  let unlisten: ReturnType<typeof vi.fn>;
  let executeRewind: ReturnType<typeof vi.fn>;
  let restoreSendExtras: ReturnType<typeof vi.fn>;
  let spawning: SpawningSessions;

  beforeEach(() => {
    vi.useFakeTimers();
    unlisten = vi.fn();
    vi.stubGlobal('window', { __claudeUnlisteners: { live_stdin: unlisten, spawn_stdin: unlisten } });
    vi.spyOn(bridge, 'killSession').mockResolvedValue(undefined);
    executeRewind = vi.fn().mockResolvedValue(true);
    restoreSendExtras = vi.fn();
    spawning = new Map();
    useChatStore.getState().ensureTab(TAB);
    useChatStore.getState().resetTab(TAB);
    useSessionStore.setState({ selectedSessionId: TAB });
    useChatStore.getState().setSessionStatus(TAB, 'running');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  const stop = () => stopCurrentSession({
    spawning,
    executeRewind: executeRewind as never,
    restoreSendExtras: restoreSendExtras as never,
  });

  it('进程运行中：状态改为完成，清掉 stdinId，结束进程，3 秒后兜底注销监听', async () => {
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin' });
    useChatStore.getState().addMessage(TAB, {
      id: 'a', role: 'assistant', type: 'text', content: '已经开始回复', timestamp: 1,
    });

    await stop();

    expect(tab().sessionStatus).toBe('completed');
    expect(tab().activityStatus.phase).toBe('completed');
    expect(tab().sessionMeta.stdinId).toBeUndefined();
    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
    expect(executeRewind).not.toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('进程还在启动：标记取消并注销它的监听，由启动流程拿到进程后结束', async () => {
    const spawn = { stdinId: 'spawn_stdin', cancelled: false };
    spawning.set(TAB, spawn);

    await stop();

    expect(spawn.cancelled).toBe(true);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(bridge.killSession).not.toHaveBeenCalled();
  });

  it('刚发出还没有回应：撤回这条消息，原始输入接在草稿前放回输入框，不再结束进程', async () => {
    const sent: ChatMessage = {
      id: 'u', role: 'user', type: 'text', content: '/review',
      timestamp: 100, sendContext: { rawInput: '原始输入', prefixes: [] },
    };
    useChatStore.getState().addMessage(TAB, sent);
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin', turnStartTime: 100 });
    useChatStore.getState().setInputDraft(TAB, ' 新草稿 ');

    await stop();

    expect(executeRewind).toHaveBeenCalledWith(expect.anything(), 'restore_conversation', '原始输入\n新草稿', true);
    expect(restoreSendExtras).toHaveBeenCalledWith(TAB, expect.objectContaining({ id: 'u' }));
    expect(bridge.killSession).not.toHaveBeenCalled();
  });

  it('撤回失败时照常结束进程', async () => {
    executeRewind.mockResolvedValue(false);
    useChatStore.getState().addMessage(TAB, { id: 'u', role: 'user', type: 'text', content: '你好', timestamp: 100 });
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin', turnStartTime: 100 });

    await stop();

    expect(restoreSendExtras).not.toHaveBeenCalled();
    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
  });
});
