import { describe, expect, it } from 'vitest';
import { costOf, localDayKey, priceFor, summarize, type UsageRow } from '../usage';

/** 构造“本地时间 y-m-d h 点”对应的 UTC 小时串，使测试与运行环境的时区无关 */
function hourAt(y: number, m: number, d: number, h: number): string {
  return new Date(y, m - 1, d, h).toISOString().slice(0, 13);
}

const row = (hour: string, over: Partial<UsageRow> = {}): UsageRow => ({
  hour, model: 'claude-sonnet-5', project: 'C:\\proj', input: 0, output: 0,
  cacheRead: 0, cache5m: 0, cache1h: 0, messages: 1, ...over,
});

describe('usage', () => {
  it('按本地时区归日', () => {
    expect(localDayKey(hourAt(2026, 9, 21, 0))).toBe('2026-09-21');
    expect(localDayKey(hourAt(2026, 9, 21, 23))).toBe('2026-09-21');
  });

  it('官方模型价格与费用（含缓存写入倍数）', () => {
    const fable = priceFor('claude-fable-5-1', {})!.price;
    // 100 万输入 = $10；缓存读取 100 万 = $0.25；1h 缓存写入 100 万 = 2 倍输入价 = $20
    expect(costOf({ input: 1e6, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 }, fable)).toBeCloseTo(10);
    expect(costOf({ input: 0, output: 0, cacheRead: 1e6, cache5m: 0, cache1h: 0 }, fable)).toBeCloseTo(0.25);
    expect(costOf({ input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 1e6 }, fable)).toBeCloseTo(20);
    // 第三方模型没有内置价格；带 [1m] 后缀的官方模型能匹配
    expect(priceFor('deepseek-v4-pro', {})).toBeNull();
    expect(priceFor('claude-opus-4-6[1m]', {})?.price.input).toBe(5);
  });

  it('按时间段汇总，未定价的 token 不计入费用', () => {
    const now = new Date(2026, 8, 21, 15); // 周一
    const rows = [
      row(hourAt(2026, 9, 21, 10), { input: 1e6 }),                       // 今天
      row(hourAt(2026, 9, 20, 10), { input: 1e6 }),                       // 昨天（周日，上一周）
      row(hourAt(2026, 9, 21, 11), { model: 'deepseek-v4-pro', output: 500 }), // 未定价
    ];
    const today = summarize(rows, 'today', {}, now);
    expect(today.totals.messages).toBe(2);
    expect(today.totals.cost.USD).toBeCloseTo(2); // sonnet-5：$2 / 百万输入
    expect(today.totals.unpricedTokens).toBe(500);
    expect(summarize(rows, 'week', {}, now).totals.messages).toBe(2); // 周一起算，不含周日
    expect(summarize(rows, 'all', {}, now).totals.messages).toBe(3);
  });
});
