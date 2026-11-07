// 输入框的斜杠命令弹窗：检测首行的“/”、上下键选择、Tab/Enter 确认、Esc 关闭。
import { useCallback, useState, type RefObject } from 'react';
import type { UnifiedCommand } from '../../lib/tauri-bridge';
import { useCommandStore } from '../../stores/commandStore';
import { getFilteredCommandList } from './SlashCommandPopover';
import type { TiptapEditorHandle } from './TiptapEditor';

interface Options {
  textareaRef: RefObject<TiptapEditorHandle | null>;
  setInputSync: (text: string) => void;
  /** 立即执行的内置命令（如 /clear、/help） */
  executeImmediateCommand: (cmdName: string, args?: string) => void;
  /** 已选中的技能/命令前缀 */
  activePrefixes: UnifiedCommand[];
}

export function useSlashCommands({ textareaRef, setInputSync, executeImmediateCommand, activePrefixes }: Options) {
  const [slashQuery, setSlashQuery] = useState('');
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useCommandStore((s) => s.commands);

  /** 首行以“/”开头时打开弹窗（输入空格后也保持打开）；已选了非技能前缀时不能再叠加 */
  const detectSlashCommand = useCallback((text: string) => {
    const firstLine = text.split('\n')[0];
    const canAddAnotherSkill = activePrefixes.length === 0
      || activePrefixes.every((item) => item.category === 'skill');
    if (firstLine.startsWith('/') && canAddAnotherSkill) {
      setSlashQuery(firstLine.slice(1));
      setSlashVisible(true);
      setSlashIndex(0);
    } else {
      setSlashVisible(false);
    }
  }, [activePrefixes]);

  const closeSlash = useCallback(() => setSlashVisible(false), []);

  const handleSlashSelect = useCallback((cmd: UnifiedCommand) => {
    setSlashVisible(false);
    setInputSync('');
    if (cmd.immediate && !cmd.has_args) {
      // 立即执行：经 stdin 发送，或作为第一条消息
      executeImmediateCommand(cmd.name);
      return;
    }
    // 需要参数的立即命令、以及普通命令/技能：作为前缀标签，等用户输入后再发送
    useCommandStore.getState().addPrefix(cmd);
    textareaRef.current?.focus();
  }, [executeImmediateCommand, setInputSync, textareaRef]);

  /** 弹窗打开时的按键处理：返回 true 表示已处理；false 表示交给后续逻辑（如 Enter 发送） */
  const handleSlashKey = (e: KeyboardEvent): boolean => {
    if (!slashVisible) return false;
    const filtered = getFilteredCommandList(slashCommands, slashQuery);
    const count = filtered.length;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIndex((prev) => (prev - 1 + count) % count);
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIndex((prev) => (prev + 1) % count);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.isComposing)) {
      if (filtered[slashIndex]) {
        e.preventDefault();
        handleSlashSelect(filtered[slashIndex]);
        return true;
      }
      // 没有匹配的命令：关闭弹窗，Enter 继续走发送
      if (e.key === 'Enter') setSlashVisible(false);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSlashVisible(false);
      return true;
    }
    return false;
  };

  return { slashQuery, slashVisible, slashIndex, detectSlashCommand, handleSlashSelect, handleSlashKey, closeSlash };
}
