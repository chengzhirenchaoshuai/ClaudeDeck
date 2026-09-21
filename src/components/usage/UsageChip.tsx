import { useEffect, useMemo } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useUsageStore } from '../../stores/usageStore';
import { useT } from '../../lib/i18n';
import { summarize, totalTokens, formatTokens } from '../../lib/usage';
import { finishedSessionIds } from '../../lib/session-finish';

/** 顶部栏的用量小条：今日 token，DeepSeek 供应商时附带账户余额；点击打开用量面板 */
export function UsageChip() {
  const t = useT();
  const toggleUsage = useSettingsStore((s) => s.toggleUsage);
  const custom = useSettingsStore((s) => s.customModelPrices);
  const stats = useUsageStore((s) => s.stats);
  const remote = useUsageStore((s) => s.remote);
  const balance = useUsageStore((s) => s.balance);

  useEffect(() => {
    const { refresh, refreshBalance } = useUsageStore.getState();
    void refresh();
    void refreshBalance();
    // 用量文件在会话运行时持续增长，5 分钟刷新一次；会话结束时也刷新
    const timer = setInterval(() => { void refresh(true); void refreshBalance(); }, 5 * 60 * 1000);
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.runningSessions === prev.runningSessions) return;
      if (finishedSessionIds(prev.runningSessions, state.runningSessions).length > 0) {
        // 稍等片刻，让 CLI 把最后的记录写入文件
        setTimeout(() => { void useUsageStore.getState().refresh(true); void useUsageStore.getState().refreshBalance(); }, 3000);
      }
    });
    return () => { clearInterval(timer); unsubscribe(); };
  }, []);

  // 远程用量读取很慢，这里只并入已经读取过的部分，不主动触发
  const today = useMemo(() => {
    if (!stats) return null;
    const rows = [...stats.rows, ...Object.values(remote).flatMap((r) => r.rows)];
    return totalTokens(summarize(rows, 'today', custom).totals);
  }, [stats, remote, custom]);
  const firstBalance = balance?.balances[0];

  return (
    <button
      onClick={toggleUsage}
      className="hidden lg:inline-flex items-center gap-1.5 ml-2 px-2 py-1 rounded-lg
        bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary
        hover:text-text-primary hover:bg-bg-secondary transition-smooth"
      title={t('usage.title')}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 13V8M8 13V3M13 13V6" />
      </svg>
      <span>{t('usage.period.today')} {today === null ? '…' : formatTokens(today)}</span>
      {firstBalance && (
        <span className="text-text-secondary">
          · {firstBalance.currency === 'CNY' ? '¥' : '$'}{firstBalance.total}
        </span>
      )}
    </button>
  );
}
