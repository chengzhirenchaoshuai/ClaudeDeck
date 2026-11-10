// 输入栏“终止”按钮：
// - 刚发出还没有回应的消息：撤回并放回输入框（结束 CLI 进程，模型不会记得它）；
// - 回合进行中：只中断当前回合，保留 CLI 进程，后台任务继续运行（对应终端里按 Esc）；
// - 其他情况（进程启动中、中断请求发不出去、排队消息撤不回）：结束 CLI 进程。
import { useChatStore, getActiveTabState, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge } from '../../lib/tauri-bridge';
import { releaseStreamListener } from '../../lib/stream-listeners';
import { findWithdrawableTurn, type Turn } from '../../lib/turns';
import { interruptTurn } from '../../lib/interrupt-turn';
import { t } from '../../lib/i18n';
import type { RewindAction } from '../../hooks/useRewind';

/** 正在启动 CLI 的标签页：启动返回前 stdinId 还没写入 sessionMeta，终止时靠这里标记取消 */
export type SpawningSessions = Map<string, { stdinId: string; cancelled: boolean }>;

interface StopDeps {
  spawning: SpawningSessions;
  executeRewind: (turn: Turn, action?: RewindAction, overrideText?: string, silent?: boolean) => Promise<boolean>;
  /** 把撤回消息发送时带的技能/命令前缀、回退摘要、附件放回输入框 */
  restoreSendExtras: (tabId: string, message: ChatMessage) => void;
}

export async function stopCurrentSession({ spawning, executeRewind, restoreSendExtras }: StopDeps): Promise<void> {
  const tabId = useSessionStore.getState().selectedSessionId;
  const tabState = getActiveTabState();
  const sid = tabState.sessionMeta.stdinId;
  const wasRunning = tabState.sessionStatus === 'running';
  const withdrawTurn = findWithdrawableTurn(tabState);
  const lastMessage = tabState.messages[tabState.messages.length - 1];
  const spawn = tabId ? spawning.get(tabId) : undefined;
  if (tabId) {
    // 进程还在启动：拿到进程后由启动流程结束它
    if (spawn) {
      spawn.cancelled = true;
      releaseStreamListener(spawn.stdinId);
    }
    useChatStore.getState().setSessionStatus(tabId, 'completed');
    useChatStore.getState().setActivityStatus(tabId, { phase: 'completed' });
  }
  // 刚发出还没有回应：撤回这条消息，连同附件、技能放回输入框，模型也不会记得它
  if (tabId && withdrawTurn) {
    const restoredText = lastMessage.sendContext?.rawInput ?? lastMessage.content;
    const draft = tabState.inputDraft.trim();
    const withdrawn = await executeRewind(
      withdrawTurn,
      'restore_conversation',
      draft ? `${restoredText}\n${draft}` : restoredText,
      true,
    );
    if (withdrawn) {
      restoreSendExtras(tabId, lastMessage);
      return;
    }
  }
  // 回合进行中、进程已就绪：只中断这一轮
  // （撤回失败时进程可能已被结束，stdinId 不再是原来的就不中断）
  if (tabId && sid && wasRunning && !spawn
    && useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId === sid
    && await interruptKeepingProcess(tabId, sid)) return;
  // 立即清掉 stdinId，之后的消息不会再写给这个将要结束的进程
  if (tabId) {
    useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
  }
  if (sid) {
    await bridge.killSession(sid).catch(() => {});
    // 不立即注销监听：让 process_exit 正常到达并完成清理；3 秒后仍未到达时兜底注销
    setTimeout(() => {
      releaseStreamListener(sid);
    }, 3000);
  }
}

/**
 * 中断当前回合并保留进程。中断不会清空 CLI 的消息队列（实测回合一结束就接着处理排队的消息），
 * 所以先把已写入 stdin 的排队消息逐条撤回；有任何一条撤不回（CLI 已取走）就返回 false，改为结束进程。
 * 成功后排队消息放回输入框，未答复的权限/提问卡片标记失效，与结束进程时的收尾一致。
 */
async function interruptKeepingProcess(tabId: string, sid: string): Promise<boolean> {
  const pending = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
  for (const p of pending.filter((m) => m.sent)) {
    const cancelled = !!p.uuid && await bridge.cancelQueuedMessage(sid, p.uuid).catch(() => false);
    if (!cancelled) return false;
  }
  if (!(await interruptTurn(tabId, sid))) return false;

  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  if (!tab) return true;
  if (tab.pendingUserMessages.length > 0) {
    const pendingText = tab.pendingUserMessages
      .map((p) => p.message?.sendContext?.rawInput ?? p.text)
      .join('\n\n');
    const draft = tab.inputDraft.trim();
    store.setInputDraft(tabId, draft ? `${draft}\n\n${pendingText}` : pendingText);
    store.clearPendingMessages(tabId);
  }
  store.setSessionMeta(tabId, { awaitingQueuedTurn: undefined });
  for (const m of tab.messages) {
    if (['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved) {
      store.updateMessage(tabId, m.id, { interactionState: 'failed', interactionError: t('chat.turnInterrupted') });
    }
  }
  return true;
}
