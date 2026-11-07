// 远程会话列表：替换远程部分、单台主机失败不影响其他主机、主机被删时退回本地、远端改名覆盖本地缓存。
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

const { useSessionStore, hostOfPath } = await import('../sessionStore');
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

describe('fetchRemoteSessions', () => {
  beforeEach(() => {
    vi.spyOn(bridge, 'loadRemoteCustomPreviews').mockResolvedValue({});
    vi.spyOn(bridge, 'saveCustomPreviews').mockResolvedValue(undefined);
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
