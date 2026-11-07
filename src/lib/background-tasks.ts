// 后台任务列表的状态更新（纯函数）。数据来自 CLI 的 system 消息：
// - background_tasks_changed：当前全部存活任务（完整列表，替换语义），决定哪些任务“在运行”
// - task_started：开始时间、对应的工具调用（前台阻塞运行的任务也会发，所以不单独据此加入列表）
// - task_notification / task_updated：结束方式（完成 / 失败 / 已停止）
// 结束通知可能早于或晚于列表更新到达：任务先从列表消失时记为 ended，通知到了再补上具体状态。
import type { BackgroundTaskEntry, TaskPatch } from './stream-message';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'ended';

export interface BackgroundTask {
  id: string;
  /** CLI 的 task_type，如 local_bash（后台 Bash / Monitor）、local_agent（子代理） */
  type: string;
  description: string;
  /** 后台 Bash 的命令行（从对应的工具调用里取） */
  command?: string;
  toolUseId?: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** 结束摘要（task_notification.summary）或错误信息 */
  summary?: string;
}

/** task_started 带来的补充信息，任务进入列表时使用 */
export interface TaskStartInfo {
  toolUseId?: string;
  startedAt: number;
  command?: string;
}

/** 每个会话最多保留的已结束任务数 */
export const MAX_ENDED_TASKS = 20;

/** 只有后台 shell / Monitor 任务能读取输出（get_task_output） */
export function canReadOutput(task: BackgroundTask): boolean {
  return task.type === 'local_bash';
}

export const isRunning = (task: BackgroundTask) => task.status === 'running';

/** 已结束的只保留最近的 MAX_ENDED_TASKS 条；运行中的全部保留，顺序不变 */
function pruneEnded(tasks: BackgroundTask[]): BackgroundTask[] {
  const ended = tasks.filter((t) => !isRunning(t));
  if (ended.length <= MAX_ENDED_TASKS) return tasks;
  const drop = new Set(
    [...ended].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, ended.length - MAX_ENDED_TASKS),
  );
  return tasks.filter((t) => !drop.has(t));
}

/** 应用 background_tasks_changed 的完整列表 */
export function applyLiveList(
  tasks: BackgroundTask[],
  entries: BackgroundTaskEntry[],
  startInfo: ReadonlyMap<string, TaskStartInfo>,
  now: number,
): BackgroundTask[] {
  const live = new Map(entries.filter((e) => !e.ambient).map((e) => [e.task_id, e]));
  const next = tasks.map((task): BackgroundTask => {
    const entry = live.get(task.id);
    if (entry) {
      live.delete(task.id);
      // 恢复运行的任务保留原 ID：重新标为运行中
      return { ...task, type: entry.task_type, description: entry.description, status: 'running', endedAt: undefined };
    }
    return isRunning(task) ? { ...task, status: 'ended', endedAt: now } : task;
  });
  for (const entry of live.values()) {
    const info = startInfo.get(entry.task_id);
    next.push({
      id: entry.task_id,
      type: entry.task_type,
      description: entry.description,
      command: info?.command,
      toolUseId: info?.toolUseId,
      status: 'running',
      startedAt: info?.startedAt ?? now,
    });
  }
  return pruneEnded(next);
}

/** task_notification：任务结束的方式。列表里没有的任务（前台任务、ambient）忽略 */
export function applyNotification(
  tasks: BackgroundTask[],
  taskId: string,
  status: string | undefined,
  summary: string | undefined,
  now: number,
): BackgroundTask[] {
  const ended: BackgroundTaskStatus = status === 'completed' || status === 'failed' || status === 'stopped' ? status : 'ended';
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    changed = true;
    return { ...task, status: ended, endedAt: task.endedAt ?? now, summary: summary || task.summary };
  });
  return changed ? pruneEnded(next) : tasks;
}

/** task_updated：只关心结束状态与描述变化 */
export function applyPatch(tasks: BackgroundTask[], taskId: string, patch: TaskPatch, now: number): BackgroundTask[] {
  const map: Partial<Record<NonNullable<TaskPatch['status']>, BackgroundTaskStatus>> = {
    completed: 'completed', failed: 'failed', killed: 'stopped',
  };
  const ended = patch.status ? map[patch.status] : undefined;
  if (!ended && !patch.description) return tasks;
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    changed = true;
    return {
      ...task,
      ...(patch.description ? { description: patch.description } : {}),
      ...(ended ? { status: ended, endedAt: patch.end_time ?? task.endedAt ?? now, summary: patch.error || task.summary } : {}),
    };
  });
  return changed ? next : tasks;
}

/** CLI 进程退出：它的后台任务都随之结束 */
export function endAll(tasks: BackgroundTask[], now: number): BackgroundTask[] {
  if (!tasks.some(isRunning)) return tasks;
  return pruneEnded(tasks.map((t) => (isRunning(t) ? { ...t, status: 'ended', endedAt: now } : t)));
}
