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
    vi.spyOn(bridge, 'interruptSession').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'cancelQueuedMessage').mockResolvedValue(true);
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

  it('中断请求发不出去：状态改为完成，清掉 stdinId，结束进程，3 秒后兜底注销监听', async () => {
    vi.mocked(bridge.interruptSession).mockRejectedValue(new Error('stdin closed'));
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
    expect(tab().sessionMeta.userInterruptStdinId).toBeUndefined();
    expect(unlisten).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  const startReply = () => {
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin' });
    useChatStore.getState().addMessage(TAB, {
      id: 'a', role: 'assistant', type: 'text', content: '已经开始回复', timestamp: 1,
    });
  };

  it('回合进行中：只中断这一轮，保留进程和 stdinId', async () => {
    startReply();

    await stop();

    expect(bridge.interruptSession).toHaveBeenCalledWith('live_stdin');
    expect(bridge.killSession).not.toHaveBeenCalled();
    expect(tab().sessionStatus).toBe('completed');
    expect(tab().sessionMeta.stdinId).toBe('live_stdin');
    expect(tab().sessionMeta.userInterruptStdinId).toBe('live_stdin');
  });

  it('中断后排队的消息：先从 CLI 队列撤回，再放回输入框；未答复的权限卡片标记失效', async () => {
    startReply();
    useChatStore.getState().addMessage(TAB, {
      id: 'perm', role: 'assistant', type: 'permission', content: '', timestamp: 2, interactionState: 'pending',
    } as ChatMessage);
    useChatStore.getState().setInputDraft(TAB, '草稿');
    useChatStore.getState().addPendingMessage(TAB, { text: '已写入', sent: true, uuid: 'q1' });
    useChatStore.getState().addPendingMessage(TAB, {
      text: '/skill 排队中', message: {
        id: 'p2', role: 'user', type: 'text', content: '/skill 排队中', timestamp: 3,
        sendContext: { rawInput: '排队中', prefixes: [] },
      },
    });

    await stop();

    expect(bridge.cancelQueuedMessage).toHaveBeenCalledWith('live_stdin', 'q1');
    expect(bridge.interruptSession).toHaveBeenCalled();
    expect(tab().inputDraft).toBe('草稿\n\n已写入\n\n排队中');
    expect(tab().pendingUserMessages).toEqual([]);
    expect(tab().messages.find((m) => m.id === 'perm')?.interactionState).toBe('failed');
  });

  it('排队消息已被 CLI 取走、撤不回：不中断，改为结束进程', async () => {
    vi.mocked(bridge.cancelQueuedMessage).mockResolvedValue(false);
    startReply();
    useChatStore.getState().addPendingMessage(TAB, { text: '已写入', sent: true, uuid: 'q1' });

    await stop();

    expect(bridge.interruptSession).not.toHaveBeenCalled();
    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
  });

  it('中断后 CLI 一直不回 result：超时结束进程', async () => {
    startReply();

    await stop();
    expect(bridge.killSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
    expect(tab().sessionMeta.stdinId).toBeUndefined();
    expect(tab().sessionMeta.userInterruptStdinId).toBeUndefined();
  });

  it('不在运行中（进程空闲）：不发中断，照旧结束进程', async () => {
    useChatStore.getState().setSessionStatus(TAB, 'completed');
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin' });

    await stop();

    expect(bridge.interruptSession).not.toHaveBeenCalled();
    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
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

  it('撤回失败、进程还在：改为中断这一轮', async () => {
    executeRewind.mockResolvedValue(false);
    useChatStore.getState().addMessage(TAB, { id: 'u', role: 'user', type: 'text', content: '你好', timestamp: 100 });
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin', turnStartTime: 100 });

    await stop();

    expect(restoreSendExtras).not.toHaveBeenCalled();
    expect(bridge.interruptSession).toHaveBeenCalledWith('live_stdin');
    expect(bridge.killSession).not.toHaveBeenCalled();
  });

  it('撤回失败、进程已在撤回过程中结束：不再中断，照旧走结束进程的收尾', async () => {
    executeRewind.mockImplementation(async () => {
      useChatStore.getState().setSessionMeta(TAB, { stdinId: undefined });
      return false;
    });
    useChatStore.getState().addMessage(TAB, { id: 'u', role: 'user', type: 'text', content: '你好', timestamp: 100 });
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live_stdin', turnStartTime: 100 });

    await stop();

    expect(bridge.interruptSession).not.toHaveBeenCalled();
    expect(bridge.killSession).toHaveBeenCalledWith('live_stdin');
  });
});
