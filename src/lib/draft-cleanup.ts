/**
 * 空草稿会话自动清理：点“新建会话”或项目上的“+”会立即在列表里插入一条草稿，
 * 没发消息就切走的话，这条草稿和为它预热的 CLI 进程都没用了，切走时一并清掉。
 * 输入框里写了内容的草稿保留，避免丢掉没发出去的文字。
 */
import { useSessionStore } from '../stores/sessionStore';
import { useChatStore } from '../stores/chatStore';
import { bridge } from './tauri-bridge';
import { releaseStreamListener } from './stream-listeners';

function cleanupIfEmpty(draftId: string) {
  const sessionState = useSessionStore.getState();
  const draft = sessionState.sessions.find((s) => s.id === draftId);
  // 已发出首条消息的草稿会被改名为真实会话 ID，这里就找不到了
  if (!draft || draft.path !== '') return;

  const tab = useChatStore.getState().getTab(draftId);
  if (tab && (tab.messages.length > 0 || tab.pendingUserMessages.length > 0 || tab.inputDraft.trim())) return;

  // 先注销监听和路由再结束进程，避免退出事件又把已删除的标签页建回来
  const stdinId = tab?.sessionMeta.stdinId;
  if (stdinId) {
    releaseStreamListener(stdinId);
    sessionState.unregisterStdinTab(stdinId);
    bridge.killSession(stdinId).catch(() => {});
  }
  sessionState.removeDraft(draftId);
  useChatStore.getState().removeTab(draftId);
}

/** 监听当前会话切换，返回取消监听的函数 */
export function installDraftCleanup(): () => void {
  return useSessionStore.subscribe((state, prev) => {
    const left = prev.selectedSessionId;
    if (left && left !== state.selectedSessionId && left.startsWith('draft_')) {
      cleanupIfEmpty(left);
    }
  });
}
