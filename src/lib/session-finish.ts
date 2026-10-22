/**
 * 比较前后两份“运行中会话”集合，返回刚刚结束的会话 ID。
 * 同时有移除和新增，是草稿升级为正式会话（ID 替换），不算会话结束。
 */
export function finishedSessionIds(prev: Set<string>, next: Set<string>): string[] {
  const removed = [...prev].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !prev.has(id));
  return added.length > 0 ? [] : removed;
}

/**
 * 比较前后两份终端会话状态，返回刚刚回复完（busy → idle）的会话 ID。
 * 条目消失（终端进程退出、切换了远程主机）不算回复完成。
 */
export function finishedTerminalSessionIds(
  prev: Map<string, string>,
  next: Map<string, string>,
): string[] {
  return [...next]
    .filter(([id, status]) => status === 'idle' && prev.get(id) === 'busy')
    .map(([id]) => id);
}
