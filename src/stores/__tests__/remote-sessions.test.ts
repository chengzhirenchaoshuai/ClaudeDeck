// 远程会话列表：替换远程部分、单台主机失败不影响其他主机、主机被删时退回本地、远端改名覆盖本地缓存；
// 以及改名、归档写回远端：只推改动项、推送失败记下待推、退出前与拉列表前补推。
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

const { useSessionStore, hostOfPath, pendingArchivesOf, findSessionInEnv } = await import('../sessionStore');
const { useSettingsStore } = await import('../settingsStore');
const { bridge } = await import('../../lib/tauri-bridge');
import type { RemoteHost, SessionListItem } from '../../lib/tauri-bridge';

const item = (id: string, path: string, host?: string): SessionListItem => ({
  id,
  path,
  project: host ? `ssh://${host}/C:/p` : 'F:\\work',
  projectDir: 'p',
  modifiedAt: 0,
  preview: id,
  ...(host ? { host } : {}),
});
const hostCfg = (id: string): RemoteHost => ({ id, destination: id });
const ids = () => useSessionStore.getState().sessions.map((s) => s.id);

describe('hostOfPath', () => {
  it('从 ssh:// 路径取主机名，本机路径返回 undefined', () => {
    expect(hostOfPath('ssh://win-pc/C:/p')).toBe('win-pc');
    expect(hostOfPath('F:/AI/proj')).toBeUndefined();
    expect(hostOfPath('ssh://win-pc')).toBeUndefined();
  });
});

describe('findSessionInEnv', () => {
  // 远程主机就是本机时，同一个会话在本机列表和远程列表里各有一行
  const both = [item('s1', 'F:/s1.jsonl'), item('s1', 'C:/s1.jsonl', 'a'), item('s2', 'F:/s2.jsonl')];
  afterEach(() => { useSettingsStore.setState({ activeEnv: 'local' }); });

  it('远程模式下取该主机的那一行，本地模式下取本机那一行', () => {
    useSettingsStore.setState({ activeEnv: 'a' });
    expect(findSessionInEnv(both, 's1')?.host).toBe('a');
    useSettingsStore.setState({ activeEnv: 'local' });
    expect(findSessionInEnv(both, 's1')?.host).toBeUndefined();
  });

  it('只有一行时直接返回，找不到或 ID 为空返回 undefined', () => {
    useSettingsStore.setState({ activeEnv: 'a' });
    expect(findSessionInEnv(both, 's2')?.path).toBe('F:/s2.jsonl');
    expect(findSessionInEnv(both, 'nope')).toBeUndefined();
    expect(findSessionInEnv(both, null)).toBeUndefined();
  });
});

describe('fetchRemoteSessions', () => {
  beforeEach(() => {
    vi.spyOn(bridge, 'loadRemoteCustomPreviews').mockResolvedValue({});
    vi.spyOn(bridge, 'saveCustomPreviews').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'loadCachedRemoteSessions').mockResolvedValue([]);
    useSettingsStore.setState({ activeEnv: 'local' });
    useSessionStore.setState({ sessions: [], remoteSessions: [], remoteErrors: {}, customPreviews: {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ activeEnv: 'local' });
  });

  it('用最新结果替换旧的远程行，本机会话保持不变', async () => {
    useSessionStore.setState({ sessions: [item('local-1', 'F:/a.jsonl'), item('gone', 'C:/old.jsonl', 'a')] });
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockResolvedValue([item('r1', 'C:/r1.jsonl', 'a')]);

    await useSessionStore.getState().fetchRemoteSessions();

    expect(ids()).toEqual(['local-1', 'r1']);
    expect(useSessionStore.getState().isRemoteLoading).toBe(false);
  });

  it('一台主机连不上：记下错误，其他主机的会话照常列出', async () => {
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a'), hostCfg('b')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockImplementation(async (hostId: string) => {
      if (hostId === 'a') throw new Error('ssh: connect timed out');
      return [item('b1', 'C:/b1.jsonl', 'b')];
    });

    await useSessionStore.getState().fetchRemoteSessions();

    expect(ids()).toEqual(['b1']);
    expect(useSessionStore.getState().remoteErrors.a).toContain('timed out');
    expect(useSessionStore.getState().remoteErrors.b).toBeUndefined();
  });

  it('主机连不上：保留启动时读到的本地缓存列表，其他主机用最新结果', async () => {
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a'), hostCfg('b')]);
    vi.spyOn(bridge, 'loadCachedRemoteSessions').mockImplementation(async (hostId: string) =>
      hostId === 'a' ? [item('a-cached', 'C:/a1.jsonl', 'a')] : [item('b-old', 'C:/b0.jsonl', 'b')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockImplementation(async (hostId: string) => {
      if (hostId === 'a') throw new Error('ssh: connect timed out');
      return [item('b1', 'C:/b1.jsonl', 'b')];
    });

    await useSessionStore.getState().fetchRemoteSessions();

    expect(ids()).toEqual(['a-cached', 'b1']);
    expect(useSessionStore.getState().remoteErrors.a).toContain('timed out');
  });

  it('已有远程列表时不再用缓存覆盖', async () => {
    useSessionStore.setState({
      sessions: [item('fresh', 'C:/f.jsonl', 'a')],
      remoteSessions: [item('fresh', 'C:/f.jsonl', 'a')],
    });
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'loadCachedRemoteSessions').mockResolvedValue([item('stale', 'C:/s.jsonl', 'a')]);

    await useSessionStore.getState().loadCachedRemoteSessions();

    expect(ids()).toEqual(['fresh']);
  });

  it('当前所在的远程主机已被删除时退回本地模式', async () => {
    useSettingsStore.setState({ activeEnv: 'deleted-host' });
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockResolvedValue([]);

    await useSessionStore.getState().fetchRemoteSessions();

    expect(useSettingsStore.getState().activeEnv).toBe('local');
  });

  it('远端保存的会话名为准，覆盖本地缓存里的同名会话并写回本机', async () => {
    useSessionStore.setState({ customPreviews: { r1: '本地旧名', other: '保留' } });
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockResolvedValue([item('r1', 'C:/r1.jsonl', 'a')]);
    vi.mocked(bridge.loadRemoteCustomPreviews).mockResolvedValue({ r1: '远端新名' });

    await useSessionStore.getState().fetchRemoteSessions();

    expect(useSessionStore.getState().customPreviews).toEqual({ r1: '远端新名', other: '保留' });
    expect(bridge.saveCustomPreviews).toHaveBeenCalledWith({ r1: '远端新名', other: '保留' });
  });

  it('列主机失败时不清空现有列表，只结束加载状态', async () => {
    useSessionStore.setState({ sessions: [item('r1', 'C:/r1.jsonl', 'a')] });
    vi.spyOn(bridge, 'listRemoteHosts').mockRejectedValue(new Error('boom'));

    await useSessionStore.getState().fetchRemoteSessions();

    expect(ids()).toEqual(['r1']);
    expect(useSessionStore.getState().isRemoteLoading).toBe(false);
  });
});

describe('removeRemoteSession', () => {
  it('只删除远程行，本机上同 ID 的会话（指向本机的远程主机）保留', () => {
    useSessionStore.setState({
      sessions: [item('same', 'F:/same.jsonl'), item('same', 'C:/same.jsonl', 'a'), item('r2', 'C:/r2.jsonl', 'a')],
      remoteSessions: [item('same', 'C:/same.jsonl', 'a'), item('r2', 'C:/r2.jsonl', 'a')],
    });

    useSessionStore.getState().removeRemoteSession('same');

    const { sessions, remoteSessions } = useSessionStore.getState();
    expect(sessions.map((s) => [s.id, s.host ?? 'local'])).toEqual([['same', 'local'], ['r2', 'a']]);
    expect(remoteSessions.map((s) => s.id)).toEqual(['r2']);
  });
});

describe('改名写回远程主机', () => {
  const PENDING_KEY = 'tokenicode_pending_remote_names';

  beforeEach(() => {
    localStorage.removeItem(PENDING_KEY);
    vi.spyOn(bridge, 'saveCustomPreviews').mockResolvedValue(undefined);
    useSessionStore.setState({
      sessions: [item('r1', 'C:/r1.jsonl', 'a'), item('local-1', 'F:/a.jsonl')],
      customPreviews: {},
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('只把这一条改动发给远端，不整份覆盖（别的客户端刚改的名字才不会被抹掉）', async () => {
    const merge = vi.spyOn(bridge, 'mergeRemoteCustomPreviews').mockResolvedValue(undefined);
    useSessionStore.setState({ customPreviews: { r1: '旧名', hidden: '隐藏会话的名字' } });

    useSessionStore.getState().setCustomPreview('r1', '新名');

    await vi.waitFor(() => expect(merge).toHaveBeenCalledWith('a', { r1: '新名' }));
  });

  it('本机会话的改名不往远端推', async () => {
    const merge = vi.spyOn(bridge, 'mergeRemoteCustomPreviews').mockResolvedValue(undefined);

    useSessionStore.getState().setCustomPreview('local-1', '本机名');
    await Promise.resolve();

    expect(merge).not.toHaveBeenCalled();
  });

  it('推不上去时记下待推，补推成功后清空', async () => {
    const merge = vi.spyOn(bridge, 'mergeRemoteCustomPreviews')
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('ssh: connect timed out'));

    useSessionStore.getState().setCustomPreview('r1', '断网时改的');
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(PENDING_KEY) || '{}')).toEqual({ a: { r1: '断网时改的' } }));

    await useSessionStore.getState().flushPendingRemoteNames();

    expect(merge).toHaveBeenLastCalledWith('a', { r1: '断网时改的' });
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('补推又失败就继续留着，下次启动再推', async () => {
    vi.spyOn(bridge, 'mergeRemoteCustomPreviews').mockRejectedValue(new Error('还是连不上'));

    useSessionStore.getState().setCustomPreview('r1', '断网时改的');
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(PENDING_KEY) || '{}')).toEqual({ a: { r1: '断网时改的' } }));

    await useSessionStore.getState().flushPendingRemoteNames();

    expect(JSON.parse(localStorage.getItem(PENDING_KEY) || '{}')).toEqual({ a: { r1: '断网时改的' } });
  });

  it('拉远程列表前先补推，待推的名字才不会被远端旧值盖回', async () => {
    const order: string[] = [];
    vi.spyOn(bridge, 'mergeRemoteCustomPreviews').mockImplementation(async () => { order.push('merge'); });
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockImplementation(async () => { order.push('list'); return []; });
    vi.spyOn(bridge, 'loadRemoteCustomPreviews').mockResolvedValue({});
    localStorage.setItem(PENDING_KEY, JSON.stringify({ a: { r1: '待推的名字' } }));

    await useSessionStore.getState().fetchRemoteSessions();

    expect(order).toEqual(['merge', 'list']);
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('归档写回远程主机', () => {
  const PENDING_KEY = 'claudedeck_pending_remote_archives';
  const pending = () => JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');

  beforeEach(() => { localStorage.removeItem(PENDING_KEY); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('只发改动项交给远端合并，成功后不留待推', async () => {
    const merge = vi.spyOn(bridge, 'mergeRemoteArchivedSessions').mockResolvedValue(undefined);

    await useSessionStore.getState().pushRemoteArchive('a', { r1: true, r2: false });

    expect(merge).toHaveBeenCalledWith('a', { r1: true, r2: false });
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('推不上去时记下待推，补推成功后清空', async () => {
    const merge = vi.spyOn(bridge, 'mergeRemoteArchivedSessions')
      .mockRejectedValueOnce(new Error('ssh: connect timed out'))
      .mockResolvedValue(undefined);

    await useSessionStore.getState().pushRemoteArchive('a', { r1: true });
    expect(pending()).toEqual({ a: { r1: true } });
    expect(pendingArchivesOf('a')).toEqual({ r1: true });

    await useSessionStore.getState().flushPendingRemoteArchives();

    expect(merge).toHaveBeenLastCalledWith('a', { r1: true });
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('离线时先归档又取消：待推里只留最后的状态', async () => {
    vi.spyOn(bridge, 'mergeRemoteArchivedSessions').mockRejectedValue(new Error('连不上'));

    await useSessionStore.getState().pushRemoteArchive('a', { r1: true });
    await useSessionStore.getState().pushRemoteArchive('a', { r1: false });

    expect(pending()).toEqual({ a: { r1: false } });
  });

  it('拉远程列表前先补推，待推的归档才不会被远端旧状态盖回', async () => {
    const order: string[] = [];
    vi.spyOn(bridge, 'mergeRemoteArchivedSessions').mockImplementation(async () => { order.push('merge'); });
    vi.spyOn(bridge, 'loadCachedRemoteSessions').mockResolvedValue([]);
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([hostCfg('a')]);
    vi.spyOn(bridge, 'listRemoteSessions').mockImplementation(async () => { order.push('list'); return []; });
    vi.spyOn(bridge, 'loadRemoteCustomPreviews').mockResolvedValue({});
    localStorage.setItem(PENDING_KEY, JSON.stringify({ a: { r1: true } }));

    await useSessionStore.getState().fetchRemoteSessions();

    expect(order).toEqual(['merge', 'list']);
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});
