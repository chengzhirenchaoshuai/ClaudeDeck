// 输入栏工具行上的“后台任务”按钮与面板：列出当前会话的后台任务（运行中与最近结束的），
// 可查看后台 Bash / Monitor 的输出末尾、停止单个任务。数据来源见 stores/backgroundTaskStore.ts
import { useEffect, useRef, useState } from 'react';
import { useActiveTab, useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useBackgroundTaskStore, useTabBackgroundTasks } from '../../stores/backgroundTaskStore';
import { bridge, type TaskOutput } from '../../lib/tauri-bridge';
import { interruptTurn } from '../../lib/interrupt-turn';
import { canReadOutput, isRunning, stopFollowUp, type BackgroundTask } from '../../lib/background-tasks';
import { stripAnsi } from '../../lib/strip-ansi';
import { useT } from '../../lib/i18n';
import { useFloatingMaxHeight } from '../../hooks/useFloatingMaxHeight';
import { showToast } from '../shared/Toast';
import { formatElapsed } from './chatFormat';

/** 任务运行期间刷新输出的间隔 */
const OUTPUT_POLL_MS = 2000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** 运行中的排前面（先开始的在上），已结束的按结束时间从新到旧 */
function sortTasks(tasks: BackgroundTask[]): BackgroundTask[] {
  return [...tasks].sort((a, b) => {
    if (isRunning(a) !== isRunning(b)) return isRunning(a) ? -1 : 1;
    return isRunning(a) ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
}

const STATUS_STYLE: Record<BackgroundTask['status'], string> = {
  running: 'text-green-500 bg-green-500/10',
  completed: 'text-text-tertiary bg-bg-secondary',
  failed: 'text-red-500 bg-red-500/10',
  stopped: 'text-amber-500 bg-amber-500/10',
  ended: 'text-text-tertiary bg-bg-secondary',
};

/**
 * 读取任务输出：展开时读一次；任务运行中每 2 秒刷新。
 * stdinId 为空（CLI 进程已退出）时无法再读，返回 unavailable。
 */
function useTaskOutput(stdinId: string | undefined, taskId: string, open: boolean, running: boolean) {
  const [output, setOutput] = useState<TaskOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !stdinId) return;
    let cancelled = false;
    const load = () => {
      bridge.getTaskOutput(stdinId, taskId)
        .then((o) => { if (!cancelled) { setOutput(o); setError(null); } })
        .catch((e) => { if (!cancelled) setError(String(e)); });
    };
    load();
    const timer = running ? setInterval(load, OUTPUT_POLL_MS) : undefined;
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, stdinId, taskId, running]);
  return { output, error, unavailable: open && !stdinId };
}

function TaskOutputView({ stdinId, task }: { stdinId: string | undefined; task: BackgroundTask }) {
  const t = useT();
  const { output, error, unavailable } = useTaskOutput(stdinId, task.id, true, isRunning(task));
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const text = output ? stripAnsi(output.output) : '';

  // 新输出到来时滚到最底部（像终端一样看最新的内容）
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (unavailable) return <div className="px-3 pb-2 text-[11px] text-text-tertiary">{t('bgTask.outputUnavailable')}</div>;
  if (error) return <div className="px-3 pb-2 text-[11px] text-red-500 break-all">{error}</div>;
  if (!output) return <div className="px-3 pb-2 text-[11px] text-text-tertiary">…</div>;

  return (
    <div className="px-3 pb-2">
      <pre ref={preRef}
        className="max-h-56 overflow-auto rounded-md bg-bg-secondary px-2.5 py-2 text-[11px] leading-relaxed
          font-mono text-text-secondary whitespace-pre-wrap break-all selectable">
        {text || <span className="text-text-tertiary">{t('bgTask.noOutput')}</span>}
      </pre>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-text-tertiary">
        {output.truncated && <span>{t('bgTask.truncated').replace('{size}', formatBytes(output.total_bytes))}</span>}
        {text && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }).catch(() => {});
            }}
            className="ml-auto hover:text-text-primary transition-smooth">
            {copied ? t('bgTask.copied') : t('bgTask.copyOutput')}
          </button>
        )}
      </div>
    </div>
  );
}

function TaskRow({ task, stdinId, now, onStopped }: {
  task: BackgroundTask;
  stdinId: string | undefined;
  now: number;
  /** 停止成功后调用，由面板决定怎么提示 */
  onStopped: () => void;
}) {
  const t = useT();
  const [showOutput, setShowOutput] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = isRunning(task);
  const elapsed = (task.endedAt ?? now) - task.startedAt;
  const typeLabel = task.type === 'local_bash' ? null : (() => {
    const key = `bgTask.type.${task.type}`;
    const label = t(key);
    return label === key ? task.type : label;
  })();

  const stop = async () => {
    if (!stdinId) return;
    setStopping(true);
    try {
      await bridge.stopBackgroundTask(stdinId, task.id);
      onStopped();
    } catch (e) {
      showToast(t('bgTask.stopFailed').replace('{error}', String(e)), 'error');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="border-b border-border-subtle last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="flex-1 min-w-0">
          <div className={`text-xs text-text-primary truncate ${task.command ? 'font-mono' : ''}`}
            title={task.command || task.description}>
            {task.command || task.description}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-text-tertiary">
            <span className={`px-1.5 py-px rounded ${STATUS_STYLE[task.status]}`}>{t(`bgTask.status.${task.status}`)}</span>
            {typeLabel && <span>{typeLabel}</span>}
            <span>{formatElapsed(Math.max(0, elapsed))}</span>
            {task.command && task.description && task.description !== task.command && (
              <span className="truncate" title={task.description}>{task.description}</span>
            )}
          </div>
          {!running && task.summary && (
            <div className="mt-0.5 text-[10px] text-text-tertiary line-clamp-2" title={task.summary}>{task.summary}</div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {canReadOutput(task) && (
            <button onClick={() => setShowOutput(!showOutput)}
              className="px-1.5 py-0.5 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-secondary transition-smooth">
              {showOutput ? t('bgTask.hideOutput') : t('bgTask.showOutput')}
            </button>
          )}
          {running && stdinId && (
            <button onClick={stop} disabled={stopping}
              className="px-1.5 py-0.5 rounded text-[11px] text-red-500 hover:bg-red-500/10 transition-smooth disabled:opacity-40">
              {t('bgTask.stop')}
            </button>
          )}
        </div>
      </div>
      {showOutput && <TaskOutputView stdinId={stdinId} task={task} />}
    </div>
  );
}

export function BackgroundTasksButton() {
  const t = useT();
  const tabId = useSessionStore((s) => s.selectedSessionId);
  const tasks = useTabBackgroundTasks(tabId);
  const stdinId = useActiveTab((tab) => tab.sessionMeta.stdinId);
  const clearEnded = useBackgroundTaskStore((s) => s.clearEnded);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const maxHeight = useFloatingMaxHeight(open);
  const runningCount = tasks.filter(isRunning).length;
  const sessionStatus = useActiveTab((tab) => tab.sessionStatus);
  const phase = useActiveTab((tab) => tab.activityStatus.phase);
  // 停止任务时模型正卡在前台命令里：提示并提供“中断当前回合”，直到这条命令结束或回合结束
  const [blockedAfterStop, setBlockedAfterStop] = useState(false);
  const showBlocked = blockedAfterStop && sessionStatus === 'running' && phase === 'tool';

  // 回合结束或切换标签页后不再提示
  useEffect(() => {
    if (sessionStatus !== 'running') setBlockedAfterStop(false);
  }, [sessionStatus]);
  useEffect(() => {
    setBlockedAfterStop(false);
  }, [tabId]);

  const handleStopped = () => {
    const followUp = stopFollowUp(tabId ? useChatStore.getState().getTab(tabId) : undefined);
    if (followUp === 'blocked') setBlockedAfterStop(true);
    else showToast(t(followUp === 'idle' ? 'bgTask.stoppedIdle' : 'bgTask.stoppedRunning'), 'info');
  };

  // 中断只结束当前回合，CLI 进程保留；排队的停止通知随下一条消息送达模型
  const handleInterrupt = () => {
    setBlockedAfterStop(false);
    if (!stdinId || !tabId) return;
    void interruptTurn(tabId, stdinId).then((ok) => {
      if (!ok) showToast(t('bgTask.interruptFailed'), 'error');
    });
  };

  // 点面板外关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 面板打开且有运行中的任务时，每秒刷新已运行时长
  useEffect(() => {
    if (!open || runningCount === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, runningCount]);

  if (tasks.length === 0) return null;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs whitespace-nowrap border transition-smooth
          ${runningCount > 0
            ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'}`}
        title={t('bgTask.title')}
      >
        {runningCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
          <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
        </svg>
        <span className="font-medium">
          {runningCount > 0 ? t('bgTask.button').replace('{n}', String(runningCount)) : t('bgTask.buttonIdle')}
        </span>
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 mb-1 w-[480px] max-w-[calc(100vw-2rem)] flex flex-col
            bg-bg-card border border-border-subtle rounded-lg shadow-lg z-50 animate-fade-in"
          style={maxHeight ? { maxHeight } : undefined}>
          <div className="flex items-center px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-medium text-text-primary">{t('bgTask.title')}</span>
            {tasks.some((task) => !isRunning(task)) && tabId && (
              <button onClick={() => clearEnded(tabId)}
                className="ml-auto text-[11px] text-text-tertiary hover:text-text-primary transition-smooth">
                {t('bgTask.clearEnded')}
              </button>
            )}
          </div>
          {showBlocked && (
            <div className="flex items-start gap-2 px-3 py-2 border-b border-border-subtle bg-amber-500/10">
              <span className="flex-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                {t('bgTask.blockedHint')}
              </span>
              <button onClick={handleInterrupt}
                className="flex-shrink-0 px-2 py-0.5 rounded text-[11px] font-medium text-text-inverse bg-amber-500 hover:bg-amber-600 transition-smooth">
                {t('bgTask.interruptTurn')}
              </button>
            </div>
          )}
          <div className="overflow-y-auto">
            {sortTasks(tasks).map((task) => (
              <TaskRow key={task.id} task={task} stdinId={stdinId} now={now} onStopped={handleStopped} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
