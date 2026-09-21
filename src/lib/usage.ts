/** 后端 get_usage_stats 返回的一行：某个 UTC 小时、某个模型、某个项目的用量合计 */
export interface UsageRow {
  /** UTC 小时，如 2026-09-21T14 */
  hour: string;
  model: string;
  project: string;
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
  messages: number;
  /** 远程主机 id；本机数据为空 */
  host?: string;
}

export interface UsageStats {
  rows: UsageRow[];
  sessionCount: number;
}

export type UsagePeriod = 'today' | 'week' | 'month' | 'all';
export type Currency = 'USD' | 'CNY';

/** 每百万 token 的价格 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  currency: Currency;
}

/**
 * 官方模型标价（USD / 百万 token），来源：platform.claude.com/docs/en/about-claude/pricing，
 * 2026-09-21 核对。缓存写入价按输入价的倍数计算：5 分钟 1.25 倍、1 小时 2 倍（同一页面的说明）。
 * 第三方模型（如 DeepSeek）没有可靠的统一标价，不预填，由用户在用量面板里自行填写。
 */
const BUILTIN_PRICES: { pattern: RegExp; price: ModelPrice }[] = [
  { pattern: /^claude-fable-5-1/, price: { input: 10, output: 50, cacheRead: 0.25, currency: 'USD' } },
  { pattern: /^claude-fable-5/, price: { input: 10, output: 50, cacheRead: 1, currency: 'USD' } },
  { pattern: /^claude-opus-(5|4-[5-8])/, price: { input: 5, output: 25, cacheRead: 0.5, currency: 'USD' } },
  { pattern: /^claude-sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2, currency: 'USD' } },
  { pattern: /^claude-sonnet-4-[56]/, price: { input: 3, output: 15, cacheRead: 0.3, currency: 'USD' } },
  { pattern: /^claude-haiku-4-5/, price: { input: 1, output: 5, cacheRead: 0.1, currency: 'USD' } },
];

/** 模型名归一化：小写并去掉 [1m] 后缀，作为自定义价格的键 */
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\[1m\]$/, '');
}

export function priceFor(
  model: string,
  custom: Record<string, ModelPrice>,
): { price: ModelPrice; source: 'custom' | 'builtin' } | null {
  const key = modelKey(model);
  if (custom[key]) return { price: custom[key], source: 'custom' };
  const hit = BUILTIN_PRICES.find((b) => b.pattern.test(key));
  return hit ? { price: hit.price, source: 'builtin' } : null;
}

export function costOf(row: Pick<UsageRow, 'input' | 'output' | 'cacheRead' | 'cache5m' | 'cache1h'>, p: ModelPrice): number {
  return (
    row.input * p.input +
    row.output * p.output +
    row.cacheRead * p.cacheRead +
    row.cache5m * p.input * 1.25 +
    row.cache1h * p.input * 2
  ) / 1_000_000;
}

/** "YYYY-MM-DDTHH"（UTC）转成本地时区的日期键 YYYY-MM-DD */
export function localDayKey(hour: string): string {
  const m = hour.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  if (!m) return 'unknown';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])));
  return dayKey(d);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 时间段的起始日期键（含），本地时区；一周从周一算起；all 返回空串表示不限 */
function periodStartKey(period: UsagePeriod, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'today') return dayKey(today);
  if (period === 'week') {
    const back = (today.getDay() + 6) % 7;
    return dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
  }
  if (period === 'month') return dayKey(new Date(today.getFullYear(), today.getMonth(), 1));
  return '';
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  /** 各币种的估算费用 */
  cost: Partial<Record<Currency, number>>;
  /** 没有价格、未计入费用的 token 数 */
  unpricedTokens: number;
}

export interface UsageBreakdownItem extends UsageTotals {
  key: string;
  /** 该模型是否有价格（仅按模型分组时有意义） */
  priced?: boolean;
}

export interface UsageSummary {
  totals: UsageTotals;
  byModel: UsageBreakdownItem[];
  byProject: UsageBreakdownItem[];
  /** 最近 14 天（含今天）每天的 token 总量，按日期升序 */
  daily: { date: string; tokens: number }[];
}

export const totalTokens = (t: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) =>
  t.input + t.output + t.cacheRead + t.cacheWrite;

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: {}, unpricedTokens: 0 };
}

function addRow(t: UsageTotals, r: UsageRow, price: ModelPrice | null) {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cache5m + r.cache1h;
  t.messages += r.messages;
  if (price) {
    t.cost[price.currency] = (t.cost[price.currency] ?? 0) + costOf(r, price);
  } else {
    t.unpricedTokens += r.input + r.output + r.cacheRead + r.cache5m + r.cache1h;
  }
}

export function summarize(
  rows: UsageRow[],
  period: UsagePeriod,
  custom: Record<string, ModelPrice>,
  now = new Date(),
): UsageSummary {
  const start = periodStartKey(period, now);
  const totals = emptyTotals();
  const models = new Map<string, UsageBreakdownItem>();
  const projects = new Map<string, UsageBreakdownItem>();
  const dailyMap = new Map<string, number>();

  for (const r of rows) {
    const day = localDayKey(r.hour);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + r.input + r.output + r.cacheRead + r.cache5m + r.cache1h);
    if (start && day < start) continue;

    const found = priceFor(r.model, custom);
    const price = found?.price ?? null;
    addRow(totals, r, price);

    let m = models.get(r.model);
    if (!m) models.set(r.model, (m = { key: r.model, priced: !!price, ...emptyTotals() }));
    addRow(m, r, price);

    let p = projects.get(r.project);
    if (!p) projects.set(r.project, (p = { key: r.project, ...emptyTotals() }));
    addRow(p, r, price);
  }

  const daily: { date: string; tokens: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    daily.push({ date: key, tokens: dailyMap.get(key) ?? 0 });
  }

  const byTokens = (a: UsageBreakdownItem, b: UsageBreakdownItem) => totalTokens(b) - totalTokens(a);
  return {
    totals,
    byModel: [...models.values()].sort(byTokens),
    byProject: [...projects.values()].sort(byTokens),
    daily,
  };
}

export function formatTokens(value: number): string {
  if (!value) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString();
}

export function formatMoney(value: number, currency: Currency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  return `${symbol}${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
}
