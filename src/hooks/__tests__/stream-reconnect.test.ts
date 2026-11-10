// 页面刷新后重新接上存活的 CLI 进程：只有刷新前真在运行的标签页恢复成运行中，空闲的保持空闲；孤儿进程结束掉。
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

const registerSessionListeners = vi.fn().mockResolvedValue(undefined);
vi.mock('../../components/chat/session-launch', () => ({ registerSessionListeners }));

const { useChatStore } = await import('../../stores/chatStore');
const { useSessionStore } = await import('../../stores/sessionStore');
const { bridge } = await import('../../lib/tauri-bridge');
const { dispatchToStreamHandler } = await import('../../lib/stream-listeners');
const { loadRunningTabs, persistRunningTabs, reconnectSessions } = await import('../stream/reconnect');

const tab = (id: string) => useChatStore.getState().getTab(id)!;

describe('reconnectSessions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.spyOn(bridge, 'killSession').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'getSessionTokens').mockRejectedValue(new Error('no jsonl'));
    registerSessionListeners.mockClear();
    for (const id of ['busy', 'idle']) {
      useChatStore.getState().ensureTab(id);
      useChatStore.getState().resetTab(id);
    }
    useSessionStore.setState({ stdinToTab: { s_busy: 'busy', s_idle: 'idle' }, runningSessions: new Set() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('刷新前在运行的恢复为运行中，空闲的只接回 stdinId；两者都注册完整的流监听', async () => {
    await reconnectSessions(['s_busy', 's_idle'], new Set(['busy']));

    expect(tab('busy').sessionStatus).toBe('running');
    expect(tab('busy').sessionMeta.stdinId).toBe('s_busy');
    expect(tab('idle').sessionStatus).not.toBe('running');
    expect(tab('idle').sessionMeta.stdinId).toBe('s_idle');
    expect(useSessionStore.getState().runningSessions.has('idle')).toBe(false);
    expect(registerSessionListeners).toHaveBeenCalledWith('s_busy', expect.any(Function), dispatchToStreamHandler, expect.any(Function));
    expect(registerSessionListeners).toHaveBeenCalledWith('s_idle', expect.any(Function), dispatchToStreamHandler, expect.any(Function));
    expect(bridge.killSession).not.toHaveBeenCalled();
  });

  it('恢复刷新前记下的进程启动快照，并标记切到它时从磁盘重新加载历史', async () => {
    await reconnectSessions(['s_idle'], new Set(), {
      s_idle: { stdinId: 's_idle', envFingerprint: 'fp', snapshotMode: 'code', spawnedModel: 'm1' },
    });
    expect(tab('idle').sessionMeta).toMatchObject({
      stdinId: 's_idle', envFingerprint: 'fp', snapshotMode: 'code', spawnedModel: 'm1', reloadFromDisk: true,
    });
  });

  it('restoreFromCache：带重新加载标记的按缓存缺失处理，保留属于本标签页的进程和运行状态', async () => {
    useSessionStore.setState({ sessions: [{ id: 'busy', path: 'F:/x/busy.jsonl', project: 'F:/x', projectDir: 'x', modifiedAt: 0, preview: '' }] } as never);
    await reconnectSessions(['s_busy'], new Set(['busy']), { s_busy: { stdinId: 's_busy', envFingerprint: 'fp' } });
    useChatStore.getState().addMessage('busy', { id: 'late', role: 'assistant', type: 'text', content: '刷新后才收到的', timestamp: 1 });

    expect(useChatStore.getState().restoreFromCache('busy')).toBe(false);
    expect(tab('busy').messages).toEqual([]);
    expect(tab('busy').sessionStatus).toBe('running');
    expect(tab('busy').sessionMeta).toMatchObject({ stdinId: 's_busy', envFingerprint: 'fp' });
    expect(tab('busy').sessionMeta.reloadFromDisk).toBeUndefined();
  });

  it('restoreFromCache：stdinId 属于别的标签页时不保留', () => {
    useSessionStore.setState({
      sessions: [{ id: 'idle', path: 'F:/x/idle.jsonl', project: 'F:/x', projectDir: 'x', modifiedAt: 0, preview: '' }],
      stdinToTab: { s_other: 'busy' },
    } as never);
    useChatStore.getState().setSessionMeta('idle', { stdinId: 's_other' });
    expect(useChatStore.getState().restoreFromCache('idle')).toBe(false);
    expect(tab('idle').sessionMeta.stdinId).toBeUndefined();
  });

  it('没有标签页对应的孤儿进程：结束掉，不注册监听', async () => {
    await reconnectSessions(['s_orphan'], new Set());
    expect(bridge.killSession).toHaveBeenCalledWith('s_orphan');
    expect(registerSessionListeners).not.toHaveBeenCalled();
  });

  it('运行中的标签页变化会写入 sessionStorage，刷新后读回', () => {
    const stop = persistRunningTabs();
    useSessionStore.getState().setSessionRunning('busy', true);
    useSessionStore.getState().setSessionRunning('other', true);
    useSessionStore.getState().setSessionRunning('other', false);
    stop();
    expect([...loadRunningTabs()]).toEqual(['busy']);
  });
});

describe('dispatchToStreamHandler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('InputBar 还没挂载时先排队，挂载后按顺序补处理', () => {
    vi.stubGlobal('window', {});
    dispatchToStreamHandler({ type: 'system', subtype: 'a' } as never);
    const seen: string[] = [];
    window.__claudeStreamHandler = (m) => { seen.push((m as { subtype?: string }).subtype ?? ''); };
    dispatchToStreamHandler({ type: 'system', subtype: 'b' } as never);
    expect(seen).toEqual(['a', 'b']);
    expect(window.__claudeStreamQueue).toEqual([]);
  });
});
