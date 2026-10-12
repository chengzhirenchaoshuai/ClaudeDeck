// process_exit：CLI 进程退出后的清理与错误提示。
import { useChatStore, generateMessageId } from '../../../stores/chatStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { releaseStreamListener } from '../../../lib/stream-listeners';
import { t } from '../../../lib/i18n';
import { formatErrorForUser } from '../errors';
import { commitPartialText, hasAssistantReplyForTurn } from '../buffer';
import { type ProcessExitMessage } from '../../../lib/stream-message';
import { type StreamContext } from '../context';

export function handleProcessExit(ctx: StreamContext, msg: ProcessExitMessage): void {
  const { tabId, msgStdinId, isForeground, agentActions, addMessage, setSessionStatus, setSessionMeta, clearPartial } = ctx;
  const { lastStderrRef } = ctx.config;

  // The CLI process has exited — clear the stdin handle but keep sessionId for resume
  commitPartialText(tabId, msgStdinId);
  clearPartial();
  console.log('[ClaudeDeck:session] process_exit received', { stdinId: msg.__stdinId });

  // Bug C fix (#27): Clear stuck pendingCommandMsgId (e.g., /compact without result)
  const exitPendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
  if (exitPendingCmd) {
    useChatStore.getState().updateMessage(tabId, exitPendingCmd, { commandCompleted: true });
    useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
  }

  // Check this turn only. Old assistant messages must not hide a failed
  // follow-up that exited without returning any text.
  const exitTabData = useChatStore.getState().getTab(tabId);
  const exitStatus = exitTabData?.sessionStatus;
  const exitMsgs = exitTabData?.messages ?? [];
  if (exitStatus === 'running') {
    const turnStartTime = exitTabData?.sessionMeta.turnStartTime ?? 0;
    const hasAssistantReply = hasAssistantReplyForTurn(exitMsgs, turnStartTime);
    if (!hasAssistantReply) {
      // lastStderrRef 只记录前台会话的 stderr；后台会话的 stderr 已逐行显示在聊天中
      if (isForeground && lastStderrRef.current) {
        const stderr = lastStderrRef.current;
        addMessage({
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: formatErrorForUser(`CLI error: ${stderr}`),
          timestamp: Date.now(),
        });
      } else {
        // No stderr captured — CLI exited silently. Show a generic error
        // so the user knows something went wrong (previously this was silent).
        addMessage({
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t('error.cliExitedSilently'),
          timestamp: Date.now(),
        });
      }
    }
  }

  // P0-5: Clean up Tauri event listeners for this session to prevent leaks
  const exitingStdinId = msg.__stdinId || useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
  releaseStreamListener(exitingStdinId);
  if (isForeground && window.__claudeUnlisten) {
    window.__claudeUnlisten = null;
  }

  {
    const exitMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
    for (const m of exitMessages) {
      if (['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved) {
        useChatStore.getState().updateMessage(tabId, m.id, {
          interactionState: 'failed',
          interactionError: 'CLI process exited',
        });
      }
    }
  }

  setSessionStatus('idle');
  if (isForeground && !document.hasFocus() && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification('ClaudeDeck', { body: t('notification.chatComplete') });
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          new Notification('ClaudeDeck', { body: t('notification.chatComplete') });
        }
      }).catch(() => {});
    }
  }

  setSessionMeta({ stdinId: undefined, lastProgressAt: undefined });
  // Clean up stdinId → tabId mapping to prevent memory leak
  if (exitingStdinId) {
    useSessionStore.getState().unregisterStdinTab(exitingStdinId);
  }
  // Bug B fix (#28): Don't discard pending messages — restore to input draft
  const remainingPending = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
  if (remainingPending.length > 0) {
    const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
    const pendingText = remainingPending.join('\n\n');
    useChatStore.getState().setInputDraft(tabId,
      draft ? `${draft}\n\n${pendingText}` : pendingText
    );
    useChatStore.getState().clearPendingMessages(tabId);
  }

  agentActions?.completeAll();
  useSessionStore.getState().fetchSessions();
}
