// 运行中的活动指示器：旋转的星形图标 + 当前真实阶段（思考 / 输出 / 正在运行的工具及其对象 / 等待回复）、耗时与输出 token 数。
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { formatTokens, formatElapsed } from './chatFormat';
import { resolveSessionContextWindow } from '../../lib/context-window';
import { describeTool } from '../../lib/activity-label';

/** 星形图标：三条交叉的线（六芒星号），运行时旋转，等待用户回复时改为琥珀色圆点 */
function ActivityGlyph({ waiting }: { waiting: boolean }) {
  if (waiting) {
    return <span className="w-2 h-2 rounded-full bg-warning animate-pulse-soft" aria-hidden />;
  }
  return (
    <svg className="activity-spinner text-accent" width="14" height="14" viewBox="0 0 14 14"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M7 1.5v11M2.24 4.25l9.52 5.5M2.24 9.75l9.52-5.5" />
    </svg>
  );
}

/** 运行指示器：当前阶段、耗时与输出 token 数，以及卡住、上下文过大的提醒 */
export function ActivityIndicator({ activityStatus, sessionMeta }: {
  activityStatus: { phase: string; toolName?: string; toolInput?: any; runningToolIds?: string[] };
  sessionMeta: {
    turnStartTime?: number;
    outputTokens?: number;
    inputTokens?: number;
    contextInputTokens?: number;
    lastProgressAt?: number;
    spawnedModel?: string;
    snapshotModel?: string;
    snapshotContextWindowMode?: import('../../stores/settingsStore').ContextWindowMode;
  };
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { phase } = activityStatus;
  const waiting = phase === 'awaiting';
  // 工具阶段显示“动作 + 对象”；并行运行多个工具时附上其余数量
  const tool = phase === 'tool' ? describeTool(activityStatus.toolName, activityStatus.toolInput) : null;
  const moreTools = phase === 'tool' ? Math.max(0, (activityStatus.runningToolIds?.length ?? 0) - 1) : 0;
  const label = tool ? t(tool.verbKey)
    : phase === 'thinking' ? t('activity.thinking')
    : phase === 'writing' ? t('activity.writing')
    : waiting ? t('activity.awaiting')
    : t('activity.working');

  const elapsed = sessionMeta.turnStartTime ? formatElapsed(now - sessionMeta.turnStartTime) : null;
  const tokens = sessionMeta.outputTokens ? formatTokens(sessionMeta.outputTokens) : null;

  // Context pressure warning: threshold depends on model context window size
  // 1M models (claude-opus-4-6-1m, mimo-v2-pro[1m]) → warn at 600K; others at 120K (60% of 200K)
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const contextWindow = resolveSessionContextWindow(sessionMeta, selectedModel, contextWindowMode).window;
  const inputTokens = sessionMeta.contextInputTokens ?? sessionMeta.inputTokens ?? 0;
  const contextWarning = inputTokens > contextWindow * 0.6;

  // Stall detection: 120s of silence (no stream activity), not total elapsed time.
  const stallWarning = !!sessionMeta.lastProgressAt
    && !!elapsed
    && (now - sessionMeta.lastProgressAt) > 120_000;

  return (
    <div className="flex items-center gap-2 py-1 text-sm min-w-0">
      <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">
        <ActivityGlyph waiting={waiting} />
      </span>
      {/* 等待回复时文字不闪，用琥珀色提示需要操作；其余阶段有一道亮光扫过 */}
      <span className={`flex-shrink-0 ${waiting ? 'text-warning' : 'activity-shimmer'}`}>{label}</span>
      {tool?.target && (
        <span className={`min-w-0 truncate ${tool.code
          ? 'font-mono text-[12px] px-1.5 py-px rounded bg-bg-secondary text-text-secondary'
          : 'text-text-secondary'}`} title={tool.target}>
          {tool.target}
        </span>
      )}
      {moreTools > 0 && (
        <span className="flex-shrink-0 text-xs text-text-tertiary">{t('activity.more').replace('{n}', String(moreTools))}</span>
      )}
      {elapsed && (
        <span className={`flex-shrink-0 text-xs tabular-nums ${stallWarning ? 'text-red-400' : 'text-text-tertiary'}`}>
          {elapsed}{tokens ? ` · ↓ ${tokens}` : ''}
        </span>
      )}
      {stallWarning && (
        <span className="text-xs text-red-400 ml-2 flex items-center gap-1">
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
          </svg>
          {t('chat.stallWarning')}
        </span>
      )}
      {contextWarning && !stallWarning && (
        <span className="text-xs text-amber-500 ml-2 flex items-center gap-1"
              title={t('chat.tokenWarning')}>
          <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          {t('chat.tokenWarning')}
        </span>
      )}
    </div>
  );
}
