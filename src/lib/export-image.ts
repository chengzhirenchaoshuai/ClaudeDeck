// 会话导出为图片：按轮次挑出要导出的消息，并把渲染好的节点转成 PNG。
import type { ChatMessage } from '../stores/chatStore';
import type { Turn } from './turns';

/** 导出图片的内容宽度（CSS 像素）：代码块、表格不至于太挤，手机上看也还能读 */
export const EXPORT_WIDTH = 1200;

/** Chromium 画布单边上限是 32767 像素，留一点余量 */
const MAX_CANVAS_SIDE = 32000;

export interface ExportOptions {
  /** 是否包含工具调用行（默认只导出问答） */
  includeTools: boolean;
  /** 只导出结论：每轮只留提问和最终回复，忽略 includeTools */
  conclusionOnly?: boolean;
}

/** 助手正文（回复文字或计划），空内容不算 */
const isReplyText = (m: ChatMessage) =>
  m.role === 'assistant' && (m.type === 'text' || m.type === 'plan') && !!m.content?.trim();

const isUserText = (m: ChatMessage) =>
  m.role === 'user' && m.type === 'text' && !!(m.content?.trim() || m.attachments?.length);

/**
 * 一轮的结论：最后一次工具调用之后的回复文字；之后没有文字（以工具调用收尾）时取最后一段回复文字。
 * 没有工具调用的轮次就是全部回复文字。
 */
function pickConclusion(turnMsgs: ChatMessage[]): ChatMessage[] {
  let lastTool = -1;
  turnMsgs.forEach((m, i) => { if (m.type === 'tool_use' || m.type === 'tool_result') lastTool = i; });
  const tail = turnMsgs.slice(lastTool + 1).filter(isReplyText);
  if (tail.length > 0) return tail;
  const replies = turnMsgs.filter(isReplyText);
  return replies.length > 0 ? [replies[replies.length - 1]] : [];
}

/**
 * 取出第 startTurn 到 endTurn 轮（turns 下标，含两端）中要画进图片的消息。
 * 只保留用户提问、助手回复文本、计划内容；工具调用按选项保留，思考、权限、命令反馈等一律不要。
 * conclusionOnly 时每轮只留提问和结论（见 pickConclusion）。
 */
export function selectExportMessages(
  messages: ChatMessage[],
  turns: Turn[],
  startTurn: number,
  endTurn: number,
  options: ExportOptions,
): ChatMessage[] {
  if (turns.length === 0) return [];
  const s = Math.max(0, Math.min(startTurn, endTurn));
  const e = Math.min(turns.length - 1, Math.max(startTurn, endTurn));
  const turnEnd = (i: number) => (i + 1 < turns.length ? turns[i + 1].startMsgIdx : messages.length);

  if (options.conclusionOnly) {
    const result: ChatMessage[] = [];
    for (let i = s; i <= e; i++) {
      const turnMsgs = messages.slice(turns[i].startMsgIdx, turnEnd(i));
      const question = turnMsgs[0];
      if (isUserText(question)) result.push(question);
      result.push(...pickConclusion(turnMsgs.slice(1)));
    }
    return result;
  }

  return messages.slice(turns[s].startMsgIdx, turnEnd(e)).filter((m) => {
    if (m.role === 'system') return false;
    if (m.role === 'user') return isUserText(m);
    if (m.type === 'tool_use') return options.includeTools;
    return isReplyText(m);
  });
}

/**
 * 计算导出用的像素比：默认 2 倍保证清晰，内容太高时降低以免超过画布上限。
 * 返回 0 表示即使 1 倍也放不下（需要减少轮次）。
 */
export function pickPixelRatio(height: number, preferred = 2): number {
  if (height <= 0) return preferred;
  const maxRatio = MAX_CANVAS_SIDE / height;
  if (maxRatio >= preferred) return preferred;
  if (maxRatio >= 1) return Math.floor(maxRatio * 100) / 100;
  return 0;
}

/** 把节点渲染为 PNG Blob；内容过高放不进画布时抛出 'too-tall' */
export async function renderNodeToPng(node: HTMLElement, background: string): Promise<Blob> {
  // 按需加载，避免把库打进首屏
  const { toBlob } = await import('html-to-image');
  const ratio = pickPixelRatio(node.scrollHeight);
  if (ratio === 0) throw new Error('too-tall');
  const blob = await toBlob(node, {
    pixelRatio: ratio,
    backgroundColor: background,
    width: node.scrollWidth,
    height: node.scrollHeight,
    // 用的都是系统字体，不用把网页字体嵌进去（KaTeX 字体除外，渲染公式时按需嵌入很慢，跳过）
    skipFonts: true,
    cacheBust: false,
    // 取不到的图片（跨域等）用透明像素代替，不让整张导出失败
    imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  });
  if (!blob) throw new Error('empty');
  return blob;
}

/** Blob 转 base64（不带 data: 前缀），用于交给后端写文件 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 复制 PNG 到系统剪贴板 */
export async function copyPngToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** 默认文件名：会话标题（去掉非法字符）+ 时间 */
export function defaultExportFileName(title: string, now = new Date()): string {
  const safe = title.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'ClaudeDeck';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${safe}-${stamp}.png`;
}
