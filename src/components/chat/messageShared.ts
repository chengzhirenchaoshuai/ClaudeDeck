// 消息气泡各组件共用的 props 类型与内容兜底函数。
import { type ChatMessage } from '../../stores/chatStore';

export interface MessageProps {
  message: ChatMessage;
  isFirstInGroup?: boolean;
}

/** Guard against raw content-block objects ({text, type}) being rendered as
 *  JSX children — causes Minified React error #31. */
export function safeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}
