// 输入栏“终止”按钮：结束当前标签页的 CLI 进程。刚发出还没有回应的消息会被撤回并放回输入框。
import { useChatStore, getActiveTabState, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge } from '../../lib/tauri-bridge';
import { releaseStreamListener } from '../../lib/stream-listeners';
import { findWithdrawableTurn, type Turn } from '../../lib/turns';
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
  const withdrawTurn = findWithdrawableTurn(tabState);
  const lastMessage = tabState.messages[tabState.messages.length - 1];
  if (tabId) {
    // 进程还在启动：拿到进程后由启动流程结束它
    const spawn = spawning.get(tabId);
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
