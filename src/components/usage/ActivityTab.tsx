import { useEffect, useMemo, useState } from 'react';
import { bridge, ProfileStats } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { displayProviderModelName } from '../../lib/deepseek-models';

type ActivityView = 'daily' | 'weekly' | 'total';

function formatTokens(value: number): string {
  if (!value) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString();
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function heatColor(level: number): string {
  switch (level) {
    case 4: return '#e98d82';
    case 3: return '#f2aaa0';
    case 2: return '#f6c8b8';
    case 1: return '#f7ded0';
    default: return 'rgba(188, 144, 123, 0.13)';
  }
}

function monthLabel(date: Date): string {
  return `${date.getMonth() + 1}月`;
}

/** "活动记录" Tab：本机 ClaudeDeck 使用汇总（GitHub 式热力图 + 每日/每周/累计明细）。
 *  原 ProfileStatsModal 的内容，合并进用量面板后去掉了自己的弹窗外壳。 */
export function ActivityTab() {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<ActivityView>('daily');
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);

  const loadStats = async () => {
    setLoading(true);
    setError('');
    try {
      setStats(await bridge.getProfileStats());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStats(); }, []);

  const dailyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of stats?.daily ?? []) {
      if (day.date !== 'unknown') map.set(day.date, day.total_tokens);
    }
    return map;
  }, [stats]);

  const heatmap = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start = addDays(today, -364);
    start = addDays(start, -start.getDay());

    const days: { date: Date; key: string; tokens: number }[] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) {
      const key = dateKey(d);
      days.push({ date: d, key, tokens: dailyMap.get(key) ?? 0 });
    }

    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    return weeks;
  }, [dailyMap]);

  const maxDay = stats?.peakDayTokens ?? 0;

  const recentDaily = useMemo(() => {
    return [...(stats?.daily ?? [])]
      .filter((d) => d.date !== 'unknown')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 14);
  }, [stats]);

  const weekly = useMemo(() => {
    const weeks: { label: string; tokens: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 7; i >= 0; i -= 1) {
      const end = addDays(today, -i * 7);
      const start = addDays(end, -6);
      let tokens = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        tokens += dailyMap.get(dateKey(d)) ?? 0;
      }
      weeks.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, tokens });
    }
    return weeks;
  }, [dailyMap]);

  const maxWeek = Math.max(...weekly.map((w) => w.tokens), 1);
  const displayName = userDisplayName.trim() || 'ClaudeDeck 用户';

  return (
    <div>
      <div className="text-center">
        <div className="mx-auto w-16 h-16 rounded-2xl overflow-hidden shadow-sm border border-border-subtle bg-bg-secondary">
          {userAvatarUrl ? (
            <img src={userAvatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <img src="/app-icon.png" alt="" className="w-full h-full object-cover" />
          )}
        </div>
        <h2 className="mt-3 text-xl font-semibold text-text-primary">{displayName}</h2>
        <p className="mt-1 text-sm text-text-muted">本机 ClaudeDeck 使用汇总</p>
      </div>

      {loading && (
        <div className="mt-8 text-center text-sm text-text-muted">正在读取本机会话统计...</div>
      )}

      {error && (
        <div className="mt-6 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          读取统计失败：{error}
        </div>
      )}

      {stats && !loading && (
        <>
          <div className="mt-7 grid grid-cols-5 rounded-[20px] border border-border-subtle bg-bg-primary/70 overflow-hidden">
            {[
              ['累计 Token 数', formatTokens(stats.totalTokens)],
              ['峰值日 Token 数', formatTokens(stats.peakDayTokens)],
              ['会话总数', stats.sessionCount.toLocaleString()],
              ['活跃天数', `${stats.activeDays} 天`],
              ['消息计数', stats.messageCount.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className="px-3 py-3 text-center border-r border-border-subtle last:border-r-0">
                <div className="text-[16px] font-semibold text-text-primary">{value}</div>
                <div className="mt-1 text-[11px] text-text-muted">{label}</div>
              </div>
            ))}
          </div>

          <section className="mt-7">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-semibold text-text-primary">Token 活动</h3>
              <div className="inline-flex rounded-full border border-border-subtle bg-bg-primary/70 p-1">
                {[
                  ['daily', '每日'],
                  ['weekly', '每周'],
                  ['total', '累计'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setView(id as ActivityView)}
                    className={`px-3 py-1 rounded-full text-xs transition-smooth
                      ${view === id ? 'bg-accent text-text-inverse' : 'text-text-muted hover:text-text-primary'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto pb-2">
              <div className="inline-flex gap-[4px] min-w-full">
                {heatmap.map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-[4px]">
                    {week.map((day) => {
                      const level = levelFor(day.tokens, maxDay);
                      return (
                        <div
                          key={day.key}
                          title={`${day.key}: ${formatTokens(day.tokens)} tokens`}
                          className="w-[11px] h-[11px] rounded-[3px] border border-white/35"
                          style={{ background: heatColor(level) }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-2 flex justify-between text-xs text-text-tertiary">
              {heatmap
                .filter((week) => week[0]?.date.getDate() <= 7)
                .slice(-12)
                .map((week) => (
                  <span key={week[0].key}>{monthLabel(week[0].date)}</span>
                ))}
            </div>
          </section>

          <div className="mt-7 grid grid-cols-[1fr_0.95fr] gap-8">
            <section>
              <h3 className="text-[13px] font-semibold text-text-primary mb-3">活动洞察</h3>
              {view === 'daily' && (
                <div className="space-y-2">
                  {recentDaily.length ? recentDaily.map((day) => (
                    <div key={day.date} className="flex items-center gap-3 text-sm">
                      <span className="w-20 text-text-muted text-xs">{day.date.slice(5)}</span>
                      <div className="h-2 flex-1 rounded-full bg-bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(3, day.total_tokens / Math.max(maxDay, 1) * 100)}%` }}
                        />
                      </div>
                      <span className="w-16 text-right text-text-primary text-xs">{formatTokens(day.total_tokens)}</span>
                    </div>
                  )) : (
                    <p className="text-sm text-text-muted">还没有可统计的 token 活动。</p>
                  )}
                </div>
              )}
              {view === 'weekly' && (
                <div className="space-y-2">
                  {weekly.map((week) => (
                    <div key={week.label} className="flex items-center gap-3 text-sm">
                      <span className="w-20 text-text-muted text-xs">{week.label}</span>
                      <div className="h-2 flex-1 rounded-full bg-bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(3, week.tokens / maxWeek * 100)}%` }}
                        />
                      </div>
                      <span className="w-16 text-right text-text-primary text-xs">{formatTokens(week.tokens)}</span>
                    </div>
                  ))}
                </div>
              )}
              {view === 'total' && (
                <div className="space-y-3 text-sm">
                  {[
                    ['输入 Token', stats.totalInputTokens],
                    ['缓存 Token', stats.totalCacheTokens],
                    ['输出 Token', stats.totalOutputTokens],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between border-b border-border-subtle pb-2">
                      <span className="text-text-muted">{label}</span>
                      <span className="font-medium text-text-primary">{formatTokens(value as number)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-[13px] font-semibold text-text-primary mb-3">常用模型</h3>
              <div className="space-y-3">
                {stats.models.length ? stats.models.map((model) => (
                  <div key={model.model} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-accent/15 text-accent flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                        <path d="M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7L8 1.5z" />
                        <path d="M2.8 4.9L8 8l5.2-3.1M8 8v6" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text-primary truncate">{displayProviderModelName(model.model)}</div>
                      <div className="text-xs text-text-tertiary">{model.message_count} 次响应</div>
                    </div>
                    <div className="text-sm text-text-muted">{formatTokens(model.total_tokens)}</div>
                  </div>
                )) : (
                  <p className="text-sm text-text-muted">还没有模型使用记录。</p>
                )}
              </div>
            </section>
          </div>

          <div className="mt-6 flex justify-center">
            <button
              onClick={loadStats}
              className="px-4 py-2 rounded-full border border-border-subtle text-sm text-text-muted
                hover:text-text-primary hover:bg-bg-secondary transition-smooth"
            >
              刷新统计
            </button>
          </div>
        </>
      )}
    </div>
  );
}
