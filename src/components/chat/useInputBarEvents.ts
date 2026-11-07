// InputBar 的副作用：附件与 store 的双向同步，以及其他组件经 window 事件发来的请求
// （压缩、执行计划、撤回排队消息、从文件树插入文件、打开回退面板）。
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId, type ChatMessage } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCommandStore } from '../../stores/commandStore';
import { bridge } from '../../lib/tauri-bridge';
import { releaseStreamListener } from '../../lib/stream-listeners';
import { useT } from '../../lib/i18n';
import { showToast } from '../shared/Toast';
import type { FileAttachment } from '../../hooks/useFileAttachments';
import type { TiptapEditorHandle } from './TiptapEditor';

type SetFiles = Dispatch<SetStateAction<FileAttachment[]>>;

/**
 * 本地附件 files 与 store.pendingAttachments 双向同步（切换标签页时保留附件）。
 * 用 lastSyncedRef 记住最近一次同步过的数组：同一个值不再反向写回。
 * 否则同一次渲染里两边都变了（如发送后清空附件 + 同时切换/改名标签页）时，
 * 两个 effect 会把两个值来回互换，形成无限更新（Maximum update depth exceeded）。
 */
export function useAttachmentSync(files: FileAttachment[], setFiles: SetFiles): void {
  // 初始值取挂载时的 files：挂载那一刻不把空数组写进 store，而是由下面的 effect 从 store 恢复
  const lastSyncedRef = useRef(files);
  const setPendingAttachmentsStore = useChatStore((s) => s.setPendingAttachments);
  useEffect(() => {
    if (files === lastSyncedRef.current) return;
    lastSyncedRef.current = files;
    const tid = useSessionStore.getState().selectedSessionId;
    if (tid) setPendingAttachmentsStore(tid, files);
  }, [files, setPendingAttachmentsStore]);

  // 标签页切换回来时从 store 恢复附件（pendingAttachments → 本地 files）
  const pendingAttachments = useActiveTab((t) => t.pendingAttachments);
  useEffect(() => {
    if (pendingAttachments === lastSyncedRef.current) return;
    lastSyncedRef.current = pendingAttachments;
    setFiles(pendingAttachments);
  }, [pendingAttachments, setFiles]);
}

/** 撤回的消息放回输入框时，恢复发送时的技能/命令前缀、回退摘要和附件（文本由调用方放回） */
export function useRestoreSendExtras(setFiles: SetFiles) {
  return useCallback((tabId: string, message: ChatMessage) => {
    const ctx = message.sendContext;
    if (ctx?.prefixes.length) {
      ctx.prefixes.forEach((cmd) => useCommandStore.getState().addPrefix(cmd));
    }
    if (ctx?.pendingSummary) {
      useChatStore.getState().setSessionMeta(tabId, { pendingSummary: ctx.pendingSummary });
    }
    const restoredFiles = (message.attachments ?? []).map((a, i) => ({
      id: `withdrawn_${message.id}_${i}`,
      name: a.name,
      path: a.path,
      size: a.size ?? 0,
      type: a.type ?? 'application/octet-stream',
      isImage: a.isImage,
      preview: a.preview,
    }));
    if (restoredFiles.length > 0) setFiles((prev) => [...restoredFiles, ...prev]);
  }, [setFiles]);
}

interface EventDeps {
  textareaRef: RefObject<TiptapEditorHandle | null>;
  setInputSync: (text: string) => void;
  /** 始终指向最新的 handleSubmit */
  handleSubmitRef: MutableRefObject<() => void>;
  restoreSendExtras: (tabId: string, message: ChatMessage) => void;
  canRewind: boolean;
  openRewindPanel: () => void;
}

export function useInputBarEvents({
  textareaRef, setInputSync, handleSubmitRef, restoreSendExtras, canRewind, openRewindPanel,
}: EventDeps): void {
  const t = useT();

  // 计划审阅卡点“执行”或空输入框按 Enter：CLI 已因 ExitPlanMode 退出时，切到代码模式并 --resume 继续
  const handlePlanApprove = useCallback(async () => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const currentMode = useSettingsStore.getState().sessionMode;
    const tabState = getActiveTabState();
    const meta = tabState.sessionMeta;
    const status = tabState.sessionStatus;

    // CLI 还在运行（如跳过模式已自动接受 ExitPlanMode）：只关掉卡片，不需要重启
    if (meta.stdinId && status === 'running') {
      useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
      return;
    }

    // CLI 在 ExitPlanMode 后退出（stream-json 模式下视为拒绝权限）。
    // 计划模式：切到代码模式执行；跳过模式：保持不变
    if (currentMode === 'plan') {
      useSettingsStore.getState().setSessionMode('code');
    }

    // 清理已退出的 CLI 进程
    if (meta.stdinId) {
      useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
      bridge.killSession(meta.stdinId).catch(() => {});
      releaseStreamListener(meta.stdinId);
    }

    // 用 --resume <sessionId> 重新启动
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    setInputSync('Execute the plan above.');
    requestAnimationFrame(() => {
      handleSubmitRef.current();
    });
  }, [setInputSync, handleSubmitRef]);

  // 右上角“压缩”按钮、斜杠菜单选 /compact：会话没有运行中的进程时，通过发送 /compact 续接会话并压缩
  useEffect(() => {
    const handler = (e: Event) => {
      const args = (e as CustomEvent<{ args?: string } | undefined>).detail?.args;
      setInputSync(args ? `/compact ${args}` : '/compact');
      requestAnimationFrame(() => {
        handleSubmitRef.current();
      });
    };
    window.addEventListener('tokenicode:compact-now', handler);
    return () => window.removeEventListener('tokenicode:compact-now', handler);
  }, [setInputSync, handleSubmitRef]);

  // PlanReviewCard 的“执行”和 Enter 快捷键
  useEffect(() => {
    const handler = () => handlePlanApprove();
    window.addEventListener('tokenicode:plan-execute', handler);
    return () => window.removeEventListener('tokenicode:plan-execute', handler);
  }, [handlePlanApprove]);

  // 运行中发出、CLI 还没处理的消息：撤回并放回输入框编辑（ChatPanel 里排队气泡上的按钮触发）
  useEffect(() => {
    const handler = async (e: Event) => {
      const messageId = (e as CustomEvent<string>).detail;
      const tabId = useSessionStore.getState().selectedSessionId;
      if (!tabId || !messageId) return;
      const tabState = getActiveTabState();
      const pending = tabState.pendingUserMessages.find((p) => p.message?.id === messageId);
      if (!pending?.message) return;
      if (pending.sent) {
        // 已写入 stdin：先让 CLI 从队列里取消，CLI 已经取走时不能撤回
        const sid = tabState.sessionMeta.stdinId;
        const cancelled = !!sid && !!pending.uuid
          && await bridge.cancelQueuedMessage(sid, pending.uuid).catch((err) => {
            console.warn('[ClaudeDeck] cancel queued message failed:', err);
            return false;
          });
        if (!cancelled) {
          showToast(t('chat.withdrawFailed'), 'error');
          return;
        }
      }
      if (!useChatStore.getState().removePendingMessage(tabId, messageId)) return;
      // 本轮已结束、只是在等这条消息开始下一轮：撤回后不会再有下一轮，回到空闲
      const after = useChatStore.getState().getTab(tabId);
      if (after?.sessionMeta.awaitingQueuedTurn && !after.pendingUserMessages.some((p) => p.sent)) {
        useChatStore.getState().setSessionMeta(tabId, { awaitingQueuedTurn: undefined });
        useChatStore.getState().setSessionStatus(tabId, 'completed');
        useChatStore.getState().setActivityStatus(tabId, { phase: 'completed' });
      }
      const restoredText = pending.message.sendContext?.rawInput ?? pending.message.content;
      const draft = useChatStore.getState().getTab(tabId)?.inputDraft.trim() ?? '';
      setInputSync(draft ? `${restoredText}\n${draft}` : restoredText);
      restoreSendExtras(tabId, pending.message);
      textareaRef.current?.focus();
    };
    window.addEventListener('tokenicode:withdraw-pending', handler);
    return () => window.removeEventListener('tokenicode:withdraw-pending', handler);
  }, [setInputSync, restoreSendExtras, t, textareaRef]);

  // 从文件树拖入或插入：在光标处插入文件标签，路径显示为相对工作目录
  useEffect(() => {
    const onTreeFileInline = (e: Event) => {
      const fullPath = (e as CustomEvent<string>).detail;
      if (!fullPath || !textareaRef.current) return;
      const cwd = useSettingsStore.getState().workingDirectory;
      let displayPath = fullPath;
      if (cwd && fullPath.startsWith(cwd)) {
        displayPath = fullPath.slice(cwd.length).replace(/^[\\/]/, '');
      }
      textareaRef.current.insertFileChip({ fullPath, label: displayPath });
    };
    window.addEventListener('tokenicode:tree-file-inline', onTreeFileInline);
    return () => window.removeEventListener('tokenicode:tree-file-inline', onTreeFileInline);
  }, [textareaRef]);

  // /rewind 命令：能回退时打开回退面板，否则提示不可用
  useEffect(() => {
    const handler = () => {
      if (canRewind) {
        openRewindPanel();
      } else {
        const tid = useSessionStore.getState().selectedSessionId;
        if (tid) {
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(), role: 'system', type: 'text',
            content: t('rewind.disabled'), commandType: 'error', timestamp: Date.now(),
          });
        }
      }
    };
    window.addEventListener('tokenicode:rewind', handler);
    return () => window.removeEventListener('tokenicode:rewind', handler);
  }, [canRewind, openRewindPanel, t]);
}
