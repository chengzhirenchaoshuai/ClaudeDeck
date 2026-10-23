import { beforeEach, describe, expect, it } from 'vitest';
import { CLI_DEFAULT, useSettingsStore } from '../../stores/settingsStore';
import { resolveSessionContextWindow } from '../context-window';

describe('resolveSessionContextWindow', () => {
  beforeEach(() => {
    useSettingsStore.setState({ lastCliModel: '' });
  });

  it('「CLI 默认」且 CLI 尚未上报：用上次上报的模型估算窗口', () => {
    useSettingsStore.setState({ lastCliModel: 'claude-opus-5-5' });
    const ctx = resolveSessionContextWindow({}, CLI_DEFAULT, 'default');
    expect(ctx.model).toBe('claude-opus-5-5');
    expect(ctx.window).toBe(1_000_000);
  });

  it('没有记录时仍按 200K', () => {
    expect(resolveSessionContextWindow({}, CLI_DEFAULT, 'default').window).toBe(200_000);
  });

  it('会话已上报的模型优先于上次记录', () => {
    useSettingsStore.setState({ lastCliModel: 'claude-opus-5-5' });
    const ctx = resolveSessionContextWindow({ model: 'claude-sonnet-4-6' }, CLI_DEFAULT, 'default');
    expect(ctx.model).toBe('claude-sonnet-4-6');
    expect(ctx.window).toBe(200_000);
  });
});
