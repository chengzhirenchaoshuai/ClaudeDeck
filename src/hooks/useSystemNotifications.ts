import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { bridge } from '../lib/tauri-bridge';
import { t } from '../lib/i18n';
import { APP_NAME } from '../lib/edition';
import { buildAwaitingNotice, buildFinishedNotice, detectTransitions, type NoticeContent } from '../lib/system-notify';

/**
 * 一轮结束后等这么久再确认：结束后紧接着自动压缩、发送排队消息时会话会马上回到运行中，
 * 这种中间态不发通知
 */
const FINISH_SETTLE_MS = 1000;

/** 会话在列表里显示的名称；新会话还没有名称时用应用名 */
function sessionTitle(tabId: string): string {
  const { sessions, getDisplayName } = useSessionStore.getState();
  const session = sessions.find((s) => s.id === tabId);
  return (session && getDisplayName(session).trim()) || APP_NAME;
}

function notify(content: NoticeContent): void {
  bridge.sendNotification(content.title, content.body).catch((err) => {
    console.warn('[ClaudeDeck] system notification failed:', err);
  });
}

/** 设置里开着、并且窗口不在前台时才发：在前台时已有未读标记和任务栏角标 */
function shouldNotify(): boolean {
  return useSettingsStore.getState().systemNotifications && !document.hasFocus();
}

/**
 * 系统通知：任一标签页（包括后台的）回复完成、出错，或进入等待确认（权限请求、提问、计划审阅）时，
 * 如果窗口不在前台，弹出 Windows 通知。
 */
export function useSystemNotifications(): void {
  useEffect(() => startSystemNotifications(), []);
}

/** 开始监听标签页状态并按需发通知，返回停止监听的函数（与 React 无关，便于测试） */
export function startSystemNotifications(): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const unsubscribe = useChatStore.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return;
    const { finished, awaiting } = detectTransitions(prev.tabs, state.tabs);

    for (const tabId of finished) {
      clearTimeout(timers.get(tabId));
      timers.set(tabId, setTimeout(() => {
        timers.delete(tabId);
        const tab = useChatStore.getState().getTab(tabId);
        // 等待期间又开始运行（自动压缩、排队消息）：不是真的结束
        if (!tab || tab.sessionStatus === 'running') return;
        if (shouldNotify()) notify(buildFinishedNotice(tab, sessionTitle(tabId), t));
      }, FINISH_SETTLE_MS));
    }

    for (const tabId of awaiting) {
      const tab = state.tabs.get(tabId);
      if (tab && shouldNotify()) notify(buildAwaitingNotice(tab, sessionTitle(tabId), t));
    }
  });

  return () => {
    unsubscribe();
    timers.forEach(clearTimeout);
  };
}
