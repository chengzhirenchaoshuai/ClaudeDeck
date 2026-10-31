// 额度用完后到点自动继续。交互式 CLI 自带这个功能，应用用的 SDK 模式只回一句
// “You've hit your ... limit · resets ...” 就停住，由应用补上：本轮结束时记下恢复时间，
// 到点后往同一个 CLI 进程发一条“继续”。等待期间用户自己发了消息就不再自动发送。
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAgentStore } from '../../stores/agentStore';
import { bridge } from '../../lib/tauri-bridge';
import { t } from '../../lib/i18n';
import type { RateLimitInfo } from '../../lib/stream-message';

/** 恢复后多等几秒再发，避免服务端还没放开 */
const RESUME_DELAY_MS = 10_000;
/** 用轮询而不是一个长 setTimeout：电脑睡眠唤醒后也能及时判断是否到点 */
const POLL_MS = 30_000;

/** 本轮收到的“被拒”恢复时间（Unix 秒），按标签页记下，本轮结束时取用 */
const rejectedResetsAt = new Map<string, number>();
const waiting = new Map<string, { timer: ReturnType<typeof setInterval>; noticeId: string }>();

export function noteRateLimitEvent(tabId: string, info: RateLimitInfo): void {
  if (info.status !== 'rejected') return;
  // 顶层没带时从触发的那个窗口里取
  const resetsAt = info.resetsAt ?? (info.rateLimitType ? info.unifiedWindows?.[info.rateLimitType]?.resetsAt : undefined);
  if (typeof resetsAt === 'number') rejectedResetsAt.set(tabId, resetsAt);
}

/** 取出并清掉本轮记下的恢复时间 */
export function takeRejectedResetsAt(tabId: string): number | undefined {
  const at = rejectedResetsAt.get(tabId);
  rejectedResetsAt.delete(tabId);
  return at;
}

function cancel(tabId: string): void {
  const w = waiting.get(tabId);
  if (w) clearInterval(w.timer);
  waiting.delete(tabId);
}

export function scheduleUsageLimitResume(tabId: string, resetsAtSec: number): void {
  cancel(tabId);
  const resumeAt = resetsAtSec * 1000 + RESUME_DELAY_MS;
  const time = new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const noticeId = generateMessageId();
  useChatStore.getState().addMessage(tabId, {
    id: noticeId,
    role: 'system',
    type: 'text',
    content: t('chat.usageLimitWaiting').replace('{time}', time),
    timestamp: Date.now(),
  });
  const timer = setInterval(() => {
    if (Date.now() >= resumeAt) resume(tabId);
  }, POLL_MS);
  waiting.set(tabId, { timer, noticeId });
}

function resume(tabId: string): void {
  const w = waiting.get(tabId);
  cancel(tabId);
  const store = useChatStore.getState();
  const tab = store.getTab(tabId);
  // 标签页已关闭、等待提示之后用户自己发过消息、或已经在运行：不自动发送
  if (!w || !tab || tab.messages[tab.messages.length - 1]?.id !== w.noticeId) return;
  if (tab.sessionStatus === 'running') return;
  const stdinId = tab.sessionMeta.stdinId;
  if (!stdinId) {
    store.addMessage(tabId, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content: t('chat.usageLimitResumeManual'),
      timestamp: Date.now(),
    });
    return;
  }

  const text = t('chat.usageLimitContinueText');
  const now = Date.now();
  store.addMessage(tabId, { id: generateMessageId(), role: 'user', type: 'text', content: text, timestamp: now });
  useSessionStore.getState().touchSession(tabId, now);
  store.setSessionStatus(tabId, 'running');
  store.setSessionMeta(tabId, { turnStartTime: now, lastProgressAt: now, inputTokens: 0, outputTokens: 0 });
  store.setActivityStatus(tabId, { phase: 'thinking' });
  // agentStore 只存当前标签页的代理树
  if (useSessionStore.getState().selectedSessionId === tabId) {
    const agents = useAgentStore.getState();
    agents.clearAgents();
    agents.upsertAgent({ id: 'main', parentId: null, description: text, phase: 'spawning', startTime: now, isMain: true });
  }
  bridge.sendStdin(stdinId, text).catch((err) => {
    console.error('[ClaudeDeck] 自动继续发送失败:', err);
    useChatStore.getState().setSessionStatus(tabId, 'error');
  });
}
