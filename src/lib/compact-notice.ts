/**
 * 上下文压缩提示：CLI 每次压缩（手动 /compact 或自动触发）后在对话里插入的一条提示。
 *
 * 数据来源：
 * - 实时：system/compact_boundary 事件（compact_metadata，蛇形）
 * - 历史：会话 JSONL 里的 compact_boundary（compactMetadata，驼峰），之后紧跟的
 *   压缩摘要（isCompactSummary 的 user 记录）和 attachment 记录（压缩后重新放进上下文的文件）
 */
import { useChatStore, type ChatMessage } from '../stores/chatStore';

export interface CompactFile {
  /** 完整路径 */
  path: string;
  /** 相对项目的显示路径 */
  display: string;
  /** true：文件内容整份放回了上下文；false：只保留了文件引用 */
  full: boolean;
}

export interface CompactNoticeData {
  trigger?: 'auto' | 'manual';
  preTokens?: number;
  postTokens?: number;
  files?: CompactFile[];
  /** 压缩摘要（CLI 生成，"This session is being continued…" 开头） */
  summary?: string;
}

export function createCompactNotice(id: string, timestamp: number, data: CompactNoticeData): ChatMessage {
  return {
    id,
    role: 'system',
    type: 'text',
    content: '',
    timestamp,
    commandType: 'compact',
    commandData: { ...data },
  };
}

/** attachment 记录 → 压缩后保留的文件；不是文件类附件时返回 null */
export function compactFileFromAttachment(attachment: unknown): CompactFile | null {
  const a = attachment as { type?: string; filename?: string; displayPath?: string } | null;
  if (!a || (a.type !== 'file' && a.type !== 'compact_file_reference')) return null;
  if (typeof a.filename !== 'string' || !a.filename) return null;
  return {
    path: a.filename,
    display: typeof a.displayPath === 'string' && a.displayPath ? a.displayPath : a.filename,
    full: a.type === 'file',
  };
}

/** 往压缩提示里追加一个文件（同一路径只保留一次） */
export function withCompactFile(data: CompactNoticeData, file: CompactFile): CompactNoticeData {
  const files = data.files ?? [];
  if (files.some((f) => f.path === file.path)) return data;
  return { ...data, files: [...files, file] };
}

/**
 * 实时流：把压缩摘要或保留的文件补到该标签页最近一条压缩提示上。
 * 只看最后几条消息，避免补到很久以前的压缩提示上；找不到时返回 false。
 */
export function updateLatestCompactNotice(
  tabId: string,
  update: (data: CompactNoticeData) => CompactNoticeData,
): boolean {
  const chat = useChatStore.getState();
  const messages = chat.getTab(tabId)?.messages ?? [];
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
    const m = messages[i];
    if (m.role === 'system' && m.commandType === 'compact') {
      chat.updateMessage(tabId, m.id, { commandData: { ...update((m.commandData ?? {}) as CompactNoticeData) } });
      return true;
    }
  }
  return false;
}
