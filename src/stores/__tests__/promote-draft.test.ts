import { beforeEach, describe, expect, it, vi } from 'vitest';

// 测试环境是 node，没有 sessionStorage；promoteDraft 会写入上次会话 ID 和 stdin 映射
const memory = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
});

const { useSessionStore, keepPendingDrafts } = await import('../sessionStore');
const { bridge } = await import('../../lib/tauri-bridge');
import type { SessionListItem } from '../../lib/tauri-bridge';

const DRAFT = 'draft_1_abc';
const REAL = '350834e4-78bd-43c9-8678-a53c394af2da';

const item = (id: string, path: string, preview = '', host?: string): SessionListItem => ({
  id,
  path,
  project: 'F:\\work',
  projectDir: 'F--work',
  modifiedAt: 0,
  preview,
  ...(host ? { host } : {}),
});

describe('草稿转为真实会话', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], selectedSessionId: null });
  });

  it('真实会话还没出现在列表里时，草稿行改用真实 ID', () => {
    useSessionStore.setState({ sessions: [item(DRAFT, '')], selectedSessionId: DRAFT });
    useSessionStore.getState().promoteDraft(DRAFT, REAL);

    const { sessions, selectedSessionId } = useSessionStore.getState();
    expect(sessions.map((s) => s.id)).toEqual([REAL]);
    expect(selectedSessionId).toBe(REAL);
  });

  it('文件监听已先把真实会话加进列表时，去掉草稿行而不是产生两条同 ID 的行', () => {
    useSessionStore.setState({
      sessions: [item(DRAFT, ''), item(REAL, 'F:\\x\\350834e4.jsonl', '这个网站是干什么的')],
      selectedSessionId: DRAFT,
    });
    useSessionStore.getState().promoteDraft(DRAFT, REAL);

    const { sessions, selectedSessionId } = useSessionStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].path).not.toBe('');
    expect(sessions[0].preview).toBe('这个网站是干什么的');
    expect(selectedSessionId).toBe(REAL);
  });
});

describe('远程模式下新建会话（影子行的真实复现路径）', () => {
  const HOST = 'mylocal';
  const remoteRow = item(REAL, 'ssh://mylocal/C:/Users/peng/.claude/projects/F--work/350834e4.jsonl', '这个网站是干什么的', HOST);

  beforeEach(() => {
    vi.restoreAllMocks();
    useSessionStore.setState({ sessions: [], remoteSessions: [], selectedSessionId: null });
    vi.spyOn(bridge, 'listSessions').mockResolvedValue([]);
    vi.spyOn(bridge, 'listRemoteHosts').mockResolvedValue([{ id: HOST } as any]);
    vi.spyOn(bridge, 'listRemoteSessions').mockResolvedValue([remoteRow]);
    vi.spyOn(bridge, 'loadRemoteCustomPreviews').mockResolvedValue({});
  });

  it('草稿转为真实 ID 后拉取远程列表，只留下远端的那一行（带标题）', async () => {
    useSessionStore.setState({ sessions: [item(DRAFT, '', '', HOST)], selectedSessionId: DRAFT });
    useSessionStore.getState().promoteDraft(DRAFT, REAL);
    // 本机刷新看不到远端会话，草稿行还要保留
    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([REAL]);

    await useSessionStore.getState().fetchRemoteSessions();
    let rows = useSessionStore.getState().sessions.filter((s) => s.id === REAL);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe('这个网站是干什么的');

    // 之后再做本机刷新也不会把草稿行带回来
    await useSessionStore.getState().fetchSessions();
    rows = useSessionStore.getState().sessions.filter((s) => s.id === REAL);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).not.toBe('');
  });

  it('还没转为真实 ID 的草稿在拉取远程列表后仍然保留', async () => {
    useSessionStore.setState({ sessions: [item(DRAFT, '', '', HOST)], selectedSessionId: DRAFT });
    await useSessionStore.getState().fetchRemoteSessions();
    expect(useSessionStore.getState().sessions.map((s) => s.id).sort()).toEqual([DRAFT, REAL].sort());
  });
});

describe('keepPendingDrafts', () => {
  it('只保留列表里还没有同 ID 会话的草稿行', () => {
    const sessions = [item('draft_a', ''), item(REAL, ''), item('real-b', 'x.jsonl')];
    expect(keepPendingDrafts(sessions, [item(REAL, 'y.jsonl')]).map((s) => s.id)).toEqual(['draft_a']);
  });
});

describe('touchSession', () => {
  it('发消息后立即更新最后发言时间，远程会话同步更新；不会把时间往回改', () => {
    const remote = { ...item(REAL, 'ssh://h/C:/x.jsonl', '', 'h'), lastPromptAt: 1_000 };
    useSessionStore.setState({ sessions: [remote], remoteSessions: [remote] });

    useSessionStore.getState().touchSession(REAL, 5_000);
    expect(useSessionStore.getState().sessions[0].lastPromptAt).toBe(5_000);
    expect(useSessionStore.getState().remoteSessions[0].lastPromptAt).toBe(5_000);

    useSessionStore.getState().touchSession(REAL, 3_000);
    expect(useSessionStore.getState().sessions[0].lastPromptAt).toBe(5_000);
  });
});
