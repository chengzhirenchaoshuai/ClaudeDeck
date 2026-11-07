// 输入栏发送一条消息的三个阶段（InputBar 的 handleSubmit 依次调用）：
// 1. prepareSubmission：读输入，处理计划审批快捷键、技能、模式命令、立即执行的命令，拼出要发给 CLI 的文本
// 2. showUserTurn：显示用户气泡（或续接压缩的处理卡）；运行中提交的消息在这里排队
// 3. launchTurn：开始新一轮，写入已有进程的 stdin，或启动新的 CLI 进程
import type { MutableRefObject } from 'react';
import { useChatStore, getActiveTabState, generateMessageId, type ChatMessage } from '../../stores/chatStore';
import {
  useSettingsStore, mapSessionModeToPermissionMode, setSessionModeLocal, planApprovalCliMode, getContextWindowForModel,
} from '../../stores/settingsStore';
import { useSessionStore, hostOfPath } from '../../stores/sessionStore';
import { useCommandStore } from '../../stores/commandStore';
import { useAgentStore } from '../../stores/agentStore';
import { useProviderStore } from '../../stores/providerStore';
import { bridge, type UnifiedCommand } from '../../lib/tauri-bridge';
import { hasStreamListener, releaseStreamListener } from '../../lib/stream-listeners';
import { flushStreamBuffer } from '../../hooks/stream/buffer';
import {
  cliLaunchArgs, envFingerprint, resolveModelForProvider, resolveModelOrError, resolveThinkingLevelForProvider,
} from '../../lib/api-provider';
import { buildSkillPrompt, resolveSkillInvocation } from '../../lib/skill-invocation';
import { getContextUsedTokens } from '../../lib/context-usage';
import type { StreamMessage } from '../../lib/stream-message';
import type { FileAttachment } from '../../hooks/useFileAttachments';
import { dropStaleProcess, registerSessionListeners } from './session-launch';
import type { SpawningSessions } from './stop-session';

type Translate = (key: string) => string;

const addMessage = (tabId: string, message: ChatMessage) => useChatStore.getState().addMessage(tabId, message);
const setSessionMeta: ReturnType<typeof useChatStore.getState>['setSessionMeta'] = (tabId, meta) =>
  useChatStore.getState().setSessionMeta(tabId, meta);

/** 准备好、要发给 CLI 的一条消息 */
export interface PreparedSubmission {
  /** 实际写入 stdin 的文本（含技能全文、附件路径、回退摘要等） */
  text: string;
  /** 用户在输入框里输入的原文（显示在气泡里，撤回时放回输入框） */
  rawInput: string;
  sentPrefixes: UnifiedCommand[];
  selectedSkills: UnifiedCommand[];
  /** 历史会话（没有运行中的进程）里发的 /compact：续接会话并压缩，显示处理卡而不是用户气泡 */
  compactWithoutProcess: boolean;
  pendingSummary?: string;
}

interface PrepareDeps {
  tabId: string;
  rawInput: string;
  files: FileAttachment[];
  t: Translate;
  setInputSync: (text: string) => void;
  executeImmediateCommand: (cmdName: string, args?: string) => void;
}

const MODE_COMMANDS: Record<string, 'ask' | 'plan' | 'code' | 'bypass'> = {
  '/ask': 'ask', '/plan': 'plan', '/code': 'code', '/bypass': 'bypass',
};
const MODE_ICONS: Record<string, string> = { ask: '💬', plan: '📋', code: '⚡' };

/** 阶段 1：返回 null 表示这次提交已经处理完（或无需发送），不再继续 */
export async function prepareSubmission({
  tabId, rawInput, files, t, setInputSync, executeImmediateCommand,
}: PrepareDeps): Promise<PreparedSubmission | null> {
  let text = rawInput.trim();
  let compactWithoutProcess = false;

  // 有待审阅的计划时，空输入框按 Enter 即批准并执行
  const tabState = getActiveTabState();
  const pendingPlanReview = tabState.messages.find((m) => m.type === 'plan_review' && !m.resolved);
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
        return null;
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
    return null;
  }

  // 选中的和直接输入的技能都在应用里解析：避开 CLI 的“命令不存在”，并支持多个技能、自定义目录
  const sentPrefixes = useCommandStore.getState().activePrefixes;
  const invocation = resolveSkillInvocation(text, sentPrefixes, useCommandStore.getState().commands);
  useCommandStore.getState().clearPrefixes();

  const selectedSkills = invocation.skills;
  const selectedCommand = invocation.command;
  text = invocation.userText;
  if (selectedCommand) {
    text = text ? `${selectedCommand.name} ${text}` : selectedCommand.name;
  }

  if (!text && selectedSkills.length === 0) return null;
  // 已经发出新内容，上一轮预测的下一句话作废
  useChatStore.getState().setPromptSuggestion(tabId, undefined);

  // 直接输入并回车的内置命令（不经弹窗选择，如输入 /help 回车）也要拦截
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmdPart = parts[0].toLowerCase();
    const restText = parts.slice(1).join(' ').trim();

    // 切换模式：/ask、/plan、/code、/bypass；后面带了文字时切换后照常发送这段文字
    const mode = MODE_COMMANDS[cmdPart];
    if (mode) {
      useSettingsStore.getState().setSessionMode(mode);
      if (restText) {
        text = `${cmdPart} ${restText}`;
      } else {
        setInputSync('');
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t(`cmd.switchedTo${mode.charAt(0).toUpperCase() + mode.slice(1)}`),
          commandType: 'mode',
          commandData: { mode, icon: MODE_ICONS[mode] },
          timestamp: Date.now(),
        });
        return null;
      }
    } else {
      // 其他立即执行的命令（如 /clear、/help、/compact）
      const match = useCommandStore.getState().commands.find(
        (c) => c.immediate && c.name.toLowerCase() === cmdPart,
      );
      // /compact 在没有运行中的进程时（如刚打开的历史会话），不走“需要活动会话”的拦截，
      // 而是作为这个会话的第一条消息发给 CLI：会续接该会话并执行压缩
      compactWithoutProcess = cmdPart === '/compact'
        && !getActiveTabState().sessionMeta.stdinId
        && !!getActiveTabState().sessionMeta.sessionId;
      if (match && !compactWithoutProcess) {
        setInputSync('');
        executeImmediateCommand(match.name, restText || undefined);
        return null;
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
      return null;
    }
  }

  // 有附件时在末尾附上文件路径
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

  return { text, rawInput, sentPrefixes, selectedSkills, compactWithoutProcess, pendingSummary };
}

interface ShowTurnDeps {
  tabId: string;
  prepared: PreparedSubmission;
  files: FileAttachment[];
  clearFiles: () => void;
  /** Code 模式 ExitPlanMode 自动恢复时为 true：这次不显示用户气泡（用完即复位） */
  silentRestartRef: MutableRefObject<boolean>;
}

/**
 * 阶段 2：显示这一轮的用户气泡。返回 true 表示消息已排队（运行中提交），本次提交到此结束。
 * 运行中提交的普通消息直接写入 stdin，CLI 自己排队（下一个工具调用间隙插入本轮，或本轮结束后接着处理），
 * 收到它的回显时才插入气泡；斜杠命令等本轮结束再按 FIFO 发送。
 */
export async function showUserTurn({ tabId, prepared, files, clearFiles, silentRestartRef }: ShowTurnDeps): Promise<boolean> {
  const { text, rawInput, sentPrefixes, selectedSkills, compactWithoutProcess, pendingSummary } = prepared;
  const currentTabState = getActiveTabState();
  const shouldQueue = !!currentTabState.sessionMeta.stdinId && currentTabState.sessionStatus === 'running';

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
    // 用户气泡显示原文，不含技能全文等前缀
    const userBubble: ChatMessage = {
      id: generateMessageId(),
      role: 'user',
      type: 'text',
      content: rawInput.trim() || selectedSkills.map((skill) => skill.name).join(' '),
      timestamp: Date.now(),
      attachments: files.length > 0
        ? files.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage, preview: f.preview, size: f.size, type: f.type }))
        : undefined,
      sendContext: { rawInput, prefixes: sentPrefixes, pendingSummary },
    };
    // 会话列表右侧的时间是最后发言时间：立即更新，不等磁盘写入或远程列表刷新
    useSessionStore.getState().touchSession(tabId, userBubble.timestamp);
    if (shouldQueue) {
      // 气泡等 CLI 真正处理这条消息时再插入，否则会排在本轮回复的正文前面
      clearFiles();
      const midTurnStdinId = currentTabState.sessionMeta.stdinId;
      if (midTurnStdinId && !text.startsWith('/')) {
        const uuid = crypto.randomUUID();
        useChatStore.getState().addPendingMessage(tabId, { text, message: userBubble, sent: true, uuid });
        try {
          await bridge.sendStdin(midTurnStdinId, text, uuid);
        } catch (err) {
          console.warn('[ClaudeDeck] mid-turn sendStdin failed, queued instead:', err);
          useChatStore.getState().markPendingUnsent(tabId, userBubble.id);
        }
      } else {
        useChatStore.getState().addPendingMessage(tabId, { text, message: userBubble });
      }
      return true;
    }
    addMessage(tabId, userBubble);
  }

  clearFiles();

  if (shouldQueue) {
    useChatStore.getState().addPendingMessage(tabId, { text });
    return true;
  }
  return false;
}

interface LaunchDeps {
  tabId: string;
  text: string;
  rawInput: string;
  workingDirectory: string;
  selectedModel: string;
  t: Translate;
  spawning: SpawningSessions;
  lastStderrRef: MutableRefObject<string>;
  autoCompactFiredRef: MutableRefObject<boolean>;
  exitPlanModeSeenRef: MutableRefObject<boolean>;
  handleStreamMessage: (msg: StreamMessage) => void;
  handleStderrLine: (line: string, sid: string) => void;
}

/** 阶段 3：开始新一轮。已有可用进程时写入 stdin，否则启动新进程（历史会话用 --resume 续接） */
export async function launchTurn({
  tabId, text, rawInput, workingDirectory, selectedModel, t, spawning,
  lastStderrRef, autoCompactFiredRef, exitPlanModeSeenRef, handleStreamMessage, handleStderrLine,
}: LaunchDeps): Promise<void> {
  const turnStartedAt = Date.now();
  useChatStore.getState().setSessionStatus(tabId, 'running');
  setSessionMeta(tabId, {
    turnStartTime: turnStartedAt,
    lastProgressAt: turnStartedAt,
    inputTokens: 0,
    outputTokens: 0,
    awaitingQueuedTurn: undefined,
  });
  useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
  lastStderrRef.current = ''; // 清掉上一轮残留的 stderr

  // 重新开始代理跟踪：清掉上一轮的代理（可能来自别的项目/会话），为本轮建一个主代理
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
  let spawn: { stdinId: string; cancelled: boolean } | undefined;

  try {
    if (!workingDirectory) {
      useChatStore.getState().setSessionStatus(tabId, 'error');
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: 'No working directory selected. Please select a project folder first.',
        timestamp: Date.now(),
      });
      return;
    }

    // 发送前检查模型映射：当前服务商没有为所选档位配置模型时不发送
    const modelResolution = resolveModelOrError(selectedModel);
    if (!modelResolution.ok) {
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: t('provider.noModelMapping')
          .replace('{provider}', modelResolution.providerName)
          .replace('{tier}', modelResolution.tier),
        timestamp: Date.now(),
      });
      useChatStore.getState().setSessionStatus(tabId, 'error');
      return;
    }

    // stdin 通信用本应用生成的 stdinId（不是 CLI 自己的 sessionId）。
    // 有 stdinId 说明：(a) 有预热好的进程在等待，或 (b) 活动会话里的后续消息
    let stdinId = getActiveTabState().sessionMeta.stdinId;
    let sentViaStdin = false;

    if (stdinId) {
      if (dropStaleProcess(tabId, stdinId, text, selectedModel)) {
        stdinId = undefined;
      } else {
        try {
          await bridge.sendStdin(stdinId, text);
          sentViaStdin = true;
          // 兜底：第一次经 stdin 发送成功后一定记下 spawnedModel
          if (!getActiveTabState().sessionMeta.spawnedModel) {
            setSessionMeta(tabId, { spawnedModel: resolveModelForProvider(selectedModel) });
          }
        } catch (stdinErr) {
          // 写入失败（进程已退出，管道断开）：注销残留的监听，改为启动新进程
          console.warn('[ClaudeDeck] sendStdin failed, spawning new process:', stdinErr);
          releaseStreamListener(stdinId);
          setSessionMeta(tabId, { stdinId: undefined });
          stdinId = undefined;
        }
      }
    }

    if (sentViaStdin) return;

    // ===== 没有可用进程：启动新的常驻 stream-json 进程 =====
    // 模式经 startSession 的参数传入，不再加文本前缀（stream-json 模式下 /ask、/plan 前缀会报“Unknown skill”）。

    // 已加载的历史会话用 --resume 续接；只认 CLI 的真实会话 ID（UUID），不认本应用生成的 desk_ 临时 ID
    const rawSessionId = getActiveTabState().sessionMeta.sessionId;
    const existingSessionId = rawSessionId && !rawSessionId.startsWith('desk_') ? rawSessionId : undefined;

    // TK-329：只清理本标签页旧 stdinId 的监听，不能用全局的 __claudeUnlisten（会误杀别的标签页）
    const oldStdinId = getActiveTabState().sessionMeta.stdinId;
    if (oldStdinId && hasStreamListener(oldStdinId)) {
      releaseStreamListener(oldStdinId);
      flushStreamBuffer(oldStdinId);
    }

    const cwd = workingDirectory;

    // 先生成本应用的会话 ID，才能在启动进程之前注册事件监听
    const preGeneratedId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStdinId = preGeneratedId;
    spawn = { stdinId: preGeneratedId, cancelled: false };
    spawning.set(tabId, spawn);

    // 新会话重置保护标记
    autoCompactFiredRef.current = false;
    exitPlanModeSeenRef.current = false;

    // TK-329：先登记 stdinId → tabId，再注册监听，启动后立即到达的事件才能正确路由
    const earlyTabId = useSessionStore.getState().selectedSessionId;
    if (earlyTabId) {
      useSessionStore.getState().registerStdinTab(preGeneratedId, earlyTabId);
    }

    await registerSessionListeners(preGeneratedId, () => tabId, handleStreamMessage, handleStderrLine);

    // 启动常驻进程（第一条消息由 Rust 侧写入 stdin）。
    // 模式等设置从 store 读而不是闭包：计划批准后切到代码模式、经 rAF 调用时也能读到新值
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

    // 启动期间用户点了终止：此时才拿得到进程，直接结束，不接管这个会话
    if (spawn.cancelled) {
      bridge.killSession(preGeneratedId).catch(() => {});
      releaseStreamListener(preGeneratedId);
      useSessionStore.getState().unregisterStdinTab(preGeneratedId);
      return;
    }

    // session_id 用于跟踪，stdinId（preGeneratedId）用于 stdin 通信
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

    // 回退：新分支替换旧分支显示，旧 JSONL 留在磁盘上以便恢复。
    // 标签页先保留旧 ID，等 CLI 回报新分支的真实会话 ID 后（useStreamProcessor）
    // 再把标签页、列表行和会话名一起迁移过去。不能改用 session.session_id：
    // 那是本应用生成的 desk_ 临时 ID，列表里永远对不上，原会话的行会消失、改的名字也会丢。
    // 旧分支也等到那时再隐藏：提前隐藏的话，列表刷新会先删掉这一行（远程列表要等这轮结束才刷新），
    // 启动失败时还会把仍然有效的旧会话藏起来。
    if (rewoundFromSessionId) {
      setSessionMeta(tabId, { forkFrom: { id: rewoundFromSessionId, host: hostOfPath(cwd) } });
    }

    // 会话列表以 CLI 目录为准，无需登记，直接刷新；JSONL 可能还没写入，稍后再刷新一次
    useSessionStore.getState().fetchSessions();
    setTimeout(() => useSessionStore.getState().fetchSessions(), 1500);
  } catch (err) {
    releaseStreamListener(sessionStdinId);
    if (sessionStdinId) {
      useSessionStore.getState().unregisterStdinTab(sessionStdinId);
    }
    // 已被用户终止的启动，失败了也不用再报错
    if (spawn?.cancelled) return;
    useChatStore.getState().setSessionStatus(tabId, 'error');
    addMessage(tabId, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content: `Error: ${err}`,
      timestamp: Date.now(),
    });
  } finally {
    if (spawn && spawning.get(tabId) === spawn) spawning.delete(tabId);
  }
}
