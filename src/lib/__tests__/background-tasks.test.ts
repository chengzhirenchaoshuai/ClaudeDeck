import { describe, expect, it } from 'vitest';
import type { BackgroundTaskEntry } from '../stream-message';
import {
  MAX_ENDED_TASKS, applyLiveList, applyNotification, applyPatch, canReadOutput, endAll, stopFollowUp,
  type BackgroundTask, type TaskStartInfo,
} from '../background-tasks';

const entry = (id: string, extra: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry => ({
  task_id: id, task_type: 'local_bash', description: `任务 ${id}`, ...extra,
});
const noInfo = new Map<string, TaskStartInfo>();
const running = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id, type: 'local_bash', description: `任务 ${id}`, status: 'running', startedAt: 0, ...extra,
});

describe('applyLiveList', () => {
  it('新出现的任务加入列表；用 task_started 记下的开始时间和命令', () => {
    const info = new Map([['a', { startedAt: 100, toolUseId: 'tu1', command: 'pnpm dev' }]]);
    const tasks = applyLiveList([], [entry('a'), entry('b')], info, 500);
    expect(tasks).toEqual([
      { id: 'a', type: 'local_bash', description: '任务 a', command: 'pnpm dev', toolUseId: 'tu1', status: 'running', startedAt: 100 },
      { id: 'b', type: 'local_bash', description: '任务 b', command: undefined, toolUseId: undefined, status: 'running', startedAt: 500 },
    ]);
  });

  it('从列表消失的运行中任务记为已结束，已有结束状态的保持不变', () => {
    const tasks = applyLiveList([running('a'), running('b'), running('c', { status: 'completed', endedAt: 50 })], [entry('b')], noInfo, 900);
    expect(tasks.map((t) => [t.id, t.status, t.endedAt])).toEqual([['a', 'ended', 900], ['b', 'running', undefined], ['c', 'completed', 50]]);
  });

  it('CLI 自身的内部任务（ambient）不显示', () => {
    expect(applyLiveList([], [entry('a', { ambient: true })], noInfo, 0)).toEqual([]);
  });

  it('已结束的任务恢复运行（同一个 task_id）：重新标为运行中', () => {
    const tasks = applyLiveList([running('a', { status: 'ended', endedAt: 10 })], [entry('a')], noInfo, 20);
    expect(tasks[0]).toMatchObject({ status: 'running', endedAt: undefined });
  });

  it(`已结束的最多保留 ${MAX_ENDED_TASKS} 条（丢最早结束的），运行中的全部保留`, () => {
    const ended = Array.from({ length: MAX_ENDED_TASKS + 3 }, (_, i) => running(`e${i}`, { status: 'completed', endedAt: i }));
    const tasks = applyLiveList([...ended, running('live')], [entry('live')], noInfo, 999);
    expect(tasks).toHaveLength(MAX_ENDED_TASKS + 1);
    expect(tasks.map((t) => t.id)).not.toContain('e0');
    expect(tasks.map((t) => t.id)).toContain('live');
  });
});

describe('applyNotification', () => {
  it('写入结束方式和摘要', () => {
    const tasks = applyNotification([running('a')], 'a', 'failed', 'exit code 1', 300);
    expect(tasks[0]).toMatchObject({ status: 'failed', summary: 'exit code 1', endedAt: 300 });
  });

  it('列表先更新（已记为 ended）后到的通知：补上具体状态，保留原结束时间', () => {
    const tasks = applyNotification([running('a', { status: 'ended', endedAt: 100 })], 'a', 'completed', '完成', 300);
    expect(tasks[0]).toMatchObject({ status: 'completed', endedAt: 100, summary: '完成' });
  });

  it('列表里没有的任务（前台任务）忽略，返回原数组', () => {
    const tasks = [running('a')];
    expect(applyNotification(tasks, 'other', 'completed', '', 1)).toBe(tasks);
  });
});

describe('applyPatch', () => {
  it('killed 记为已停止，带上错误信息和结束时间', () => {
    const tasks = applyPatch([running('a')], 'a', { status: 'killed', end_time: 777, error: '用户停止' }, 900);
    expect(tasks[0]).toMatchObject({ status: 'stopped', endedAt: 777, summary: '用户停止' });
  });

  it('只更新描述', () => {
    expect(applyPatch([running('a')], 'a', { description: '新描述' }, 0)[0]).toMatchObject({ description: '新描述', status: 'running' });
  });

  it('与结束无关的变化（如 running、paused）不改列表', () => {
    const tasks = [running('a')];
    expect(applyPatch(tasks, 'a', { status: 'paused' }, 0)).toBe(tasks);
  });
});

describe('endAll / canReadOutput', () => {
  it('进程退出：运行中的都记为已结束', () => {
    const tasks = endAll([running('a'), running('b', { status: 'failed', endedAt: 1 })], 50);
    expect(tasks.map((t) => [t.status, t.endedAt])).toEqual([['ended', 50], ['failed', 1]]);
  });

  it('只有后台 Bash / Monitor 能读输出', () => {
    expect(canReadOutput(running('a'))).toBe(true);
    expect(canReadOutput(running('a', { type: 'local_agent' }))).toBe(false);
  });
});

describe('stopFollowUp', () => {
  const tab = (sessionStatus: string, phase: string) => ({ sessionStatus, activityStatus: { phase } });
  it('模型空闲：通知随下一条消息送达', () => {
    expect(stopFollowUp(undefined)).toBe('idle');
    expect(stopFollowUp(tab('completed', 'completed'))).toBe('idle');
    expect(stopFollowUp(tab('idle', 'idle'))).toBe('idle');
  });
  it('模型在思考或输出：当前这一步结束后送达', () => {
    expect(stopFollowUp(tab('running', 'thinking'))).toBe('running');
    expect(stopFollowUp(tab('running', 'writing'))).toBe('running');
    expect(stopFollowUp(tab('running', 'awaiting'))).toBe('running');
  });
  it('模型正在执行前台工具：可能卡在等待循环里，需要提供中断', () => {
    expect(stopFollowUp(tab('running', 'tool'))).toBe('blocked');
  });
});
