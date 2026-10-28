import { beforeEach, describe, expect, it, vi } from 'vitest';

// 测试环境是 node，没有 sessionStorage；promoteDraft 会写入上次会话 ID 和 stdin 映射
const memory = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
});

const { useSessionStore } = await import('../sessionStore');
import type { SessionListItem } from '../../lib/tauri-bridge';

const DRAFT = 'draft_1_abc';
const REAL = '350834e4-78bd-43c9-8678-a53c394af2da';

const item = (id: string, path: string, preview = ''): SessionListItem => ({
  id,
  path,
  project: 'F:\\work',
  projectDir: 'F--work',
  modifiedAt: 0,
  preview,
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
