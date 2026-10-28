import { useState, useRef, useCallback, useEffect } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId, type ChatMessage } from '../../stores/chatStore';
import { useSettingsStore, mapSessionModeToPermissionMode, setSessionModeLocal, planApprovalCliMode, getContextWindowForModel } from '../../stores/settingsStore';
import { bridge, type UnifiedCommand } from '../../lib/tauri-bridge';
import { hasStreamListener, releaseStreamListener } from '../../lib/stream-listeners';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { FileUploadChips } from './FileUploadChips';
import { RewindPanel } from './RewindPanel';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { useRewind } from '../../hooks/useRewind';
import { useStreamProcessor } from '../../hooks/useStreamProcessor';
import { flushStreamBuffer } from '../../hooks/stream/buffer';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { SlashCommandPopover, getFilteredCommandList } from './SlashCommandPopover';
import { useCommandStore } from '../../stores/commandStore';
import { cliLaunchArgs, envFingerprint, resolveModelForProvider, resolveModelOrError, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { buildSkillPrompt, resolveSkillInvocation } from '../../lib/skill-invocation';
import { stripAnsi } from '../../lib/strip-ansi';
import { getContextUsedTokens } from '../../lib/context-usage';
import { ContextMeter } from './UsageMeters';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { TiptapEditor, type TiptapEditorHandle } from './TiptapEditor';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { executeImmediateCommand as runImmediateCommand } from './immediate-commands';
import { dropStaleProcess, registerSessionListeners } from './session-launch';
import { ThinkLevelSelector, PlanToggleButton } from './InputToolbarButtons';
// drag-state import removed — tree drag handled by ChatPanel

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
  const addMessage = useChatStore((s) => s.addMessage);
  const setSessionStatus = useChatStore((s) => s.setSessionStatus);
  const setSessionMeta = useChatStore((s) => s.setSessionMeta);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const ctrlEnterToSend = useSettingsStore((s) => s.ctrlEnterToSend);

  const handlePlanApprove = useCallback(async () => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const currentMode = useSettingsStore.getState().sessionMode;
    const tabState = getActiveTabState();
    const meta = tabState.sessionMeta;
    const status = tabState.sessionStatus;

    // If CLI is still alive (e.g., Bypass auto-accepted ExitPlanMode),
    // just dismiss the card — no restart needed.
    if (meta.stdinId && status === 'running') {
      useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
      return;
    }

    // CLI exited after ExitPlanMode (permission denied in stream-json mode).
    // Plan mode: switch to Code mode for execution.
    // Bypass mode: stay in Bypass (no mode switch needed).
    if (currentMode === 'plan') {
      useSettingsStore.getState().setSessionMode('code');
    }

    // Clean up dead CLI process
    if (meta.stdinId) {
      useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
      bridge.killSession(meta.stdinId).catch(() => {});
      releaseStreamListener(meta.stdinId);
    }

    // Restart with --resume <sessionId>
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    setInputSync('Execute the plan above.');
    requestAnimationFrame(() => {
      handleSubmitRef.current();
    });
  }, [setInputSync]);

  // 右上角“压缩”按钮：会话没有运行中的进程时，通过发送 /compact 续接会话并压缩
  useEffect(() => {
    const handler = () => {
      setInputSync('/compact');
      requestAnimationFrame(() => {
        handleSubmitRef.current();
      });
    };
    window.addEventListener('tokenicode:compact-now', handler);
    return () => window.removeEventListener('tokenicode:compact-now', handler);
  }, [setInputSync]);

  // Listen for plan-execute events from PlanReviewCard and Enter shortcut
  useEffect(() => {
    const handler = () => handlePlanApprove();
    window.addEventListener('tokenicode:plan-execute', handler);
    return () => window.removeEventListener('tokenicode:plan-execute', handler);
  }, [handlePlanApprove]);

  // Floating approval cards — unresolved plan_review / question messages
  // are rendered above the input instead of inline in the chat flow.
  const floatingCard = useActiveTab((tab) => {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'plan_review' || m.type === 'question' || m.type === 'permission') && !m.resolved) return m;
    }
    return null;
  });

  const { files, setFiles, isProcessing, addFiles, removeFile, clearFiles } = useFileAttachments();

  // 本地 files 与 store.pendingAttachments 双向同步（切换标签页时保留附件）。
  // 用 lastSyncedRef 记住最近一次同步过的数组：同一个值不再反向写回。
  // 否则同一次渲染里两边都变了（如发送后清空附件 + 同时切换/改名标签页）时，
  // 两个 effect 会把两个值来回互换，形成无限更新（Maximum update depth exceeded）。
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

  // Inline file insertion: drop or drag → insert a file chip at cursor
  useEffect(() => {
    const onTreeFileInline = (e: Event) => {
      const fullPath = (e as CustomEvent<string>).detail;
      if (!fullPath || !textareaRef.current) return;

      // Convert to path relative to working directory for readability
      const cwd = useSettingsStore.getState().workingDirectory;
      let displayPath = fullPath;
      if (cwd && fullPath.startsWith(cwd)) {
        displayPath = fullPath.slice(cwd.length).replace(/^[\\/]/, '');
      }

      textareaRef.current.insertFileChip({ fullPath, label: displayPath });
    };
    window.addEventListener('tokenicode:tree-file-inline', onTreeFileInline);
    return () => window.removeEventListener('tokenicode:tree-file-inline', onTreeFileInline);
  }, []);

  // Slash command state
  const [slashQuery, setSlashQuery] = useState('');
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useCommandStore((s) => s.commands);
  const activePrefixes = useCommandStore((s) => s.activePrefixes);

  // Focus input when skills/commands are selected externally.
  useEffect(() => {
    if (activePrefixes.length > 0) {
      textareaRef.current?.focus();
    }
  }, [activePrefixes]);

  // Rewind state
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const { showRewind, canRewind } = useRewind();
  // lastEscTime removed — double-Esc rewind disabled (#36/#71)

  // Listen for rewind event from /rewind command
  useEffect(() => {
    const handler = () => {
      if (canRewind) {
        setShowRewindPanel(true);
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
  }, [canRewind, t]);

  // Double-Esc rewind shortcut disabled (#36 / #71) — rewind feature is hidden in ClaudeDeck

  // Drag state (file drop)
  const [isDragging, setIsDragging] = useState(false);

  // Fetch slash commands when working directory changes
  useEffect(() => {
    useCommandStore.getState().fetchCommands(workingDirectory || undefined);
  }, [workingDirectory]);

  const isRunning = sessionStatus === 'running';
  const isAwaiting = isRunning && activityPhase === 'awaiting';

  // Whether this is a follow-up (session already has a CLI session ID)
  const hasActiveSession = sessionStatus !== 'idle';

  // --- Slash command detection ---
  // Relaxed: detect "/" at start of first line, keep popover open even after spaces
  const detectSlashCommand = useCallback((text: string) => {
    const firstLine = text.split('\n')[0];
    const canAddAnotherSkill = activePrefixes.length === 0
      || activePrefixes.every((item) => item.category === 'skill');
    if (firstLine.startsWith('/') && canAddAnotherSkill) {
      const query = firstLine.slice(1); // strip leading "/"
      setSlashQuery(query);
      setSlashVisible(true);
      setSlashIndex(0);
    } else {
      setSlashVisible(false);
    }
  }, [activePrefixes]);

  // Ref to always point to the latest handleSubmit (avoids stale closure)
  const handleSubmitRef = useRef<() => void>(() => {});
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

  // --- Slash command selection ---
  const handleSlashSelect = useCallback((cmd: UnifiedCommand) => {
    setSlashVisible(false);
    setInputSync('');

    if (cmd.immediate) {
      if (cmd.has_args) {
        // Immediate + has_args: show prefix chip so user can type the argument
        useCommandStore.getState().addPrefix(cmd);
        textareaRef.current?.focus();
      } else {
        // Immediate execution: send command via stdin or as first message
        executeImmediateCommand(cmd.name);
      }
    } else {
      // Deferred: set as immutable prefix chip
      useCommandStore.getState().addPrefix(cmd);
      textareaRef.current?.focus();
    }
  }, [executeImmediateCommand]);

  // --- Submit ---
  const handleSubmit = useCallback(async () => {
    // Capture tabId at the start of submission
    let tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) {
      if (!workingDirectory) return;
      tabId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      useChatStore.getState().ensureTab(tabId);
      useChatStore.getState().resetTab(tabId);
      useSessionStore.getState().addDraftSession(tabId, workingDirectory);
    }
    useChatStore.getState().ensureTab(tabId);

    // Read input from store directly (not closure) so that async callers
    // like handlePlanApprove (setInput + rAF) always see the latest value.
    const rawInput = getActiveTabState().inputDraft || textareaRef.current?.getText() || '';
    let text = rawInput.trim();
    // /compact 在没有运行中的进程时（历史会话），走处理卡片而不是普通用户气泡，见下方赋值处
    let compactWithoutProcess = false;

    // Plan approval shortcut: empty Enter triggers approve & execute flow
    const tabState = getActiveTabState();
    const pendingPlanReview = tabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => m.type === 'plan_review' && !m.resolved,
    );
    if (pendingPlanReview && !text && useCommandStore.getState().activePrefixes.length === 0) {
      const stdinId = tabState.sessionMeta.stdinId;
      const permData = pendingPlanReview.permissionData;
      if (permData?.requestId && stdinId) {
        try {
          await bridge.respondPermission(
            stdinId,
            permData.requestId,
            true,
            undefined,
            permData.toolUseId,
            permData.input,
            planApprovalCliMode(),
          );
        } catch (err) {
          console.error('[TC:plan] Empty-Enter plan approval failed:', err);
          return;
        }
      }
      if (useSettingsStore.getState().sessionMode === 'plan') {
        setSessionModeLocal('code');
      }
      useChatStore.getState().updateMessage(tabId, pendingPlanReview.id, {
        resolved: true,
        interactionState: 'resolved',
      });
      window.dispatchEvent(new CustomEvent('tokenicode:plan-execute'));
      return;
    }

    // Resolve selected and directly typed skills in the app. This avoids the
    // CLI's "command not found" path and supports multiple/custom directories.
    const invocation = resolveSkillInvocation(
      text,
      useCommandStore.getState().activePrefixes,
      useCommandStore.getState().commands,
    );
    useCommandStore.getState().clearPrefixes();

    const selectedSkills = invocation.skills;
    const selectedCommand = invocation.command;
    text = invocation.userText;
    if (selectedCommand) {
      text = text ? `${selectedCommand.name} ${text}` : selectedCommand.name;
    }

    if (!text && selectedSkills.length === 0) return;

    // Intercept immediate (built-in) commands even when submitted directly
    // (e.g. user types "/help" and presses Enter without using the popover)
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const cmdPart = parts[0].toLowerCase();
      const restText = parts.slice(1).join(' ').trim();

      // Mode-switching commands: /ask, /plan, /code, /bypass
      // If followed by text, switch mode then submit the text normally
      const modeMap: Record<string, 'ask' | 'plan' | 'code' | 'bypass'> = {
        '/ask': 'ask', '/plan': 'plan', '/code': 'code', '/bypass': 'bypass',
      };
      if (modeMap[cmdPart]) {
        useSettingsStore.getState().setSessionMode(modeMap[cmdPart]);
        if (restText) {
          // Directly apply the mode prefix and continue with submission
          text = `${cmdPart} ${restText}`;
        } else {
          setInputSync('');
          const modeVal = modeMap[cmdPart];
          const modeKey = `cmd.switchedTo${modeVal.charAt(0).toUpperCase() + modeVal.slice(1)}` as any;
          const iconMap: Record<string, string> = { ask: '💬', plan: '📋', code: '⚡' };
          addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: t(modeKey),
            commandType: 'mode',
            commandData: { mode: modeVal, icon: iconMap[modeVal] },
            timestamp: Date.now(),
          });
          return;
        }
      } else {
        // Other immediate commands (e.g. /clear, /help, /compact)
        const cmds = useCommandStore.getState().commands;
        const match = cmds.find(
          (c) => c.immediate && c.name.toLowerCase() === cmdPart
        );
        // /compact 在没有运行中的进程时（如刚打开的历史会话），不走“需要活动会话”的拦截，
        // 而是作为这个会话的第一条消息发给 CLI：会续接该会话并执行压缩
        compactWithoutProcess = cmdPart === '/compact'
          && !getActiveTabState().sessionMeta.stdinId
          && !!getActiveTabState().sessionMeta.sessionId;
        if (match && !compactWithoutProcess) {
          setInputSync('');
          executeImmediateCommand(match.name, restText || undefined);
          return;
        }
      }
    }

    // 跟随 CLI 配置时，CLI 自己认识的技能（不在本应用额外添加的技能目录里）按 /技能名 交给 CLI 加载，
    // 与终端里的调用方式一致；多个技能或额外目录里的技能 CLI 处理不了，仍把技能全文拼进消息。
    const normalizePath = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();
    const extraSkillRoots = useSettingsStore.getState().skillDirectories.map((dir) => `${normalizePath(dir)}/`);
    const cliKnownSkill = selectedSkills.length === 1
      && !extraSkillRoots.some((root) => normalizePath(selectedSkills[0].path || '').startsWith(root));
    if (useSettingsStore.getState().followCli && cliKnownSkill) {
      const skillName = selectedSkills[0].name.startsWith('/') ? selectedSkills[0].name : `/${selectedSkills[0].name}`;
      text = text ? `${skillName} ${text}` : skillName;
    } else if (selectedSkills.length > 0) {
      try {
        const loadedSkills = await Promise.all(selectedSkills.map(async (skill) => ({
          skill,
          content: await bridge.readSkill(skill.path!),
        })));
        text = buildSkillPrompt(
          loadedSkills.map(({ skill, content }) => ({ name: skill.name, path: skill.path, content })),
          text,
        );
      } catch (error) {
        console.error('[ClaudeDeck:skills] failed to read selected skill:', error);
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t('skills.readFailed'),
          commandType: 'error',
          timestamp: Date.now(),
        });
        return;
      }
    }

    // Append file paths if there are attachments
    if (files.length > 0) {
      const filePaths = files.map((f) => f.path).join('\n');
      text = `${text}\n\n${t('input.attachedFiles')}\n${filePaths}`;
    }

    // 回退时“总结”的摘要：作为上下文附在这条消息前面发给模型，不显示在气泡里，发送一次后清除
    const pendingSummary = getActiveTabState().sessionMeta.pendingSummary;
    if (pendingSummary) {
      text = `${pendingSummary}\n\n${text}`;
      setSessionMeta(tabId, { pendingSummary: undefined });
    }

    setInputSync('');

    // 运行中提交的消息：普通消息直接写入 stdin，CLI 自己排队（下一个工具调用间隙插入本轮，
    // 或本轮结束后接着处理），收到它的回显时才插入气泡；斜杠命令等本轮结束再按 FIFO 发送。
    const currentTabState = getActiveTabState();
    const shouldQueue = !!currentTabState.sessionMeta.stdinId && currentTabState.sessionStatus === 'running';

    // Silent restart: skip user message bubble (Code mode ExitPlanMode auto-recovery)
    if (silentRestartRef.current) {
      silentRestartRef.current = false;
    } else if (compactWithoutProcess) {
      // 历史会话续接压缩：显示处理卡片而不是普通的“/compact”用户气泡，
      // 完成状态和压缩摘要由 useStreamProcessor 里的 result / compact_boundary 处理写入。
      // 压缩前 token 数用刚从磁盘恢复的历史会话上下文快照，不等 CLI 事件。
      const compactCardId = generateMessageId();
      addMessage(tabId, {
        id: compactCardId,
        role: 'system',
        type: 'text',
        content: '',
        commandType: 'processing',
        commandData: {
          command: '/compact',
          compactSummary: { preTokens: getContextUsedTokens(getActiveTabState().sessionMeta) },
        },
        commandStartTime: Date.now(),
        commandCompleted: false,
        timestamp: Date.now(),
      });
      setSessionMeta(tabId, { pendingCommandMsgId: compactCardId });
    } else {
      // Add user message (show original text, not with prefix)
      const userBubble: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        type: 'text',
        content: rawInput.trim() || selectedSkills.map((skill) => skill.name).join(' '),
        timestamp: Date.now(),
        attachments: files.length > 0
          ? files.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage, preview: f.preview }))
          : undefined,
      };
      // 会话列表右侧的时间是最后发言时间：立即更新，不等磁盘写入或远程列表刷新
      useSessionStore.getState().touchSession(tabId, userBubble.timestamp);
      if (shouldQueue) {
        // 气泡等 CLI 真正处理这条消息时再插入，否则会排在本轮回复的正文前面
        clearFiles();
        // 普通消息直接写入 stdin，与终端一致：CLI 在下一个工具调用间隙插入本轮，或本轮结束后接着处理。
        // 斜杠命令仍等本轮结束再发送
        const midTurnStdinId = currentTabState.sessionMeta.stdinId;
        if (midTurnStdinId && !text.startsWith('/')) {
          useChatStore.getState().addPendingMessage(tabId, { text, message: userBubble, sent: true });
          try {
            await bridge.sendStdin(midTurnStdinId, text);
          } catch (err) {
            console.warn('[ClaudeDeck] mid-turn sendStdin failed, queued instead:', err);
            useChatStore.getState().markPendingUnsent(tabId, userBubble.id);
          }
        } else {
          useChatStore.getState().addPendingMessage(tabId, { text, message: userBubble });
        }
        return;
      }
      addMessage(tabId, userBubble);
    }

    clearFiles();

    if (shouldQueue) {
      useChatStore.getState().addPendingMessage(tabId, { text });
      return;
    }

    const turnStartedAt = Date.now();
    setSessionStatus(tabId, 'running');
    setSessionMeta(tabId, {
      turnStartTime: turnStartedAt,
      lastProgressAt: turnStartedAt,
      inputTokens: 0,
      outputTokens: 0,
    });
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    lastStderrRef.current = ''; // Clear stale stderr before new turn

    // Initialize agent tracking — clear previous turn's agents (they may be from a
    // different project/session) and create a fresh main agent for this turn.
    useAgentStore.getState().clearAgents();
    useAgentStore.getState().upsertAgent({
      id: 'main',
      parentId: null,
      description: rawInput.trim(),
      phase: 'spawning',
      startTime: Date.now(),
      isMain: true,
    });

    let sessionStdinId: string | undefined;

    try {
      if (!workingDirectory) {
        setSessionStatus(tabId, 'error');
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: 'No working directory selected. Please select a project folder first.',
          timestamp: Date.now(),
        });
        return;
      }

      // Check model mapping before sending — block if provider has no mapping for selected tier
      const modelResolution = resolveModelOrError(selectedModel);
      if (!modelResolution.ok) {
        const msg = t('provider.noModelMapping')
          .replace('{provider}', modelResolution.providerName)
          .replace('{tier}', modelResolution.tier);
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: msg,
          timestamp: Date.now(),
        });
        setSessionStatus(tabId, 'error');
        return;
      }

      // Use stdinId (desk-generated) for stdin communication, not CLI's own sessionId.
      // stdinId exists when: (a) a pre-warmed process is waiting, or (b) follow-up in active session.
      const submitTabState = getActiveTabState();
      let stdinId = submitTabState.sessionMeta.stdinId;
      let sentViaStdin = false;

      if (stdinId) {
        if (dropStaleProcess(tabId, stdinId, text, selectedModel)) {
          stdinId = undefined;
        } else {
          // ===== Send via stdin to existing persistent process (pre-warmed or follow-up) =====
          try {
            await bridge.sendStdin(stdinId, text);
            sentViaStdin = true;
            // Defensive: ensure spawnedModel is always recorded after first successful stdin send
            if (!getActiveTabState().sessionMeta.spawnedModel) {
              setSessionMeta(tabId, { spawnedModel: resolveModelForProvider(selectedModel) });
            }
          } catch (stdinErr) {
            // stdin write failed (broken pipe — process already exited).
            // Clean up dead listeners (P0-5 fix) and fall through to spawn a new process.
            console.warn('[ClaudeDeck] sendStdin failed, spawning new process:', stdinErr);
            releaseStreamListener(stdinId);
            setSessionMeta(tabId, { stdinId: undefined });
            stdinId = undefined;
          }
        }
      }

      if (!sentViaStdin) {
        // ===== No running process: spawn a new persistent stream-json process =====

        // Mode is now passed via --mode CLI arg in startSession, not text prefix.
        // Text prefix (/ask, /plan) caused "Unknown skill" errors in stream-json mode.

        // If we have an existing sessionId (loaded historical session), resume it.
        // Only use it as resume_session_id if it looks like a real CLI session ID (UUID),
        // not a desk-generated ID like "desk_xxx".
        const rawSessionId = getActiveTabState().sessionMeta.sessionId;
        const existingSessionId = rawSessionId && !rawSessionId.startsWith('desk_')
          ? rawSessionId
          : undefined;

        // TK-329 fix: only clean up THIS tab's old stdinId listener, not the global singleton.
        // The old __claudeUnlisten global could kill another tab's active listener.
        const oldStdinId = getActiveTabState().sessionMeta.stdinId;
        if (oldStdinId && hasStreamListener(oldStdinId)) {
          releaseStreamListener(oldStdinId);
          // Also flush any pending stream buffer for the old session
          flushStreamBuffer(oldStdinId);
        }

        const cwd = workingDirectory;

        // Generate the desk-side session ID FIRST so we can register
        // event listeners BEFORE spawning the process.
        const preGeneratedId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sessionStdinId = preGeneratedId;

        // Reset guards for the new session
        autoCompactFiredRef.current = false;
        exitPlanModeSeenRef.current = false;

        // TK-329 fix: register stdinId → tabId mapping BEFORE listeners,
        // so events arriving immediately after spawn can be routed correctly.
        const earlyTabId = useSessionStore.getState().selectedSessionId;
        if (earlyTabId) {
          useSessionStore.getState().registerStdinTab(preGeneratedId, earlyTabId);
        }

        // Register listeners BEFORE starting the session
        await registerSessionListeners(preGeneratedId, () => tabId, handleStreamMessage, handleStderrLine);

        // Spawn persistent process (first message sent via stdin inside Rust)
        // If resuming a historical session, pass resume_session_id so the CLI
        // picks up the existing conversation context.
        // Read sessionMode from store (not closure) so plan-approve → code
        // mode switch is visible even when called via rAF.
        const liveSessionMode = useSettingsStore.getState().sessionMode;
        const liveThinkingSetting = useSettingsStore.getState().thinkingLevel;
        const liveContextWindowMode = useSettingsStore.getState().contextWindowMode;
        const liveThinkingLevel = resolveThinkingLevelForProvider(selectedModel, liveThinkingSetting);
        const liveProviderId = useProviderStore.getState().activeProviderId || null;
        const liveResolvedModel = resolveModelForProvider(selectedModel);
        const liveContextWindow = getContextWindowForModel(liveResolvedModel, liveContextWindowMode);
        console.log('[ClaudeDeck:session] starting session', { cwd, stdinId: preGeneratedId, mode: liveSessionMode, provider: liveProviderId });
        const session = await bridge.startSession({
          prompt: text,
          cwd,
          session_id: preGeneratedId,
          resume_session_id: existingSessionId || undefined,
          // 回退后的第一次启动：续接到回退点并分叉出新会话，模型只记得回退点之前的历史
          resume_session_at: existingSessionId
            ? getActiveTabState().sessionMeta.resumeAtUuid || undefined
            : undefined,
          ...cliLaunchArgs(liveResolvedModel, liveThinkingLevel),
          session_mode: (liveSessionMode === 'ask' || liveSessionMode === 'plan') ? liveSessionMode : undefined,
          provider_id: liveProviderId || undefined,
          context_window: liveContextWindow,
          permission_mode: mapSessionModeToPermissionMode(liveSessionMode),
          enable_mcp: useSettingsStore.getState().enableMcp,
        });
        console.log('[ClaudeDeck:session] started successfully', { sessionId: session.session_id, pid: session.pid, cli: session.cli_path });

        // Store both: session_id for tracking, stdinId (preGeneratedId) for stdin communication
        const rewoundFromSessionId = getActiveTabState().sessionMeta.rewoundFromSessionId;
        setSessionMeta(tabId, {
          sessionId: session.session_id,
          rewoundFromSessionId: undefined,
          resumeAtUuid: undefined,
          stdinId: preGeneratedId,
          envFingerprint: envFingerprint(),
          snapshotMode: liveSessionMode,
          snapshotModel: selectedModel,
          snapshotThinking: liveThinkingSetting,
          snapshotContextWindowMode: liveContextWindowMode,
          snapshotProviderId: liveProviderId,
          spawnedModel: liveResolvedModel,
        });

        // Rewind replaces the visible history instead of leaving old and new
        // branches side-by-side. The old JSONL remains on disk for recovery.
        if (rewoundFromSessionId && session.session_id !== tabId) {
          const chatState = useChatStore.getState();
          const tabData = chatState.getTab(tabId);
          if (tabData) {
            const newTabs = new Map(chatState.tabs);
            newTabs.set(session.session_id, { ...tabData, tabId: session.session_id });
            newTabs.delete(tabId);
            useChatStore.setState({ tabs: newTabs });
          }
          useSessionStore.getState().promoteDraft(tabId, session.session_id);
          bridge.hideSession(rewoundFromSessionId).catch((error) => {
            console.warn('[ClaudeDeck:rewind] failed to hide superseded session:', error);
          });
          tabId = session.session_id;
        }
        // Note: stdinId → tabId mapping already registered before listener setup (TK-329)

        // 会话列表以 CLI 目录为准，无需登记，直接刷新
        useSessionStore.getState().fetchSessions();
        // Delayed retry in case JSONL file isn't written yet
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1500);
      }
    } catch (err: any) {
      releaseStreamListener(sessionStdinId);
      if (sessionStdinId) {
        useSessionStore.getState().unregisterStdinTab(sessionStdinId);
      }
      setSessionStatus(tabId, 'error');
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: `Error: ${err}`,
        timestamp: Date.now(),
      });
    }
  }, [hasActiveSession, workingDirectory, selectedModel, sessionMode, files, clearFiles]);

  // Keep ref in sync so executeImmediateCommand can call latest handleSubmit
  handleSubmitRef.current = handleSubmit;

  // handleStreamMessage 由 useStreamProcessor 提供（src/hooks/useStreamProcessor.ts），
  // 前台、后台标签页的流消息都经它处理。

  // Handle stderr lines — detect permission prompts and other interactive requests
  const handleStderrLine = useCallback((line: string, sid: string) => {
    if (sid) {
      const ownerTabId = useSessionStore.getState().getTabForStdin(sid);
      const activeTabId = useSessionStore.getState().selectedSessionId;
      if (ownerTabId && ownerTabId !== activeTabId) {
        const clean = stripAnsi(line).trim();
        if (clean) {
          useChatStore.getState().addMessage(ownerTabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: `[stderr] ${clean}`,
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // Strip ANSI escape codes so regex matching works on raw text
    const clean = stripAnsi(line).trim();
    console.log('[ClaudeDeck:stderr]', clean);

    // Track last non-trivial stderr line for error reporting on unexpected exit
    if (clean && !/^\s*$/.test(clean)) {
      lastStderrRef.current = clean;
    }

    const stderrTabId = useSessionStore.getState().selectedSessionId;

    // Detect ExitPlanMode prompt — create plan_review card as fallback (Plan mode only).
    // In Code/Bypass modes the CLI or Rust backend handles this — no UI card needed.
    if (/(?:Exit|Leave)\s+plan\s+mode/i.test(clean)
        && useSettingsStore.getState().sessionMode === 'plan') {
      const stderrTabState = getActiveTabState();
      const existingReview = stderrTabState.messages.find(
        (m: import('../../stores/chatStore').ChatMessage) => m.id === 'plan_review_current' && m.type === 'plan_review',
      );
      if (!existingReview || existingReview.resolved) {
        if (existingReview?.resolved) return;
        let planContent = '';
        for (let i = stderrTabState.messages.length - 1; i >= 0; i--) {
          const m = stderrTabState.messages[i];
          if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
            planContent = m.toolInput.content;
            break;
          }
        }
        if (stderrTabId) {
          useChatStore.getState().addMessage(stderrTabId, {
            id: 'plan_review_current',
            role: 'assistant', type: 'plan_review',
            content: planContent, planContent: planContent,
            resolved: false, timestamp: Date.now(),
          });
          useChatStore.getState().setActivityStatus(stderrTabId, { phase: 'awaiting' });
        }
      }
      return;
    }

    // Permission prompts are now handled via SDK control protocol (P1-03/P1-04).
    // The Rust backend intercepts control_request messages from stdout and emits
    // them on the claude:permission_request channel, which is handled by
    // onPermissionRequest above. Stderr is now purely for diagnostic logging.
  }, []);

  // Keep stderr ref in sync so auto-retry logic in handleStreamMessage can call it
  handleStderrLineRef.current = handleStderrLine;

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

  // --- Keyboard handler ---
  /** Keyboard handler for the tiptap editor.
   *  Receives a native KeyboardEvent (not React.KeyboardEvent).
   *  Return true to prevent tiptap default handling. */
  const handleKeyDown = (e: KeyboardEvent): boolean | void => {
    // Slash command navigation
    if (slashVisible) {
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
        // No matching command — close popover, let Enter fall through to submit
        if (e.key === 'Enter') {
          setSlashVisible(false);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashVisible(false);
        return true;
      }
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
            <FileUploadChips files={files} onRemove={removeFile} isProcessing={isProcessing} />
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
            onClose={() => setSlashVisible(false)}
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
              placeholder={activePrefixes.length > 0
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
            <span className="flex-shrink-0 text-[10px] text-text-tertiary/50
              group-focus-within/input:hidden select-none whitespace-nowrap
              self-center mr-1">
              {t(ctrlEnterToSend ? 'input.shortcutHintCtrlEnter' : 'input.shortcutHint')}
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
              onClick={async () => {
                const stopTabId = useSessionStore.getState().selectedSessionId;
                const sid = getActiveTabState().sessionMeta.stdinId;
                // Immediately clear stdinId so no further messages are sent to the dead process
                if (stopTabId) {
                  useChatStore.getState().setSessionMeta(stopTabId, { stdinId: undefined });
                  useChatStore.getState().setSessionStatus(stopTabId, 'completed');
                  useChatStore.getState().setActivityStatus(stopTabId, { phase: 'completed' });
                }
                if (sid) {
                  await bridge.killSession(sid).catch(() => {});
                  // Don't unlisten immediately — let process_exit fire naturally to clean up.
                  // The listener will be replaced when a new session spawns (line ~788).
                  // As a safety net, force-clean after 3s if process_exit hasn't arrived.
                  setTimeout(() => {
                    releaseStreamListener(sid);
                  }, 3000);
                }
              }}
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
