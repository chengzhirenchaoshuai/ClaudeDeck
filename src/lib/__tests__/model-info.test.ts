import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { cliDefaultTooltip, formatTokens, modelFamily, modelInfo } from '../model-info';
import { useSettingsStore } from '../../stores/settingsStore';

describe('模型说明卡片的数据', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh', customModelPrices: {}, lastCliModel: '' });
  });

  it('token 数按 K / M 显示', () => {
    expect(formatTokens(200_000)).toBe('200K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(64_000)).toBe('64K');
  });

  it('Fable 单独算一个系列，不跟着档位映射归到 opus', () => {
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('claude-haiku-5-5')).toBe('haiku');
    expect(modelFamily('glm-5')).toBeNull();
  });

  it('给出上下文、输出上限、知识截止与官方价格', () => {
    const info = modelInfo('claude-opus-5-5', t)!;
    expect(info.label).toBe('Claude Opus 5.5');
    expect(info.context).toBe(1_000_000);
    expect(info.maxOutput).toBe(128_000);
    expect(info.cutoff).toBe('2026-06');
    expect(info.price).toEqual({ input: '4', output: '20', currency: 'USD', custom: false });
  });

  it('各系列的当前代标出来，旧版本不标', () => {
    expect(modelInfo('claude-haiku-5-5', t)!.isLatest).toBe(true);
    expect(modelInfo('claude-haiku-4-5-20251001', t)!.isLatest).toBe(false);
  });

  it('Opus 4.6 本体按 200K 算，1M 变体按 1M 算', () => {
    expect(modelInfo('claude-opus-4-6', t)!.context).toBe(200_000);
    expect(modelInfo('claude-opus-4-6-1m', t)!.context).toBe(1_000_000);
  });

  it('用户填过自定义价格时用自定义价格，并标记出来', () => {
    useSettingsStore.setState({
      customModelPrices: {
        'claude-opus-5-5': { input: 1, output: 3, cacheRead: 0.1, currency: 'CNY' },
      },
    });
    expect(modelInfo('claude-opus-5-5', t)!.price)
      .toEqual({ input: '1', output: '3', currency: 'CNY', custom: true });
  });

  it('列表外的模型没有参数可查，交给调用方决定显示什么', () => {
    expect(modelInfo('glm-5', t)).toBeNull();
  });

  it('「CLI 默认」说明在 CLI 上报过模型后带上它', () => {
    expect(cliDefaultTooltip(t)).not.toContain('claude-opus-5-5');
    useSettingsStore.setState({ lastCliModel: 'claude-opus-5-5' });
    expect(cliDefaultTooltip(t)).toContain('claude-opus-5-5');
  });
});
