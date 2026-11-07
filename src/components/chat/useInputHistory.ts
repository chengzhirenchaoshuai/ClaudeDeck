// 输入框上下键翻看本会话发过的消息（与 CLI 一致）。
import { useCallback, useRef, type RefObject } from 'react';
import { getActiveTabState, type ChatMessage } from '../../stores/chatStore';
import type { TiptapEditorHandle } from './TiptapEditor';

/** 本会话发过的消息文本（用撤回时可恢复的原始输入），连续重复的只留一条 */
export function collectInputHistory(messages: ChatMessage[]): string[] {
  const entries: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || m.type !== 'text') continue;
    const text = (m.sendContext?.rawInput ?? m.content).trim();
    if (text && entries[entries.length - 1] !== text) entries.push(text);
  }
  return entries;
}

/**
 * 按一次上/下键后的结果。browsingIndex 为正在显示的那条，没在翻看时为 null。
 * - stay：已经是最早的一条，什么都不做（但按键已处理）
 * - clear：翻过最新一条，回到空输入框
 * - show：显示 entries[index]
 */
export type HistoryStep = { kind: 'stay' } | { kind: 'clear' } | { kind: 'show'; index: number };

export function stepHistory(count: number, browsingIndex: number | null, up: boolean): HistoryStep {
  const index = (browsingIndex ?? count) + (up ? -1 : 1);
  if (index < 0) return { kind: 'stay' };
  if (index >= count) return { kind: 'clear' };
  return { kind: 'show', index };
}

/** 返回上下键处理函数：返回 true 表示已处理（不再移动光标） */
export function useInputHistory(
  textareaRef: RefObject<TiptapEditorHandle | null>,
  setInputSync: (text: string) => void,
): (up: boolean) => boolean {
  // index/text 是正在显示的那条，用户改了内容就不再算在翻看
  const historyRef = useRef<{ index: number; text: string } | null>(null);

  return useCallback((up: boolean): boolean => {
    const editor = textareaRef.current?.getEditor();
    const current = textareaRef.current?.getText() ?? '';
    const browsing = !!historyRef.current && current.trim() === historyRef.current.text.trim();
    if (!browsing && current.trim() !== '') return false;
    if (!browsing && !up) return false;
    // 多行内容：光标不在第一行（上键）/最后一行（下键）时照常移动光标
    if (browsing && editor) {
      const { from, to } = editor.state.selection;
      const doc = editor.state.doc;
      const leaf = (node: { type: { name: string } }) => (node.type.name === 'hardBreak' ? '\n' : '');
      const around = up ? doc.textBetween(0, from, '\n', leaf) : doc.textBetween(to, doc.content.size, '\n', leaf);
      if (around.includes('\n')) return false;
    }
    const tab = getActiveTabState();
    // 输入框为空时上键先撤回最后一条排队中的消息放回输入框
    if (up && !browsing) {
      const lastPending = [...tab.pendingUserMessages].reverse().find((p) => p.message);
      if (lastPending?.message) {
        window.dispatchEvent(new CustomEvent('tokenicode:withdraw-pending', { detail: lastPending.message.id }));
        return true;
      }
    }
    const entries = collectInputHistory(tab.messages);
    if (entries.length === 0) return false;
    const step = stepHistory(entries.length, browsing ? historyRef.current!.index : null, up);
    if (step.kind === 'stay') return true;
    if (step.kind === 'clear') {
      historyRef.current = null;
      setInputSync('');
      return true;
    }
    historyRef.current = { index: step.index, text: entries[step.index] };
    setInputSync(entries[step.index]);
    editor?.commands.focus('end');
    return true;
  }, [textareaRef, setInputSync]);
}
