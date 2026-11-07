import { useState, useRef, useCallback, useEffect } from 'react';
import { useChatStore, useActiveTab, getActiveTabState } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { FileUploadChips } from './FileUploadChips';
import { RewindPanel } from './RewindPanel';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { useRewind } from '../../hooks/useRewind';
import { useStreamProcessor } from '../../hooks/useStreamProcessor';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useCommandStore } from '../../stores/commandStore';
import { ContextMeter } from './UsageMeters';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { TiptapEditor, type TiptapEditorHandle } from './TiptapEditor';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { executeImmediateCommand as runImmediateCommand } from './immediate-commands';
import { ThinkLevelSelector, PlanToggleButton } from './InputToolbarButtons';
import { useInputHistory } from './useInputHistory';
import { useSlashCommands } from './useSlashCommands';
import { stopCurrentSession, type SpawningSessions } from './stop-session';
import { handleStderrLine as processStderrLine } from './stderr-handler';
import { useAttachmentSync, useInputBarEvents, useRestoreSendExtras } from './useInputBarEvents';
import { prepareSubmission, showUserTurn, launchTurn } from './submit-message';

/* PlanApprovalBar removed — PlanReviewCard (triggered by ExitPlanMode detection)
   is the proper plan approval UI. The fallback bar was too broad: it appeared on
   every completed session in plan/bypass mode, even without a real plan. */

export function InputBar() {
  const t = useT();
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const inputDraft = useActiveTab((t) => t.inputDraft);
  const setInputDraftStore = useChatStore((s) => s.setInputDraft);
  // Local alias for the store-backed draft
  const input = inputDraft;
  const setInput = useCallback((text: string) => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (tid) {
      useChatStore.getState().ensureTab(tid);
      setInputDraftStore(tid, text);
    }
  }, [setInputDraftStore]);
  const textareaRef = useRef<TiptapEditorHandle>(null);
  /** Sync both the Zustand store and the tiptap editor.
   *  Use this for all programmatic input changes (clear, set, etc.).
   *  The editor's onUpdate callback uses setInput directly to avoid circular updates. */
  const setInputSync = useCallback((text: string) => {
    setInput(text);
    textareaRef.current?.setText(text);
  }, [setInput]);

  // Restore input text from store when session switches (restoreFromCache → inputDraft change).
  // 初始值故意设为 undefined 而不是 inputDraft 本身：TipTap 编辑器每次创建都是空白的
  // （ChatPanel 里 InputBar 会随 workingDirectory 变化整体卸载重建），如果这里用
  // inputDraft 初始化，挂载后第一次 effect 会认为“值没变”而跳过同步，导致编辑器
  // 一直空着、store 里的草稿从未真正显示出来——用户接着一打字就把旧草稿覆盖没了。
  const prevInputDraftRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevInputDraftRef.current !== inputDraft) {
      // Never call setText during IME composition — it destroys the composing state
      if (textareaRef.current?.isComposing()) {
        prevInputDraftRef.current = inputDraft;
        return;
      }
      // Only sync editor if its content actually differs (avoid cursor reset on user typing)
      const current = textareaRef.current?.getText() ?? '';
      if (current !== inputDraft) {
        textareaRef.current?.setText(inputDraft);
      }
    }
    prevInputDraftRef.current = inputDraft;
  }, [inputDraft]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMetaLive = useActiveTab((t) => t.sessionMeta);
  const activityPhase = useActiveTab((t) => t.activityStatus.phase);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const ctrlEnterToSend = useSettingsStore((s) => s.ctrlEnterToSend);

  // Floating approval cards — unresolved plan_review / question messages
  // are rendered above the input instead of inline in the chat flow.
  const floatingCard = useActiveTab((tab) => {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'plan_review' || m.type === 'question' || m.type === 'permission') && !m.resolved) return m;
    }
    return null;
  });

  const { files, setFiles, isProcessing, addFiles, removeFile, clearFiles, cancelProcessing } = useFileAttachments();
  // 正在启动 CLI 的标签页：启动返回前 stdinId 还没写入，终止时靠这里标记取消
  const spawningRef = useRef<SpawningSessions>(new Map());

  // 附件与 store 双向同步、撤回时恢复发送附带的内容（实现见 useInputBarEvents.ts）
  useAttachmentSync(files, setFiles);
  const restoreSendExtras = useRestoreSendExtras(setFiles);

  const activePrefixes = useCommandStore((s) => s.activePrefixes);

  // Focus input when skills/commands are selected externally.
  useEffect(() => {
    if (activePrefixes.length > 0) {
      textareaRef.current?.focus();
    }
  }, [activePrefixes]);

  // Rewind state
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const { showRewind, canRewind, executeRewind } = useRewind();
  // lastEscTime removed — double-Esc rewind disabled (#36/#71)

  // Double-Esc rewind shortcut disabled (#36 / #71) — rewind feature is hidden in ClaudeDeck

  // Drag state (file drop)
  const [isDragging, setIsDragging] = useState(false);

  // Fetch slash commands when working directory changes
  useEffect(() => {
    useCommandStore.getState().fetchCommands(workingDirectory || undefined);
  }, [workingDirectory]);

  const isRunning = sessionStatus === 'running';
  // 提示建议：输入框为空且空闲时，用占位文字显示 CLI 预测的下一句话，按 Tab 填入
  const promptSuggestion = useActiveTab((t) => t.promptSuggestion);
  const showSuggestion = !!promptSuggestion && !input && !isRunning && activePrefixes.length === 0;
  const isAwaiting = isRunning && activityPhase === 'awaiting';

  // Ref to always point to the latest handleSubmit (avoids stale closure)
  const handleSubmitRef = useRef<() => void>(() => {});
  // 其他组件经 window 事件发来的请求：压缩、执行计划、撤回排队消息、插入文件、打开回退面板
  const openRewindPanel = useCallback(() => setShowRewindPanel(true), []);
  useInputBarEvents({ textareaRef, setInputSync, handleSubmitRef, restoreSendExtras, canRewind, openRewindPanel });
  // Ref to always point to the latest handleStderrLine (used by retry logic in handleStreamMessage)
  const handleStderrLineRef = useRef<(line: string, sid: string) => void>(() => {});
  /** Last non-empty stderr line — shown to user if process exits without response */
  const lastStderrRef = useRef('');
  /** Tracks whether auto-compact has been triggered in this session to avoid repeat fires */
  const autoCompactFiredRef = useRef(false);
  /** Tracks ExitPlanMode in current turn for Code mode auto-restart */
  const exitPlanModeSeenRef = useRef(false);
  /** When true, next handleSubmit skips creating user message bubble (Code mode silent restart) */
  const silentRestartRef = useRef(false);

  // Stream processing hook — handles foreground + background stream messages
  const { handleStreamMessage } = useStreamProcessor({
    exitPlanModeSeenRef,
    autoCompactFiredRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  });

  // --- Immediate command execution（实现见 immediate-commands.ts）---
  const executeImmediateCommand = useCallback(
    (cmdName: string, args?: string) => runImmediateCommand(cmdName, args, setInputSync),
    [setInputSync],
  );

  // 斜杠命令弹窗（实现见 useSlashCommands.ts）
  const {
    slashQuery, slashVisible, slashIndex, detectSlashCommand, handleSlashSelect, handleSlashKey, closeSlash,
  } = useSlashCommands({ textareaRef, setInputSync, executeImmediateCommand, activePrefixes });

  // stderr 行处理（实现见 stderr-handler.ts）。要声明在 handleSubmit 之前：它出现在 handleSubmit 的依赖数组里
  const handleStderrLine = useCallback((line: string, sid: string) => {
    processStderrLine(line, sid, lastStderrRef);
  }, []);
  // 保持 ref 同步，handleStreamMessage 里的自动重试经它调用
  handleStderrLineRef.current = handleStderrLine;

  // --- 发送（三个阶段的实现见 submit-message.ts）---
  const handleSubmit = useCallback(async () => {
    // 没有选中的标签页时，在当前工作目录下新建一个草稿会话
    let tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) {
      if (!workingDirectory) return;
      tabId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      useChatStore.getState().ensureTab(tabId);
      useChatStore.getState().resetTab(tabId);
      useSessionStore.getState().addDraftSession(tabId, workingDirectory);
    }
    useChatStore.getState().ensureTab(tabId);

    // 直接从 store 读输入（不用闭包里的值）：handlePlanApprove 这类先 setInput 再 rAF 调用的场景也能读到最新内容
    const rawInput = getActiveTabState().inputDraft || textareaRef.current?.getText() || '';
    const prepared = await prepareSubmission({ tabId, rawInput, files, t, setInputSync, executeImmediateCommand });
    if (!prepared) return;

    setInputSync('');
    if (await showUserTurn({ tabId, prepared, files, clearFiles, silentRestartRef })) return;

    await launchTurn({
      tabId,
      text: prepared.text,
      rawInput,
      workingDirectory,
      selectedModel,
      t,
      spawning: spawningRef.current,
      lastStderrRef,
      autoCompactFiredRef,
      exitPlanModeSeenRef,
      handleStreamMessage,
      handleStderrLine,
    });
  }, [
    workingDirectory, selectedModel, files, clearFiles, t,
    setInputSync, executeImmediateCommand, handleStreamMessage, handleStderrLine,
  ]);

  // 保持 ref 指向最新的 handleSubmit（计划执行、压缩、静默重启等经 rAF 调用）
  handleSubmitRef.current = handleSubmit;

  // handleStreamMessage 由 useStreamProcessor 提供（src/hooks/useStreamProcessor.ts），
  // 前台、后台标签页的流消息都经它处理。

  // Register global stream handler on mount so pre-warm events (system:init,
  // process_exit) are processed immediately — not deferred until user sends.
  // Without this, a pre-warm process_exit would be silently dropped and stdinId
  // would remain set, causing sendStdin to write to a dead process.
  //
  // IMPORTANT: We intentionally do NOT clear __claudeStreamHandler in the cleanup.
  // During React's effect cycle (cleanup → setup), there's a micro-window where
  // the handler is null. If a Tauri event arrives during this window, it would be
  // silently dropped — causing the "no reply" bug where the CLI generates content
  // but the UI never shows it. The handler uses getState() internally so a stale
  // reference is safe.
  useEffect(() => {
    window.__claudeStreamHandler = handleStreamMessage;
    // Drain any events that were queued while handler was unavailable
    const queue = window.__claudeStreamQueue;
    if (queue && queue.length > 0) {
      console.warn(`[ClaudeDeck] draining ${queue.length} queued stream events on handler mount`);
      const pending = queue.splice(0);
      for (const msg of pending) handleStreamMessage(msg);
    }
  }, [handleStreamMessage]);

  // 上下键翻看本会话发过的消息（实现见 useInputHistory.ts）
  const handleHistoryKey = useInputHistory(textareaRef, setInputSync);

  // --- Keyboard handler ---
  /** Keyboard handler for the tiptap editor.
   *  Receives a native KeyboardEvent (not React.KeyboardEvent).
   *  Return true to prevent tiptap default handling. */
  const handleKeyDown = (e: KeyboardEvent): boolean | void => {
    // 斜杠命令弹窗打开时的上下选择、确认、关闭
    if (handleSlashKey(e)) return true;

    // Tab 填入提示建议（光标放到末尾，可以接着修改再发送）
    if (e.key === 'Tab' && !e.shiftKey && showSuggestion && promptSuggestion
        && (textareaRef.current?.isEmpty() ?? true)) {
      e.preventDefault();
      setInputSync(promptSuggestion);
      textareaRef.current?.getEditor()?.commands.focus('end');
      return true;
    }

    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing
        && handleHistoryKey(e.key === 'ArrowUp')) {
      e.preventDefault();
      return true;
    }

    // Backspace at position 0 with empty input removes active prefix
    if (e.key === 'Backspace' && activePrefixes.length > 0 && (textareaRef.current?.isEmpty() ?? true)) {
      e.preventDefault();
      useCommandStore.getState().removePrefix(activePrefixes[activePrefixes.length - 1].name);
      return true;
    }

    if (e.key !== 'Enter') return;

    // Skip if IME composition is in progress (e.g. Chinese/Japanese input method
    // confirming a candidate with Enter — should NOT send the message).
    // Only trust browser-native signals: e.isComposing + keyCode 229.
    // Previously also checked TipTap's composingRef, but compositionend can be
    // missed on macOS WebKit (focus change, click outside), leaving composingRef
    // stuck true and permanently blocking Enter. See issue #66.
    if (e.isComposing || e.keyCode === 229) return;

    const keyTabState = getActiveTabState();
    const pendingInteraction = keyTabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => ['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved,
    );
    if (pendingInteraction) {
      const inputText = (keyTabState.inputDraft || '').trim();
      const isEmptyPlanApproval = pendingInteraction.type === 'plan_review' && !inputText;
      if (!isEmptyPlanApproval && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        return true;
      }
    }

    if (ctrlEnterToSend) {
      // "Ctrl+Enter to send" mode: Ctrl/Cmd+Enter sends, plain Enter inserts newline
      if (e.metaKey || e.ctrlKey) {
        // Ctrl+Enter / Cmd+Enter → send message
        e.preventDefault();
        handleSubmit();
        return true;
      } else {
        // Plain Enter → let tiptap insert newline
        // Shift+Enter → also let tiptap handle (inserts hard break)
        return false;
      }
    } else {
      // Default mode: Enter sends, Ctrl/Cmd+Enter inserts newline
      if (e.metaKey || e.ctrlKey) {
        // Cmd+Enter / Ctrl+Enter → let tiptap insert newline
        return false;
      } else if (!e.shiftKey) {
        // Plain Enter → send message
        e.preventDefault();
        handleSubmit();
        return true;
      }
      // Shift+Enter → let tiptap handle (inserts hard break)
      return false;
    }
  };

  // --- File handling ---
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      // Reset the input so the same file can be selected again
      e.target.value = '';
    }
  }, [addFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = (e as any).clipboardData?.files as FileList | undefined;
    if (items && items.length > 0) {
      e.preventDefault();
      addFiles(items);
      return true;
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // Internal file tree drag uses mouse events (not HTML5 drag), so won't reach here.
    // OS file drops are handled by Tauri onDragDropEvent in useFileAttachments.
  }, []);

  return (
    <div className="p-4 relative">
      <div className="max-w-5xl mx-auto relative">
        {/* Rewind Panel — positioned above the input area */}
        {showRewindPanel && (
          <RewindPanel key={selectedSessionId || 'new'} onClose={() => setShowRewindPanel(false)} />
        )}

        {/* Floating approval card — plan_review, question, or permission awaiting user response.
            悬浮在输入栏上方、盖在消息区之上：不占布局，消息区不会被挤矮；
            卡片之外的区域透明且不拦截点击，只有卡片本身挡住后面的内容。 */}
        {floatingCard && (
          <div key={`${selectedSessionId || 'new'}-${floatingCard.id}`}
            className="absolute left-0 right-0 bottom-full mb-3 z-20 pointer-events-none
              [&>div>div:first-child]:pointer-events-auto
              [&>div>div:first-child]:bg-bg-card [&>div>div:first-child]:shadow-lg
              animate-scale-in">
            {floatingCard.type === 'plan_review'
              ? <PlanReviewCard message={floatingCard} floating />
              : floatingCard.type === 'permission'
                ? <PermissionCard message={floatingCard} />
                : <QuestionCard message={floatingCard} floating />}
          </div>
        )}

        {/* File upload chips */}
        {(files.length > 0 || isProcessing) && (
          <div className="mb-2">
            <FileUploadChips files={files} onRemove={removeFile} isProcessing={isProcessing}
              onCancelProcessing={cancelProcessing} />
          </div>
        )}

        {/* Active prefix description — shown above textarea when a command is selected */}
        {activePrefixes.length > 0 && (
          <div className="mb-1 px-1">
            <span className="text-[10px] text-text-tertiary">
              {activePrefixes.map((item) => item.description).join(' · ')}
            </span>
          </div>
        )}

        {/* Main input area */}
        <div className="relative">
          <SlashCommandPopover
            query={slashQuery}
            visible={slashVisible}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            onClose={closeSlash}
          />
          <div
            className={`flex items-center gap-2 bg-bg-input border rounded-2xl px-4 py-2.5
              focus-within:border-border-focus focus-within:shadow-glow
              transition-smooth group/input
              ${isDragging
                ? 'border-accent bg-accent/5 shadow-glow'
                : 'border-border-subtle'
              }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          {/* Prefix chip + textarea inline */}
          <div className="flex-1 flex items-start gap-0 min-w-0">
            {activePrefixes.length > 0 && (
              <div className="flex-shrink-0 flex flex-wrap items-center gap-1 mt-[2px]">
                {activePrefixes.map((prefix) => (
                <span className="inline-flex items-center gap-1 px-2 py-0.5
                  bg-accent/10 border border-accent/20 rounded-md
                  text-xs text-accent font-medium font-mono whitespace-nowrap" key={prefix.name}>
                  {prefix.name}
                  <button
                    onClick={() => useCommandStore.getState().removePrefix(prefix.name)}
                    className="hover:text-red-400 transition-smooth ml-0.5"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                      stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </span>
                ))}
              </div>
            )}
            <TiptapEditor
              ref={textareaRef}
              data-chat-input
              onUpdate={(text) => {
                setInput(text);
                detectSlashCommand(text);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={showSuggestion
                ? promptSuggestion
                : activePrefixes.length > 0
                ? t('input.prefixPlaceholder')
                : isRunning
                  ? t('input.followUp')
                  : t('input.placeholder')}
              className="flex-1 bg-transparent text-sm text-text-primary
                placeholder:text-text-tertiary resize-none outline-none
                leading-normal overflow-y-auto min-w-0 py-0.5"
            />
          </div>
          {/* Shortcut hint — visible when input area is not focused and input is empty */}
          {!input && activePrefixes.length === 0 && !isRunning && (
            <span className={`flex-shrink-0 text-[10px] select-none whitespace-nowrap self-center mr-1
              ${showSuggestion
                // 有建议时一直显示“Tab 填入建议”：输入框获得焦点时正是要用它的时候
                ? 'text-text-tertiary'
                : 'text-text-tertiary/50 group-focus-within/input:hidden'}`}>
              {showSuggestion
                ? t('input.suggestionHint')
                : t(ctrlEnterToSend ? 'input.shortcutHintCtrlEnter' : 'input.shortcutHint')}
            </span>
          )}
          </div>
        </div>

        {/* Tool row: upload, mode, model。所有按钮都 flex-shrink-0 + whitespace-nowrap，
            不会再把文字挤到换行。刻意不加 overflow-x-auto——这行里好几个按钮
            （模式/思考等级/模型选择）的下拉菜单都是 absolute bottom-full 往上弹出的，
            只要给这一行设置了非 visible 的 overflow-x，浏览器会把 overflow-y 也一起
            隐式转成非 visible（CSS 的一条老规则：两个轴只要有一个不是 visible，
            另一个也会被强制转成 auto），下拉菜单会被直接裁掉——点了跟没点一样，
            正是模型切换点了没反应的原因。现在输入区已经加宽到 max-w-5xl、默认窗口
            也宽到 1600px，正常宽度下这行不会挤不下，真挤不下就让它溢出而不是裁切。 */}
        <div className="flex items-center gap-2 mt-2 px-1">
          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 p-1.5 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary
              transition-smooth"
            title={t('input.attachFiles')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5l6-6a2.5 2.5 0 013.5 3.5l-6 6a1.5 1.5 0 01-2-2l5.5-5.5" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          <ProjectFolderPicker disabled={isRunning} />

          <ModeSelector />

          {/* Think toggle */}
          <ThinkLevelSelector disabled={isRunning} />

          {/* Rewind button */}
          {showRewind && (
            <button
              onClick={() => { if (canRewind) setShowRewindPanel(!showRewindPanel); }}
              disabled={!canRewind}
              className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-xs whitespace-nowrap transition-smooth
                ${canRewind
                  ? 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary cursor-pointer'
                  : 'text-text-muted cursor-not-allowed opacity-50'
                }`}
              title={canRewind ? `${t('rewind.title')} (Esc×2)` : t('rewind.disabled')}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                <path d="M2 7a5 5 0 019.33-2.5M12 7a5 5 0 01-9.33 2.5"
                  strokeLinecap="round" />
                <path d="M11 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 12V9h3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[10px]">{t('rewind.title')}</span>
            </button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Plan view button */}
          <PlanToggleButton />

          {/* 上下文占用进度条 + 压缩按钮，紧挨模型选择框左侧 */}
          <ContextMeter
            sessionMeta={sessionMetaLive}
            tabId={selectedSessionId}
            sessionStatus={sessionStatus}
          />

          {/* Model selector */}
          <ModelSelector disabled={isRunning} />

          {/* Stop button — visible only while running */}
          {isRunning && (
            <button
              onClick={() => stopCurrentSession({ spawning: spawningRef.current, executeRewind, restoreSendExtras })}
              className="flex-shrink-0 w-7 h-7 rounded-[10px]
                bg-red-500/15 text-red-500
                flex items-center justify-center
                hover:bg-red-500/25 transition-smooth"
              title={t('input.stop')}
            >
              <svg width="13" height="13" viewBox="0 0 16 16"
                fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          {/* Send button — kept outside the text input box so clicks near the edge
              of the textarea (e.g. placing the cursor) never accidentally trigger it. */}
          <button
            onClick={handleSubmit}
            disabled={isAwaiting || (!input.trim() && activePrefixes.length === 0)}
            className={`flex-shrink-0 w-7 h-7 rounded-[10px]
              flex items-center justify-center transition-smooth
              disabled:opacity-30 disabled:cursor-not-allowed
              ${isAwaiting
                ? 'bg-warning/15 text-warning cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-text-inverse hover:shadow-glow cursor-pointer'
              }`}
            title={isAwaiting ? t('input.awaitingInteraction') : undefined}
          >
            <svg width="15" height="15" viewBox="0 0 16 16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
