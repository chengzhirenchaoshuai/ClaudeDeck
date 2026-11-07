import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
};
vi.stubGlobal('sessionStorage', memoryStorage());
vi.stubGlobal('localStorage', memoryStorage());

const { useChatStore } = await import('../../../stores/chatStore');
const { useSessionStore } = await import('../../../stores/sessionStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { handleStderrLine } = await import('../stderr-handler');

const FG = 'stderr_fg_tab';
const BG = 'stderr_bg_tab';
const messagesOf = (tab: string) => useChatStore.getState().getTab(tab)?.messages ?? [];

describe('handleStderrLine', () => {
  const lastStderr = { current: '' };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    lastStderr.current = '';
    for (const tab of [FG, BG]) {
      useChatStore.getState().ensureTab(tab);
      useChatStore.getState().resetTab(tab);
    }
    useSessionStore.setState({ selectedSessionId: FG, stdinToTab: { bg_stdin: BG, fg_stdin: FG } });
    useSettingsStore.setState({ sessionMode: 'code' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('后台标签页的 stderr 去掉 ANSI 后显示在它自己的对话里，不记为前台的最后错误', () => {
    handleStderrLine('\x1b[31mError: rate limited\x1b[0m', 'bg_stdin', lastStderr);
    expect(messagesOf(BG).map((m) => m.content)).toEqual(['[stderr] Error: rate limited']);
    expect(messagesOf(FG)).toHaveLength(0);
    expect(lastStderr.current).toBe('');
  });

  it('后台的空行不显示', () => {
    handleStderrLine('   ', 'bg_stdin', lastStderr);
    expect(messagesOf(BG)).toHaveLength(0);
  });

  it('前台只记下最后一行非空 stderr，不插入对话', () => {
    handleStderrLine('Invalid API key', 'fg_stdin', lastStderr);
    handleStderrLine('  ', 'fg_stdin', lastStderr);
    expect(lastStderr.current).toBe('Invalid API key');
    expect(messagesOf(FG)).toHaveLength(0);
  });

  describe('计划模式兜底', () => {
    beforeEach(() => {
      useSettingsStore.setState({ sessionMode: 'plan' });
    });

    it('识别“退出计划模式”提示，生成审阅卡，内容取最近一次 Write', () => {
      useChatStore.getState().addMessage(FG, {
        id: 'w', role: 'assistant', type: 'tool_use', content: '', toolName: 'Write',
        toolInput: { content: '# 计划' }, timestamp: 1,
      });
      handleStderrLine('Would you like to exit plan mode?', 'fg_stdin', lastStderr);
      const review = messagesOf(FG).find((m) => m.type === 'plan_review');
      expect(review).toMatchObject({ id: 'plan_review_current', planContent: '# 计划', resolved: false });
      expect(useChatStore.getState().getTab(FG)?.activityStatus.phase).toBe('awaiting');
    });

    it('已有审阅卡（包括已处理过的）时不重复生成', () => {
      useChatStore.getState().addMessage(FG, {
        id: 'plan_review_current', role: 'assistant', type: 'plan_review', content: '', resolved: true, timestamp: 1,
      });
      handleStderrLine('Leave plan mode', 'fg_stdin', lastStderr);
      expect(messagesOf(FG)).toHaveLength(1);
      expect(useChatStore.getState().getTab(FG)?.activityStatus.phase).not.toBe('awaiting');
    });

    it('非计划模式下不处理', () => {
      useSettingsStore.setState({ sessionMode: 'code' });
      handleStderrLine('Exit plan mode', 'fg_stdin', lastStderr);
      expect(messagesOf(FG)).toHaveLength(0);
    });
  });
});
