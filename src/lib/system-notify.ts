// 系统通知的判定与文案（纯函数）：哪些标签页刚结束一轮 / 刚进入等待确认，以及通知里写什么。
// 何时真正发送见 src/hooks/useSystemNotifications.ts。
import type { ChatMessage, TabSession } from '../stores/chatStore';

type Translate = (key: string) => string;

export interface NoticeContent {
  title: string;
  body: string;
}

export interface TabTransitions {
  /** 刚从运行中结束：完成、出错，或进程中途退出（变为空闲） */
  finished: string[];
  /** 刚进入等待用户确认（权限请求、提问、计划审阅） */
  awaiting: string[];
}

/**
 * 比较前后两份标签页表。标签页改名（草稿升级为正式会话）时旧 ID 消失、新 ID 出现，
 * 两边都不算状态变化，不会误报。
 */
export function detectTransitions(prev: Map<string, TabSession>, next: Map<string, TabSession>): TabTransitions {
  const finished: string[] = [];
  const awaiting: string[] = [];
  for (const [id, tab] of next) {
    const before = prev.get(id);
    if (!before || before === tab) continue;
    if (before.sessionStatus === 'running' && tab.sessionStatus !== 'running') {
      finished.push(id);
    }
    if (before.activityStatus.phase !== 'awaiting' && tab.activityStatus.phase === 'awaiting') {
      awaiting.push(id);
    }
  }
  return { finished, awaiting };
}

/** 去掉 Markdown 记号、合并空白，截取开头一段作为通知正文 */
export function snippet(text: string, max = 100): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整段去掉
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain;
}

function lastMessage(messages: ChatMessage[], match: (m: ChatMessage) => boolean): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (match(messages[i])) return messages[i];
  }
  return undefined;
}

/**
 * 一轮结束：完成时显示回复开头；出错或进程中途退出（运行中直接变为空闲）时显示最后一条系统消息（错误信息）
 */
export function buildFinishedNotice(tab: TabSession, title: string, t: Translate): NoticeContent {
  if (tab.sessionStatus !== 'completed') {
    const error = lastMessage(tab.messages, (m) => m.role === 'system' && m.type === 'text' && !!m.content.trim());
    const detail = error ? snippet(error.content) : '';
    return { title, body: detail ? t('notification.failedWith').replace('{detail}', detail) : t('notification.failed') };
  }
  const reply = lastMessage(tab.messages, (m) => m.role === 'assistant' && m.type === 'text' && !!m.content.trim());
  const text = reply ? snippet(reply.content) : '';
  return { title, body: text || t('notification.completed') };
}

/** 等待确认：写明在等什么 */
export function buildAwaitingNotice(tab: TabSession, title: string, t: Translate): NoticeContent {
  const pending = lastMessage(
    tab.messages,
    (m) => (m.type === 'permission' || m.type === 'question' || m.type === 'plan_review') && !m.resolved,
  );
  let body = t('notification.awaiting');
  const tool = pending?.permissionTool || pending?.permissionData?.toolName;
  if (pending?.type === 'permission' && tool) {
    body = t('notification.awaitingPermission').replace('{tool}', tool);
  } else if (pending?.type === 'question' && pending.questions?.[0]?.question) {
    body = t('notification.awaitingQuestion').replace('{question}', snippet(pending.questions[0].question, 80));
  } else if (pending?.type === 'plan_review') {
    body = t('notification.awaitingPlan');
  }
  return { title, body };
}
