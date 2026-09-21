/**
 * 比较前后两份“运行中会话”集合，返回刚刚结束的会话 ID。
 * 同时有移除和新增，是草稿升级为正式会话（ID 替换），不算会话结束。
 */
export function finishedSessionIds(prev: Set<string>, next: Set<string>): string[] {
  const removed = [...prev].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !prev.has(id));
  return added.length > 0 ? [] : removed;
}
