// 回退进行中的标签页。回退要先定位回退点、结束 CLI 进程，再改写对话和输入框，
// 中间要等一会；这段时间里再发送、终止、回退或编辑消息，会和回退的后半段互相覆盖
// （新消息被截掉、新进程被当成旧进程结束、输入框被回填覆盖），所以按标签页加锁。
import { create } from 'zustand';

interface RewindLockState {
  /** 正在回退的标签页 ID */
  tabs: ReadonlySet<string>;
}

const useRewindLockStore = create<RewindLockState>(() => ({ tabs: new Set() }));

/** 该标签页是否正在回退 */
export function isRewinding(tabId: string | null | undefined): boolean {
  return !!tabId && useRewindLockStore.getState().tabs.has(tabId);
}

/** 开始回退：已在回退中返回 false（调用方应放弃本次操作） */
export function beginRewind(tabId: string): boolean {
  const { tabs } = useRewindLockStore.getState();
  if (tabs.has(tabId)) return false;
  useRewindLockStore.setState({ tabs: new Set(tabs).add(tabId) });
  return true;
}

/** 结束回退（无论成功与否都要调用） */
export function endRewind(tabId: string): void {
  const { tabs } = useRewindLockStore.getState();
  if (!tabs.has(tabId)) return;
  const next = new Set(tabs);
  next.delete(tabId);
  useRewindLockStore.setState({ tabs: next });
}

/** React 订阅：该标签页是否正在回退 */
export function useIsRewinding(tabId: string | null | undefined): boolean {
  return useRewindLockStore((s) => !!tabId && s.tabs.has(tabId));
}
