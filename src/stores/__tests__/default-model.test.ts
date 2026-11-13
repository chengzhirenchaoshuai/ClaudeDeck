import { beforeEach, describe, expect, it, vi } from 'vitest';

// 测试环境是 node，chatStore / sessionStore 都会碰 sessionStorage
const memory = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
});

// chatStore 里注册了「切换标签页时恢复模型选择」的订阅，必须 import 才会生效
const { useChatStore } = await import('../chatStore');
const { useSessionStore } = await import('../sessionStore');
const { CLI_DEFAULT, useSettingsStore } = await import('../settingsStore');

const TAB_NEW = 'tab-new';
const TAB_OLD = 'tab-old';

describe('新会话的默认模型 / 默认思考档位', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      followCli: true,
      defaultModel: CLI_DEFAULT,
      defaultThinkingLevel: CLI_DEFAULT,
      selectedModel: CLI_DEFAULT,
      thinkingLevel: CLI_DEFAULT,
    });
    useSessionStore.setState({ selectedSessionId: null });
    useChatStore.setState({ tabs: new Map() });
  });

  it('切到没有快照的新会话时，用设置里的默认值而不是「CLI 默认」', () => {
    useSettingsStore.setState({
      defaultModel: 'claude-haiku-5-5',
      defaultThinkingLevel: 'high',
    });
    useSessionStore.setState({ selectedSessionId: TAB_NEW });

    expect(useSettingsStore.getState().selectedModel).toBe('claude-haiku-5-5');
    expect(useSettingsStore.getState().thinkingLevel).toBe('high');
  });

  it('切回已启动过的会话时，仍用该会话启动时的快照，默认值不覆盖它', () => {
    useSettingsStore.setState({ defaultModel: 'claude-haiku-5-5' });
    useChatStore.getState().ensureTab(TAB_OLD);
    useChatStore.getState().setSessionMeta(TAB_OLD, {
      snapshotModel: 'claude-opus-5-5',
      snapshotThinking: 'low',
    });
    useSessionStore.setState({ selectedSessionId: TAB_OLD });

    expect(useSettingsStore.getState().selectedModel).toBe('claude-opus-5-5');
    expect(useSettingsStore.getState().thinkingLevel).toBe('low');
  });

  it('关闭「跟随 CLI 配置」时，切换会话不改动当前选择', () => {
    useSettingsStore.setState({
      followCli: false,
      defaultModel: 'claude-haiku-5-5',
      selectedModel: 'claude-opus-5-5',
    });
    useSessionStore.setState({ selectedSessionId: TAB_NEW });

    expect(useSettingsStore.getState().selectedModel).toBe('claude-opus-5-5');
  });

  it('改默认模型时：当前选择还停在原默认值就跟着切，用户手动改过则保留', () => {
    useSettingsStore.getState().setDefaultModel('claude-haiku-5-5');
    expect(useSettingsStore.getState().selectedModel).toBe('claude-haiku-5-5');

    useSettingsStore.setState({ selectedModel: 'claude-opus-5-5' });
    useSettingsStore.getState().setDefaultModel('claude-sonnet-5-5');
    expect(useSettingsStore.getState().defaultModel).toBe('claude-sonnet-5-5');
    expect(useSettingsStore.getState().selectedModel).toBe('claude-opus-5-5');
  });
});
