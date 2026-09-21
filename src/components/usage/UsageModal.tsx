import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUsageStore, activeProviderSupportsBalance } from '../../stores/usageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/deepseek-models';
import {
  summarize,
  totalTokens,
  formatTokens,
  formatMoney,
  modelKey,
  priceFor,
  type Currency,
  type UsageBreakdownItem,
  type UsagePeriod,
  type UsageTotals,
} from '../../lib/usage';

const PERIODS: UsagePeriod[] = ['today', 'week', 'month', 'all'];

function costText(cost: UsageTotals['cost']): string {
  const parts = (Object.entries(cost) as [Currency, number][])
    .filter(([, v]) => v > 0)
    .map(([c, v]) => formatMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
}

/** 项目路径只显示最后两段，完整路径放在 title 里 */
function shortProject(path: string): string {
  const parts = path.replace(/^ssh:\/\//, '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary/40 min-w-[110px]">
      <div className="text-[11px] text-text-tertiary">{label}</div>
      <div className="text-[15px] font-semibold text-text-primary mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-text-tertiary mt-0.5">{sub}</div>}
    </div>
  );
}

/** 单个模型的价格编辑行 */
function PriceEditor({ model, onDone }: { model: string; onDone: () => void }) {
  const t = useT();
  const custom = useSettingsStore((s) => s.customModelPrices);
  const setPrice = useSettingsStore((s) => s.setCustomModelPrice);
  const key = modelKey(model);
  const current = priceFor(model, custom)?.price;
  const [input, setInput] = useState(String(current?.input ?? ''));
  const [output, setOutput] = useState(String(current?.output ?? ''));
  const [cacheRead, setCacheRead] = useState(String(current?.cacheRead ?? ''));
  const [currency, setCurrency] = useState<Currency>(current?.currency ?? 'USD');

  const field = 'w-20 px-1.5 py-1 rounded border border-border-subtle bg-bg-secondary text-xs text-text-primary outline-none focus:border-accent';
  const save = () => {
    const nums = [input, output, cacheRead].map((v) => Number(v));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return;
    setPrice(key, { input: nums[0], output: nums[1], cacheRead: nums[2], currency });
    onDone();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 py-2 pl-2 text-[11px] text-text-tertiary">
      <span>{t('usage.priceIn')}</span><input className={field} value={input} onChange={(e) => setInput(e.target.value)} />
      <span>{t('usage.priceOut')}</span><input className={field} value={output} onChange={(e) => setOutput(e.target.value)} />
      <span>{t('usage.priceCacheRead')}</span><input className={field} value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} />
      <select className={field} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
        <option value="USD">USD</option>
        <option value="CNY">CNY</option>
      </select>
      <span>{t('usage.perMTok')}</span>
      <button className="px-2 py-1 rounded border border-border-subtle text-text-muted hover:bg-bg-secondary" onClick={save}>
        {t('usage.save')}
      </button>
      {custom[key] && (
        <button className="px-2 py-1 rounded border border-border-subtle text-text-muted hover:bg-bg-secondary"
          onClick={() => { setPrice(key, null); onDone(); }}>
          {t('usage.resetPrice')}
        </button>
      )}
      <button className="px-2 py-1 rounded text-text-muted hover:bg-bg-secondary" onClick={onDone}>
        {t('common.cancel')}
      </button>
    </div>
  );
}

function BreakdownTable({ items, title, withPricing, limit }: {
  items: UsageBreakdownItem[];
  title: string;
  withPricing?: boolean;
  limit?: number;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div>
      <h4 className="text-[13px] font-medium text-text-primary mb-2">{title}</h4>
      {shown.length === 0 ? (
        <div className="text-xs text-text-tertiary">{t('usage.empty')}</div>
      ) : (
        <div className="text-xs">
          <div className="grid grid-cols-[1fr_90px_60px_90px] gap-2 px-2 pb-1 text-[11px] text-text-tertiary">
            <span /><span className="text-right">Token</span><span className="text-right">{t('usage.messages')}</span>
            <span className="text-right">{t('usage.cost')}</span>
          </div>
          {shown.map((item) => (
            <div key={item.key} className="border-t border-border-subtle/60">
              <div className="grid grid-cols-[1fr_90px_60px_90px] gap-2 px-2 py-1.5 items-center">
                <span className="truncate text-text-primary"
                  title={item.key}>
                  {withPricing ? displayProviderModelName(item.key) : shortProject(item.key)}
                </span>
                <span className="text-right text-text-secondary">{formatTokens(totalTokens(item))}</span>
                <span className="text-right text-text-tertiary">{item.messages}</span>
                <span className="text-right">
                  {withPricing && item.priced === false ? (
                    <button className="text-amber-500 hover:underline" onClick={() => setEditing(editing === item.key ? null : item.key)}>
                      {t('usage.unpriced')} · {t('usage.setPrice')}
                    </button>
                  ) : (
                    <span className="text-text-secondary">{costText(item.cost)}</span>
                  )}
                </span>
              </div>
              {withPricing && item.priced !== false && (
                <div className="px-2 pb-1 -mt-1 text-right">
                  <button className="text-[10px] text-text-tertiary hover:text-accent"
                    onClick={() => setEditing(editing === item.key ? null : item.key)}>
                    {t('usage.setPrice')}
                  </button>
                </div>
              )}
              {withPricing && editing === item.key && (
                <PriceEditor model={item.key} onDone={() => setEditing(null)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UsageModal() {
  const t = useT();
  const toggleUsage = useSettingsStore((s) => s.toggleUsage);
  const custom = useSettingsStore((s) => s.customModelPrices);
  const { stats, remote, loading, error, balance, balanceError, balanceLoading, refresh, refreshBalance, refreshRemote, refreshAllRemote } = useUsageStore();
  const remoteHosts = useSessionStore((s) => s.remoteHosts);
  const [period, setPeriod] = useState<UsagePeriod>('today');
  // 数据来源：全部 / 仅本机 / 某台远程主机
  const [source, setSource] = useState<string>('all');

  useEffect(() => {
    void refresh(true);
    void refreshBalance();
    void refreshAllRemote(); // 30 分钟内读取过则不重复
  }, [refresh, refreshBalance, refreshAllRemote]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') toggleUsage(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleUsage]);

  const rows = useMemo(() => {
    if (!stats) return null;
    const all = [...stats.rows, ...Object.values(remote).flatMap((r) => r.rows)];
    if (source === 'all') return all;
    if (source === 'local') return all.filter((r) => !r.host);
    return all.filter((r) => r.host === source);
  }, [stats, remote, source]);
  const summary = useMemo(() => (rows ? summarize(rows, period, custom) : null), [rows, period, custom]);
  const maxDaily = summary ? Math.max(1, ...summary.daily.map((d) => d.tokens)) : 1;
  const supportsBalance = activeProviderSupportsBalance();

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) toggleUsage(); }}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative w-[min(92vw,860px)] max-h-[88vh] rounded-2xl bg-bg-card border border-border-subtle
        shadow-2xl overflow-hidden animate-fade-in flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">{t('usage.title')}</h2>
          <div className="flex items-center gap-2">
            {remoteHosts.length > 0 && (
              <select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-7 px-2 rounded-lg border border-border-subtle bg-bg-secondary text-xs text-text-primary outline-none focus:border-accent"
              >
                <option value="all">{t('usage.source.all')}</option>
                <option value="local">{t('usage.source.local')}</option>
                {remoteHosts.map((h) => <option key={h.id} value={h.id}>{h.id}</option>)}
              </select>
            )}
            <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
              {PERIODS.map((p) => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`px-3 py-1 text-xs font-medium border-r border-border-subtle last:border-r-0 transition-smooth
                    ${period === p ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-secondary'}`}>
                  {t(`usage.period.${p}`)}
                </button>
              ))}
            </div>
            <button onClick={() => { void refresh(true); void refreshBalance(); }} disabled={loading}
              className="px-2.5 py-1 rounded-lg border border-border-subtle text-xs text-text-muted hover:bg-bg-secondary disabled:opacity-50">
              {loading ? t('usage.loading') : t('usage.refresh')}
            </button>
            <button onClick={toggleUsage} className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-6">
          {remoteHosts.length > 0 && (
            <div className="px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary/40 space-y-1">
              <div className="text-[13px] font-medium text-text-primary">{t('usage.remote')}</div>
              {remoteHosts.map((h) => {
                const r = remote[h.id];
                return (
                  <div key={h.id} className="flex items-center gap-2 text-[11px]">
                    <span className="text-text-secondary w-24 truncate" title={h.id}>{h.id}</span>
                    {r?.loading ? (
                      <span className="text-text-tertiary">{t('usage.remoteLoading')}</span>
                    ) : r?.error ? (
                      <span className="text-red-500 truncate" title={r.error}>{r.error}</span>
                    ) : r ? (
                      <span className="text-text-tertiary">
                        {t('usage.remoteUpdated')} {new Date(r.fetchedAt).toLocaleTimeString()} · {r.sessionCount} {t('usage.sessionsUnit')}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                    <button onClick={() => void refreshRemote(h.id, true)} disabled={r?.loading}
                      className="ml-auto text-text-tertiary hover:text-accent disabled:opacity-50">
                      {t('usage.refresh')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {supportsBalance && (
            <div className="px-3 py-2.5 rounded-lg border border-border-subtle bg-bg-secondary/40">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-text-primary">{t('usage.balance')}</span>
                <button onClick={() => void refreshBalance()} disabled={balanceLoading}
                  className="text-[11px] text-text-tertiary hover:text-accent disabled:opacity-50">
                  {balanceLoading ? t('usage.loading') : t('usage.refresh')}
                </button>
              </div>
              {balanceError && <div className="mt-1 text-xs text-red-500">{balanceError}</div>}
              {balance && balance.balances.length === 0 && (
                <div className="mt-1 text-xs text-text-tertiary">{t('usage.empty')}</div>
              )}
              {balance?.balances.map((b) => (
                <div key={b.currency} className="mt-1 flex items-baseline gap-3">
                  <span className="text-lg font-semibold text-text-primary">
                    {b.currency === 'CNY' ? '¥' : '$'}{b.total}
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    {t('usage.toppedUp')} {b.toppedUp} · {t('usage.granted')} {b.granted}
                  </span>
                  {!balance.isAvailable && <span className="text-[11px] text-amber-500">{t('usage.balanceUnavailable')}</span>}
                </div>
              ))}
              <div className="mt-1 text-[10px] text-text-tertiary">{t('usage.balanceNote')}</div>
            </div>
          )}

          {error && <div className="text-xs text-red-500">{error}</div>}

          {summary && (
            <>
              <div className="flex flex-wrap gap-3">
                <Card label={t('usage.total')} value={formatTokens(totalTokens(summary.totals))} />
                <Card label={t('usage.input')} value={formatTokens(summary.totals.input)} />
                <Card label={t('usage.output')} value={formatTokens(summary.totals.output)} />
                <Card label={t('usage.cacheRead')} value={formatTokens(summary.totals.cacheRead)} />
                <Card label={t('usage.cacheWrite')} value={formatTokens(summary.totals.cacheWrite)} />
                <Card label={t('usage.messages')} value={String(summary.totals.messages)} />
                <Card label={t('usage.cost')} value={costText(summary.totals.cost)}
                  sub={summary.totals.unpricedTokens > 0
                    ? `${formatTokens(summary.totals.unpricedTokens)} ${t('usage.unpricedNote')}`
                    : undefined} />
              </div>

              <div>
                <h4 className="text-[13px] font-medium text-text-primary mb-2">{t('usage.daily')}</h4>
                <div className="flex items-end gap-1.5 h-24">
                  {summary.daily.map((d) => (
                    <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full"
                      title={`${d.date}: ${formatTokens(d.tokens)}`}>
                      <div className="w-full rounded-t bg-accent/70"
                        style={{ height: `${Math.max(d.tokens > 0 ? 3 : 0, (d.tokens / maxDaily) * 100)}%` }} />
                    </div>
                  ))}
                </div>
                <div className="flex gap-1.5 mt-1">
                  {summary.daily.map((d, i) => (
                    <div key={d.date} className="flex-1 text-center text-[9px] text-text-tertiary">
                      {i % 2 === 0 ? d.date.slice(5) : ''}
                    </div>
                  ))}
                </div>
              </div>

              <BreakdownTable items={summary.byModel} title={t('usage.byModel')} withPricing />
              <BreakdownTable items={summary.byProject} title={t('usage.byProject')} limit={10} />

              <p className="text-[11px] text-text-tertiary leading-relaxed">{t('usage.costNote')}</p>
            </>
          )}
          {!summary && !error && <div className="text-xs text-text-tertiary">{t('usage.loading')}</div>}
        </div>
      </div>
    </div>
  );
}
