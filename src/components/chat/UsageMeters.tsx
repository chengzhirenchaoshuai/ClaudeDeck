// 用量相关的小组件：上下文占用进度条（含压缩按钮，显示在输入栏）和 5 小时/每周限额状态条。
import { useEffect, useState } from 'react';
import { useChatStore, generateMessageId, type SessionMeta } from '../../stores/chatStore';
import { useSettingsStore, getAutoCompactThreshold } from '../../stores/settingsStore';
import { getContextUsedTokens } from '../../lib/context-usage';
import { useRateLimitsStore, type RateLimitWindow } from '../../stores/rateLimitsStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/deepseek-models';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatTokens } from './chatFormat';
import { resolveSessionContextWindow } from '../../lib/context-window';

/** 上下文占用进度条 + 压缩按钮，渲染在 InputBar 工具行里、紧挨模型选择框左侧。 */
export function ContextMeter({ sessionMeta, tabId, sessionStatus }: {
  sessionMeta: SessionMeta;
  tabId: string | null;
  sessionStatus?: string;
}) {
  const t = useT();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  // 跟随 CLI 时自动压缩由 CLI 自己决定（阈值可在 CLI 里另行配置），应用算出的阈值不代表真实时机
  const followCli = useSettingsStore((s) => s.followCli);
  const [isCompacting, setIsCompacting] = useState(false);
  const ctx = resolveSessionContextWindow(sessionMeta, selectedModel, contextWindowMode);
  const contextWindow = ctx.window;
  const compactThreshold = getAutoCompactThreshold(ctx.model, ctx.mode, autoCompactThresholdTokens);
  const used = Math.min(contextWindow, getContextUsedTokens(sessionMeta));
  const available = Math.max(0, contextWindow - used);
  const percent = Math.min(100, Math.round((used / contextWindow) * 100));
  const thresholdPercent = Math.min(100, Math.round((compactThreshold / contextWindow) * 100));
  const isBusy = sessionStatus === 'running';
  const hasLiveProcess = Boolean(sessionMeta.stdinId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 没有运行中的进程时（历史会话），只要是有内容的真实会话，也可以压缩：
  // 点击后由输入框把 /compact 作为第一条消息发给 CLI，续接会话并压缩
  const canResumeAndCompact = Boolean(
    tabId && !hasLiveProcess && used > 0
    && sessionMeta.sessionId && !sessionMeta.sessionId.startsWith('desk_'),
  );
  const canCompact = Boolean(tabId && !isBusy && !isCompacting && (hasLiveProcess || canResumeAndCompact));
  const compactHint = canCompact
    ? t('chat.compactNow')
    : isBusy || isCompacting ? t('chat.compactBusy') : t('chat.compactEmpty');

  const handleCompactClick = () => {
    if (!canCompact) return;
    setConfirmOpen(true);
  };

  const handleCompact = async () => {
    setConfirmOpen(false);
    if (!canCompact || !tabId) return;
    if (!hasLiveProcess) {
      window.dispatchEvent(new CustomEvent('tokenicode:compact-now'));
      return;
    }
    if (!sessionMeta.stdinId) return;
    setIsCompacting(true);
    const processingMsgId = generateMessageId();
    const store = useChatStore.getState();
    // 压缩前的 token 数自己先记下来，compact_boundary 事件到达后再用其中的
    // compact_metadata（pre_tokens/post_tokens）补全；事件缺失时也能显示前后对比。
    store.addMessage(tabId, {
      id: processingMsgId,
      role: 'system',
      type: 'text',
      content: '',
      commandType: 'processing',
      commandData: { command: '/compact', compactSummary: { preTokens: used } },
      commandStartTime: Date.now(),
      commandCompleted: false,
      timestamp: Date.now(),
    });
    store.setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    try {
      await bridge.sendStdin(sessionMeta.stdinId, '/compact');
    } catch (e) {
      store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
      store.setSessionStatus(tabId, 'error');
      console.warn('[ClaudeDeck] manual compact failed:', e);
    } finally {
      setIsCompacting(false);
    }
  };

  return (
    <div className="hidden md:flex flex-shrink-0 items-center gap-2 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary whitespace-nowrap"
      title={t(followCli ? 'chat.contextTooltipCli' : 'chat.contextTooltip')
        .replace('{model}', displayProviderModelName(ctx.model))
        .replace('{used}', used.toLocaleString())
        .replace('{window}', contextWindow.toLocaleString())
        .replace('{free}', available.toLocaleString())
        .replace('{threshold}', compactThreshold.toLocaleString())}>
      <span className="font-medium text-text-muted">{t('chat.contextLabel')}</span>
      <div className="w-20 h-1.5 rounded-full bg-bg-tertiary overflow-hidden flex-shrink-0">
        <div
          className={`h-full rounded-full ${percent >= thresholdPercent ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={percent >= thresholdPercent ? 'text-warning' : 'text-text-tertiary'}>
        {percent}%
      </span>
      <span>{t('chat.contextFree').replace('{n}', formatTokens(available))}</span>
      <button
        onClick={handleCompactClick}
        disabled={!canCompact}
        className="flex-shrink-0 px-2 py-0.5 rounded border border-border-subtle bg-bg-card
          text-text-primary font-medium cursor-pointer transition-smooth
          hover:bg-accent/10 hover:text-accent hover:border-accent/30
          disabled:opacity-40 disabled:cursor-not-allowed
          disabled:hover:bg-bg-card disabled:hover:text-text-primary disabled:hover:border-border-subtle"
        title={compactHint}
      >
        {t('chat.compact')}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title={t('chat.compactConfirmTitle')}
        message={t('chat.compactConfirmMessage')}
        confirmLabel={t('chat.compact')}
        onConfirm={handleCompact}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** 把 unix 秒转成"还剩 Xh Ym" / "还剩 Xd Yh"这样的倒计时文案；已过期返回 null。
 *  compact 为 true 时去掉"还剩"前缀和空格（如"2小时14分"），用于紧跟在百分比后面的短显示。 */
function formatResetCountdown(resetsAtSec: number, t: (k: string) => string, compact = false): string | null {
  const ms = resetsAtSec * 1000 - Date.now();
  if (ms <= 0) return null;
  const totalMin = Math.ceil(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const sep = compact ? '' : ' ';
  const body = days > 0
    ? `${days}${t('chat.days')}${sep}${hours}${t('chat.hours')}`
    : hours > 0
      ? `${hours}${t('chat.hours')}${sep}${mins}${t('chat.minutes')}`
      : `${mins}${t('chat.minutes')}`;
  return compact ? body : `${t('chat.resetsIn')} ${body}`;
}

/** 一个用量窗口（5 小时 / 7 天）的小段：有百分比就画进度条，没有(数据缺失、只知道
 *  重置时间)就只显示状态点 + 倒计时——绝不能在缺失时拿本地数据凑一个假数字出来显示。 */
function RateLimitWindowView({ label, entry, t }: {
  label: string;
  entry?: RateLimitWindow;
  t: (k: string) => string;
}) {
  if (!entry) return null;
  const hasPercent = typeof entry.usedPercentage === 'number' && Number.isFinite(entry.usedPercentage);
  const percent = hasPercent ? Math.min(100, Math.round(entry.usedPercentage!)) : null;
  const isWarning = percent !== null && percent >= 80;
  const isRejected = percent !== null && percent >= 100;
  const colorClass = isRejected ? 'text-error' : isWarning ? 'text-warning' : 'text-text-tertiary';
  const countdown = entry.resetsAt ? formatResetCountdown(entry.resetsAt, t) : null;
  const shortCountdown = entry.resetsAt ? formatResetCountdown(entry.resetsAt, t, true) : null;
  if (!hasPercent && !countdown) return null;

  return (
    <div className="flex items-center gap-1" title={countdown ?? undefined}>
      <span className="font-medium text-text-muted">{label}</span>
      {hasPercent ? (
        <>
          <div className="w-10 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className={`h-full rounded-full ${isRejected ? 'bg-error' : isWarning ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={colorClass}>{percent}%</span>
          {shortCountdown && <span className="text-text-muted">· {shortCountdown}</span>}
        </>
      ) : (
        <>
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-success" />
          {countdown && <span className="text-text-tertiary">{countdown}</span>}
        </>
      )}
    </div>
  );
}

/** 5 小时 / 7 天用量状态条。数据来自全局缓存（useRateLimitsStore）：流里的
 *  rate_limit_event 到达时更新，落一份到 localStorage，不挂在某个会话 tab 下。
 *  已过重置时间的窗口说明数据作废，不显示（不能拿旧数字当现在的用量）。 */
export function UsageStatusBar() {
  const t = useT();
  const fiveHour = useRateLimitsStore((s) => s.fiveHour);
  const sevenDay = useRateLimitsStore((s) => s.sevenDay);
  // 每 30 秒重渲染一次：倒计时要走动，过了重置时间的窗口也要及时隐藏，
  // 不能只等下一条 rate_limit_event 到达才更新
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const live = (w?: RateLimitWindow) => (w && (!w.resetsAt || w.resetsAt * 1000 > Date.now()) ? w : undefined);
  const five = live(fiveHour);
  const seven = live(sevenDay);

  if (!five && !seven) return null;

  return (
    <div className="hidden md:flex items-center gap-3 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px]">
      <RateLimitWindowView label="5h" entry={five} t={t} />
      <RateLimitWindowView label={t('chat.weekly')} entry={seven} t={t} />
    </div>
  );
}
