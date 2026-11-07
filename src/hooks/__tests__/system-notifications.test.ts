// 系统通知的发送时机：窗口在后台才发、设置可关闭、结束后回到运行中不发、等待确认立即发。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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

const { useChatStore } = await import('../../stores/chatStore');
const { useSessionStore } = await import('../../stores/sessionStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { bridge } = await import('../../lib/tauri-bridge');
const { startSystemNotifications } = await import('../useSystemNotifications');
import type { SessionListItem } from '../../lib/tauri-bridge';

const TAB = 'notify_tab';
const store = () => useChatStore.getState();

describe('startSystemNotifications', () => {
  let focused = false;
  let stop: () => void;
  let send: Mock<typeof bridge.sendNotification>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = false;
    vi.stubGlobal('document', { hasFocus: () => focused });
    send = vi.fn<typeof bridge.sendNotification>().mockResolvedValue(undefined);
    vi.spyOn(bridge, 'sendNotification').mockImplementation(send);
    useSettingsStore.setState({ systemNotifications: true, locale: 'zh' });
    useSessionStore.setState({
      sessions: [{ id: TAB, path: 'p', project: 'F:/p', projectDir: 'p', modifiedAt: 0, preview: '修复登录 bug' } as SessionListItem],
      customPreviews: {},
    });
    store().ensureTab(TAB);
    store().resetTab(TAB);
    store().setSessionStatus(TAB, 'running');
    stop = startSystemNotifications();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  const finishWithReply = (text: string) => {
    store().addMessage(TAB, { id: 'r', role: 'assistant', type: 'text', content: text, timestamp: 1 });
    store().setSessionStatus(TAB, 'completed');
  };

  it('窗口在后台时回复完成：等 1 秒确认后发通知，标题是会话名，正文是回复开头', () => {
    finishWithReply('已经**修好**了');
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledWith('修复登录 bug', '已经修好了');
  });

  it('会话改过名时用改后的名字', () => {
    useSessionStore.setState({ customPreviews: { [TAB]: '我起的名字' } });
    finishWithReply('好了');
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledWith('我起的名字', '好了');
  });

  it('结束后马上又开始运行（自动压缩、排队消息）：不发', () => {
    finishWithReply('第一轮');
    store().setSessionStatus(TAB, 'running');
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('窗口在前台时不发', () => {
    focused = true;
    finishWithReply('好了');
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('设置里关掉后不发', () => {
    useSettingsStore.setState({ systemNotifications: false });
    finishWithReply('好了');
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  it('进入等待确认：立即发，写明工具名', () => {
    store().addMessage(TAB, {
      id: 'p', role: 'assistant', type: 'permission', content: '', permissionTool: 'Bash', resolved: false, timestamp: 1,
    });
    store().awaitUser(TAB);
    expect(send).toHaveBeenCalledWith('修复登录 bug', '等待你确认：允许使用 Bash');
  });

  it('停止监听后不再发', () => {
    stop();
    finishWithReply('好了');
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
    stop = () => {};
  });
});
