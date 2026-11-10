// 只中断当前回合、保留 CLI 进程（对应终端里按 Esc）：后台任务继续运行，下一条消息直接写入原进程。
// 终止按钮和后台任务面板的“中断当前回合”共用。
import { useChatStore } from '../stores/chatStore';
import { bridge } from './tauri-bridge';
import { releaseStreamListener } from './stream-listeners';

/** 发出中断后等 CLI 回 result 的时间；超时说明 CLI 没响应，改为结束进程 */
export const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * 发送 interrupt 控制请求并标记“用户主动中断”，CLI 回的 result 由 result 处理按正常结束收尾。
 * 超时仍未收到 result 时结束进程兜底（此时进程多半已无响应）。
 * 返回 false 表示请求没发出去（stdin 已关闭等），标记已撤销，调用方应改为结束进程。
 */
export async function interruptTurn(tabId: string, stdinId: string): Promise<boolean> {
  const store = useChatStore.getState();
  store.setSessionMeta(tabId, { userInterruptStdinId: stdinId });
  try {
    await bridge.interruptSession(stdinId);
  } catch (err) {
    console.warn('[ClaudeDeck] interrupt failed:', err);
    clearUserInterrupt(tabId, stdinId);
    return false;
  }
  setTimeout(() => {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
    if (meta?.userInterruptStdinId !== stdinId) return;
    console.warn('[ClaudeDeck] no result after interrupt, killing process', stdinId);
    clearUserInterrupt(tabId, stdinId);
    if (meta.stdinId === stdinId) useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
    bridge.killSession(stdinId).catch(() => {});
    // 与终止时结束进程一致：留时间让 process_exit 到达完成清理，之后兜底注销监听
    setTimeout(() => releaseStreamListener(stdinId), 3000);
  }, INTERRUPT_TIMEOUT_MS);
  return true;
}

/**
 * result 到达时调用：这一轮是否被用户主动中断（同一进程的中断标记），并清除标记。
 * 中断请求到达前回合恰好已正常结束的，返回 true 也无妨：调用方只对非 success 的 result 改按正常结束处理。
 */
export function takeUserInterrupt(tabId: string, stdinId: string | undefined): boolean {
  const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  if (!meta?.userInterruptStdinId || meta.userInterruptStdinId !== stdinId) return false;
  useChatStore.getState().setSessionMeta(tabId, { userInterruptStdinId: undefined });
  return true;
}

function clearUserInterrupt(tabId: string, stdinId: string): void {
  if (useChatStore.getState().getTab(tabId)?.sessionMeta.userInterruptStdinId === stdinId) {
    useChatStore.getState().setSessionMeta(tabId, { userInterruptStdinId: undefined });
  }
}
