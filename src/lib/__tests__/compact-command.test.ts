import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildCompactCommand, getCompactInstructions } from '../compact-command';
import { t } from '../i18n';

describe('buildCompactCommand', () => {
  afterEach(() => {
    useSettingsStore.setState({ compactInstructions: null });
  });

  it('未自定义时附上内置默认参数', () => {
    useSettingsStore.setState({ compactInstructions: null });
    const fallback = t('settings.compactInstructionsDefault');
    expect(fallback).not.toBe('settings.compactInstructionsDefault');
    expect(buildCompactCommand()).toBe(`/compact ${fallback}`);
  });

  it('自定义参数：附上自定义内容，多行折成一行', () => {
    useSettingsStore.setState({ compactInstructions: '  用中文写摘要\n\n  保留规则  ' });
    expect(getCompactInstructions()).toBe('用中文写摘要 保留规则');
    expect(buildCompactCommand()).toBe('/compact 用中文写摘要 保留规则');
  });

  it('清空参数时只发 /compact', () => {
    useSettingsStore.setState({ compactInstructions: '   ' });
    expect(buildCompactCommand()).toBe('/compact');
    expect(buildCompactCommand('  ')).toBe('/compact');
  });

  it('用户自己写了参数时原样使用，不附默认参数', () => {
    useSettingsStore.setState({ compactInstructions: '用中文写摘要' });
    expect(buildCompactCommand(' 只保留代码改动 ')).toBe('/compact 只保留代码改动');
  });
});
