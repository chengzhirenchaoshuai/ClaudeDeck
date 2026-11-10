// 会话同步：已回退、新分支还没建立时，不能用磁盘上的旧分支覆盖界面（远程会话终止撤回后的回归）。
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

const { syncSession, applyDiskSession } = await import('../session-sync');
const { useChatStore } = await import('../../stores/chatStore');
const { useSessionStore } = await import('../../stores/sessionStore');
const { bridge } = await import('../tauri-bridge');
import type { SessionListItem } from '../tauri-bridge';

const SID = 'remote-1';
const PATH = 'ssh://h/C:/Users/me/.claude/projects/p/remote-1.jsonl';
const session: SessionListItem = {
  id: SID, path: PATH, project: 'ssh://h/C:/p', projectDir: 'p', modifiedAt: 0, preview: '', host: 'h',
};
const rec = (uuid: string, type: 'user' | 'assistant', text: string) => ({
  type, uuid, timestamp: 1, message: { content: [{ type: 'text', text }] },
});
const contents = () => useChatStore.getState().getTab(SID)?.messages.map((m) => m.content);

describe('syncSession', () => {
  beforeEach(() => {
    useSessionStore.setState({ selectedSessionId: SID });
    useChatStore.getState().ensureTab(SID);
    vi.spyOn(bridge, 'getSessionTokens').mockResolvedValue(null as never);
    vi.spyOn(bridge, 'listActiveProcesses').mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('撤回后磁盘上仍有被撤回的消息：不重新加载；新分支建立后恢复同步', async () => {
    const load = vi.spyOn(bridge, 'loadSession');
    // 从历史列表打开会话（记下记录数，之后不再视为本应用驱动）
    load.mockResolvedValueOnce([rec('u1', 'user', 'hi'), rec('a1', 'assistant', 'hello')]);
    await applyDiskSession(SID, PATH);
    // 终止撤回：界面已截掉，磁盘上多了被撤回的消息和中断标记
    useChatStore.getState().setSessionMeta(SID, { rewoundFromSessionId: SID, resumeAtUuid: 'a1' });
    load.mockResolvedValue([
      rec('u1', 'user', 'hi'), rec('a1', 'assistant', 'hello'),
      rec('u2', 'user', 'withdrawn'), rec('u3', 'user', '[Request interrupted by user]'),
    ]);

    await syncSession(session);
    await syncSession(session, { force: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(contents()).toEqual(['hi', 'hello']);

    // 下一条消息发出、回退标记清除后照常同步
    useChatStore.getState().setSessionMeta(SID, { rewoundFromSessionId: undefined, resumeAtUuid: undefined });
    await syncSession(session);
    expect(load).toHaveBeenCalledTimes(2);
    expect(contents()).toEqual(['hi', 'hello', 'withdrawn']);
  });
});
