// 各会话的后台任务列表（不持久化；进程退出后任务随之结束）。状态更新规则见 lib/background-tasks.ts
import { create } from 'zustand';
import type { BackgroundTaskEntry, TaskPatch } from '../lib/stream-message';
import {
  applyLiveList, applyNotification, applyPatch, endAll, isRunning,
  type BackgroundTask, type TaskStartInfo,
} from '../lib/background-tasks';

const EMPTY: BackgroundTask[] = [];
/** 只为还没进入列表的任务保留开始信息，超过这个数就丢掉最早的（前台任务的 task_started 也会进来） */
const MAX_START_INFO = 200;

interface BackgroundTaskState {
  tasksByTab: Map<string, BackgroundTask[]>;
  /** task_started 记下的补充信息，按 task_id */
  startInfo: Map<string, TaskStartInfo>;
  recordStart: (taskId: string, info: TaskStartInfo) => void;
  applyLiveList: (tabId: string, entries: BackgroundTaskEntry[]) => void;
  applyNotification: (tabId: string, taskId: string, status?: string, summary?: string) => void;
  applyPatch: (tabId: string, taskId: string, patch: TaskPatch) => void;
  /** CLI 进程退出 */
  endAll: (tabId: string) => void;
  /** 清掉已结束的任务 */
  clearEnded: (tabId: string) => void;
  /** 草稿会话升级为正式会话（ID 替换） */
  renameTab: (oldId: string, newId: string) => void;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>()((set, get) => {
  /** 用 update 计算出新列表；没变化时不触发更新 */
  const update = (tabId: string, fn: (tasks: BackgroundTask[]) => BackgroundTask[]) => {
    const prev = get().tasksByTab.get(tabId) ?? EMPTY;
    const next = fn(prev);
    if (next === prev) return;
    const tasksByTab = new Map(get().tasksByTab);
    if (next.length === 0) tasksByTab.delete(tabId);
    else tasksByTab.set(tabId, next);
    set({ tasksByTab });
  };

  return {
    tasksByTab: new Map(),
    startInfo: new Map(),

    recordStart: (taskId, info) => {
      const startInfo = new Map(get().startInfo);
      startInfo.set(taskId, info);
      if (startInfo.size > MAX_START_INFO) startInfo.delete(startInfo.keys().next().value!);
      set({ startInfo });
    },

    applyLiveList: (tabId, entries) => {
      update(tabId, (tasks) => applyLiveList(tasks, entries, get().startInfo, Date.now()));
    },

    applyNotification: (tabId, taskId, status, summary) => {
      update(tabId, (tasks) => applyNotification(tasks, taskId, status, summary, Date.now()));
    },

    applyPatch: (tabId, taskId, patch) => {
      update(tabId, (tasks) => applyPatch(tasks, taskId, patch, Date.now()));
    },

    endAll: (tabId) => {
      update(tabId, (tasks) => endAll(tasks, Date.now()));
    },

    clearEnded: (tabId) => {
      update(tabId, (tasks) => (tasks.some((t) => !isRunning(t)) ? tasks.filter(isRunning) : tasks));
    },

    renameTab: (oldId, newId) => {
      const tasks = get().tasksByTab.get(oldId);
      if (!tasks) return;
      const tasksByTab = new Map(get().tasksByTab);
      tasksByTab.delete(oldId);
      tasksByTab.set(newId, [...(tasksByTab.get(newId) ?? []), ...tasks]);
      set({ tasksByTab });
    },
  };
});

/** 某个会话的后台任务（没有时返回同一个空数组，避免无谓的重新渲染） */
export function useTabBackgroundTasks(tabId: string | null | undefined): BackgroundTask[] {
  return useBackgroundTaskStore((s) => (tabId ? s.tasksByTab.get(tabId) : undefined) ?? EMPTY);
}
