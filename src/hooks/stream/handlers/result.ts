// result 消息：一轮结束后的收尾（重试、计划模式重启、命令卡、标题生成、自动压缩、排队消息）。
import { useChatStore, generateMessageId } from '../../../stores/chatStore';
import { useSettingsStore, mapSessionModeToPermissionMode, getEffectiveMode, getContextWindowForModel, getAutoCompactThreshold } from '../../../stores/settingsStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { resolveAgentId } from '../../../stores/agentStore';
import { useProviderStore } from '../../../stores/providerStore';
import { bridge, onClaudeStream, onClaudeStderr } from '../../../lib/tauri-bridge';
import { releaseStreamListener, setStreamListener } from '../../../lib/stream-listeners';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../../../lib/api-provider';
import { t } from '../../../lib/i18n';
import { getContextUsedTokens } from '../../../lib/context-usage';
import { type StreamMessage, type ResultMessage } from '../../../lib/stream-message';
import { resolveSessionContextWindow } from '../../../lib/context-window';
import { persistTokenState } from '../token-state';
import { commitPartialText } from '../buffer';
import { type StreamContext } from '../context';

export function handleResultMessage(ctx: StreamContext, msg: ResultMessage): void {
  const { tabId, msgStdinId, agentActions, clearPartial } = ctx;

  // Sub-agent results carry parent_tool_use_id — they must NOT terminate the
  // main session. Only the main agent's result (no parent_tool_use_id) ends the
  // session. Without this guard, the first parallel sub-agent to complete would
  // call setSessionStatus('completed') and freeze the UI mid-run.
  if (msg.parent_tool_use_id) {
    agentActions?.completeAgent(
      resolveAgentId(msg.parent_tool_use_id, agentActions?.agents),
      msg.subtype === 'success' ? 'completed' : 'error',
    );
    return;
  }

  // Preserve delta-only replies before clearing streaming state.
  commitPartialText(tabId, msgStdinId);
  clearPartial();

  if (retryAfterThinkingSignatureError(ctx, msg)) return;
  if (restartAfterExitPlanMode(ctx, msg)) return;
  completePendingCommand(ctx, msg);
  finalizeTurn(ctx, msg);
  maybeGenerateTitle(ctx, msg);
  if (maybeAutoCompact(ctx, msg)) return;
  sendNextPendingMessage(ctx);
}

/** 切换服务商/模型后旧思考块签名被拒：放弃 resume，用新进程重发。已接管时返回 true。 */
function retryAfterThinkingSignatureError(ctx: StreamContext, msg: ResultMessage): boolean {
  const { tabId, isForeground, agentActions, addMessage, setSessionStatus, setSessionMeta, setActivityStatus, dispatch } = ctx;
  const { handleStderrLineRef } = ctx.config;

  // --- TK-303: Auto-retry on thinking signature error after provider/model switch ---
  // When user switches API provider or model mid-conversation, we attempt to resume
  // the session. If the new provider/model rejects the old thinking block signatures,
  // we automatically retry without resume to preserve UX continuity.
  // 重试流程读取当前设置（工作目录、模型等）并注册到当前选中的标签页，只用于前台。
  if (isForeground && msg.subtype !== 'success') {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    // Build a combined error string from all possible error fields
    const errorText = [msg.result, msg.error, msg.content]
      .filter(Boolean)
      .map(String)
      .join(' ');
    const isThinkingSignatureError = /invalid.*signature.*thinking|thinking.*invalid.*signature/i.test(errorText);

    const switchedFlag = meta.providerSwitched || meta.modelSwitched;
    const pendingText = meta.providerSwitchPendingText || meta.modelSwitchPendingText;
    // Find last user message as fallback retry text when no pendingText is set
    const lastUserMsg = !pendingText
      ? [...(useChatStore.getState().getTab(tabId)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
      : undefined;
    const retryCandidate = pendingText || (typeof lastUserMsg === 'string' ? lastUserMsg : undefined);
    if (isThinkingSignatureError && retryCandidate) {
      const switchType = switchedFlag ? (meta.modelSwitched ? '模型' : 'API 提供商') : '会话';
      console.warn(`[ClaudeDeck] Thinking signature error after ${switchType} switch — auto-retrying without resume`);
      const retryText = retryCandidate;

      // Kill the current (failed) process
      const failedStdinId = meta.stdinId;
      if (failedStdinId) {
        bridge.killSession(failedStdinId).catch(() => {});
        releaseStreamListener(failedStdinId);
      }

      // Clear sessionId (abandon resume) and switch flags
      setSessionMeta({
        sessionId: undefined,
        stdinId: undefined,
        providerSwitched: false,
        providerSwitchPendingText: undefined,
        modelSwitched: false,
        modelSwitchPendingText: undefined,
      });

      // Show system notice
      addMessage({
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: `已切换${switchType}，正在重新发送…`,
        commandType: 'info',
        timestamp: Date.now(),
      });

      // Re-send: spawn a fresh process without resume_session_id
      (async () => {
        // P0-5: Declare retryId outside try so catch can clean up listeners on failure
        const retryId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          const cwd = useSettingsStore.getState().workingDirectory;
          if (!cwd) return;
          const selectedModel = useSettingsStore.getState().selectedModel;
          const sessionMode = useSettingsStore.getState().sessionMode;

          const retryTurnStartedAt = Date.now();
          setSessionStatus('running');
          setSessionMeta({
            turnStartTime: retryTurnStartedAt,
            lastProgressAt: retryTurnStartedAt,
            inputTokens: 0,
            outputTokens: 0,
          });
          setActivityStatus({ phase: 'thinking' });
          agentActions?.clearAgents();
          agentActions?.upsertAgent({
            id: 'main', parentId: null,
            description: retryText.slice(0, 100),
            phase: 'spawning', startTime: Date.now(), isMain: true,
          });
          const retryUnlisten = await onClaudeStream(retryId, (m: StreamMessage) => {
            m.__stdinId = retryId;
            dispatch(m);
          });
          const retryUnlistenStderr = await onClaudeStderr(retryId, (line: string) => {
            handleStderrLineRef.current(line, retryId);
          });
          const retryRelease = () => { retryUnlisten(); retryUnlistenStderr(); };
          setStreamListener(retryId, retryRelease);
          window.__claudeUnlisten = retryRelease;

          const retryResolvedModel = resolveModelForProvider(selectedModel);
          const retryContextWindowMode = useSettingsStore.getState().contextWindowMode;
          const session = await bridge.startSession({
            prompt: retryText,
            cwd,
            model: retryResolvedModel,
            session_id: retryId,
            // No resume_session_id — fresh start to avoid thinking signature issue
            thinking_level: resolveThinkingLevelForProvider(
              selectedModel,
              useSettingsStore.getState().thinkingLevel,
            ),
            session_mode: (sessionMode === 'ask' || sessionMode === 'plan') ? sessionMode : undefined,
            provider_id: useProviderStore.getState().activeProviderId || undefined,
            context_window: getContextWindowForModel(retryResolvedModel, retryContextWindowMode),
            permission_mode: mapSessionModeToPermissionMode(sessionMode),
            enable_mcp: useSettingsStore.getState().enableMcp,
          });

          setSessionMeta({
            sessionId: session.session_id,
            stdinId: retryId,
            envFingerprint: envFingerprint(),
            snapshotContextWindowMode: retryContextWindowMode,
            spawnedModel: retryResolvedModel,
          });
          const tabId = useSessionStore.getState().selectedSessionId;
          if (tabId) useSessionStore.getState().registerStdinTab(retryId, tabId);
        } catch (retryErr) {
          console.error('[ClaudeDeck] Provider-switch auto-retry failed:', retryErr);
          // P0-5: Clean up the retry listeners on failure
          releaseStreamListener(retryId);
          setSessionStatus('error');
          addMessage({
            id: generateMessageId(),
            role: 'system', type: 'text',
            content: `重试失败: ${retryErr}`,
            timestamp: Date.now(),
          });
        }
      })();
      return true; // Exit the result case — retry flow takes over
    }
  }
  // 切换后的第一轮已成功完成：清除切换标记，否则之后任一轮出现签名错误时会重发切换时那条旧消息
  if (msg.subtype === 'success') {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
    if (meta?.modelSwitched || meta?.providerSwitched) {
      setSessionMeta({
        providerSwitched: false,
        providerSwitchPendingText: undefined,
        modelSwitched: false,
        modelSwitchPendingText: undefined,
      });
    }
  }
  return false;
}

/** Code 模式下 ExitPlanMode 导致 CLI 退出：静默 --resume 继续。已重启时返回 true。 */
function restartAfterExitPlanMode(ctx: StreamContext, msg: ResultMessage): boolean {
  const { tabId, isForeground } = ctx;
  const { exitPlanModeSeenRef, silentRestartRef, handleSubmitRef, setInputSync } = ctx.config;

  // Code mode: Auto-restart when ExitPlanMode caused CLI exit.
  // In stream-json mode, ExitPlanMode is treated as a permission denial,
  // causing the CLI to exit. Silently restart with --resume to continue.
  if (isForeground && exitPlanModeSeenRef.current && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
      && msg.subtype !== 'success') {
    exitPlanModeSeenRef.current = false;
    console.log('[ClaudeDeck] Code mode ExitPlanMode exit detected — auto-restarting with --resume');
    // Clean up dead process
    const oldStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
    if (oldStdinId) {
      useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
      bridge.killSession(oldStdinId).catch(() => {});
      releaseStreamListener(oldStdinId);
    }
    // Silently restart — no user message bubble
    silentRestartRef.current = true;
    setInputSync('Continue.');
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    requestAnimationFrame(() => handleSubmitRef.current());
    return true;
  }
  if (isForeground) exitPlanModeSeenRef.current = false;
  return false;
}

/** 收尾斜杠命令处理卡（输出、费用摘要），并在需要时补上 result 里的正文。 */
function completePendingCommand(ctx: StreamContext, msg: ResultMessage): void {
  const { tabId, agentDepth, addMessage } = ctx;

  // Mark pending processing card (CLI slash command) as completed
  const pendingCmdMsgId = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
  if (pendingCmdMsgId) {
    const resultOutput = typeof msg.result === 'string' ? msg.result : '';
    const pendingResultCmdData = (useChatStore.getState().getTab(tabId)?.messages ?? [])
      .find((m) => m.id === pendingCmdMsgId)?.commandData;
    // 同前台 assistant 分支：postTokens 兜底，理由一样
    const needsPostFallback2 = pendingResultCmdData?.command === '/compact'
      && pendingResultCmdData?.compactSummary?.postTokens === undefined;
    useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
      commandCompleted: true,
      commandData: {
        ...pendingResultCmdData,
        output: resultOutput,
        completedAt: Date.now(),
        ...(needsPostFallback2 ? {
          compactSummary: {
            ...pendingResultCmdData?.compactSummary,
            postTokens: getContextUsedTokens(useChatStore.getState().getTab(tabId)?.sessionMeta ?? {}),
          },
        } : {}),
      },
    });
    useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
  }

  // Extract result text for display (e.g., slash command output)
  let resultDisplayText = '';
  if (typeof msg.result === 'string' && msg.result) {
    resultDisplayText = msg.result;
  } else if (typeof msg.content === 'string' && msg.content) {
    resultDisplayText = msg.content;
  }

  // If we have cost metadata AND a pending slash command (e.g., /compact, /cost),
  // inject cost summary into the processing card instead of creating a separate message.
  if (msg.total_cost_usd != null && pendingCmdMsgId) {
    const cost = msg.total_cost_usd?.toFixed(4) ?? '—';
    const duration = msg.duration_ms
      ? `${(msg.duration_ms / 1000).toFixed(1)}s`
      : '—';
    const turns = msg.num_turns ?? '—';
    const input = msg.usage?.input_tokens
      ? msg.usage.input_tokens.toLocaleString()
      : '';
    const output = msg.usage?.output_tokens
      ? msg.usage.output_tokens.toLocaleString()
      : '';
    const cmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId);
    if (cmdMsg) {
      useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
        commandData: {
          ...cmdMsg.commandData,
          costSummary: { cost, duration, turns, input, output },
        },
      });
    }
    // If there's also explicit result text, still add it as a message
    if (!resultDisplayText) resultDisplayText = '';
  }

  // Only add result text if it wasn't already delivered via an
  // 'assistant' event (which is the normal case for stream-json output)
  // AND there's no pending command card (which already displays the output).
  if (resultDisplayText && !pendingCmdMsgId) {
    const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
    const isDuplicate = currentMessages.some(
      (m) => m.role === 'assistant' && m.type === 'text'
        && m.content === resultDisplayText,
    );
    if (!isDuplicate) {
      addMessage({
        id: msg.uuid || generateMessageId(),
        role: 'assistant',
        type: 'text',
        content: resultDisplayText,
        subAgentDepth: agentDepth,
        timestamp: Date.now(),
      });
    }
  }
}

/** 更新会话状态、用 result 校正 token 累计值、结束代理树并刷新会话列表。 */
function finalizeTurn(ctx: StreamContext, msg: ResultMessage): void {
  const { tabId, agentActions, setSessionStatus, setSessionMeta } = ctx;

  setSessionStatus(
    msg.subtype === 'success' ? 'completed' : 'error'
  );
  {
    // Correct cumulative totals for any drift between streaming
    // accumulation and the authoritative result values.
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    const resultInput = msg.usage?.input_tokens || 0;
    const resultOutput = msg.usage?.output_tokens || 0;
    const streamedInput = meta.inputTokens || 0;
    const streamedOutput = meta.outputTokens || 0;
    setSessionMeta({
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      turns: msg.num_turns,
      inputTokens: resultInput,
      outputTokens: resultOutput,
      totalInputTokens: (meta.totalInputTokens || 0) + (resultInput - streamedInput),
      totalOutputTokens: (meta.totalOutputTokens || 0) + (resultOutput - streamedOutput),
      turnStartTime: undefined,
      lastProgressAt: undefined,
    });
    // Persist final token state for F5 recovery
    const resultMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
    if (resultMeta) persistTokenState(tabId, resultMeta);
  }
  agentActions?.completeAll(
    msg.subtype === 'success' ? 'completed' : 'error'
  );
  useSessionStore.getState().fetchSessions();
  setTimeout(() => useSessionStore.getState().fetchSessions(), 1000);
}

/** 第 3 轮成功回复后，没有自定义标题的会话用 AI 生成标题。 */
function maybeGenerateTitle(ctx: StreamContext, msg: ResultMessage): void {
  const { tabId } = ctx;

  // --- AI Title Generation (TK-001): on 3rd successful turn, generate a title ---
  if (msg.subtype === 'success') {
    const sessionId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId || tabId;
    if (sessionId) {
      const customPreviews = useSessionStore.getState().customPreviews;
      if (!customPreviews[sessionId]) {
        const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
        const userTextMsgs = currentMessages.filter(
          (m) => m.role === 'user' && m.type === 'text' && m.content,
        );
        if (userTextMsgs.length >= 3) {
          const assistantTextMsgs = currentMessages.filter(
            (m) => m.role === 'assistant' && m.type === 'text' && m.content,
          );
          if (assistantTextMsgs.length >= 3) {
            const userMsg = userTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
            const assistantMsg = assistantTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
            const titleGenCwd = useSessionStore.getState().sessions.find((s) => s.id === tabId)?.project;
            bridge.generateSessionTitle(userMsg, assistantMsg, useProviderStore.getState().activeProviderId || undefined, titleGenCwd)
              .then((title) => {
                if (title) {
                  useSessionStore.getState().setCustomPreview(sessionId, title);
                }
              })
              .catch((e) => {
                if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
              });
          }
        }
      }
    }
  }
}

/** 上下文超过阈值时自动发送 /compact（每个会话最多一次）。已触发时返回 true。 */
function maybeAutoCompact(ctx: StreamContext, msg: ResultMessage): boolean {
  const { tabId, isForeground, addMessage, setSessionStatus, setSessionMeta, setActivityStatus } = ctx;
  const { autoCompactFiredRef } = ctx.config;

  // --- Auto-compact: threshold follows the declared context window.
  // Default 200K models compact at 160K; declared 1M models compact at 800K.
  // Fires at most once per session to avoid infinite loops.
  const compactMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  const resultContextTokens = getContextUsedTokens({
    inputTokens: msg.usage?.input_tokens,
    outputTokens: msg.usage?.output_tokens,
    contextInputTokens: compactMeta?.contextInputTokens,
    contextOutputTokens: compactMeta?.contextOutputTokens,
  });
  const compactStdinId = compactMeta?.stdinId;
  const compactCtx = resolveSessionContextWindow(
    { ...compactMeta, inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
    useSettingsStore.getState().selectedModel,
    useSettingsStore.getState().contextWindowMode,
  );
  const autoCompactThreshold = getAutoCompactThreshold(
    compactCtx.model,
    compactCtx.mode,
    useSettingsStore.getState().autoCompactThresholdTokens,
  );
  // autoCompactFiredRef 属于 InputBar 实例、不分标签页，自动压缩只对前台生效
  if (isForeground && resultContextTokens > autoCompactThreshold && !autoCompactFiredRef.current && compactStdinId && msg.subtype === 'success') {
    autoCompactFiredRef.current = true;
    console.log('[ClaudeDeck] Auto-compact triggered:', { contextTokens: resultContextTokens, threshold: autoCompactThreshold });
    const compactMsgId = generateMessageId();
    addMessage({
      id: compactMsgId,
      role: 'system',
      type: 'text',
      content: t('chat.autoCompacting'),
      commandType: 'processing',
      commandData: { command: '/compact', compactSummary: { preTokens: resultContextTokens } },
      commandStartTime: Date.now(),
      commandCompleted: false,
      timestamp: Date.now(),
    });
    // FI-4: Register pendingCommandMsgId so result handler can mark it completed
    setSessionMeta({ pendingCommandMsgId: compactMsgId });
    setSessionStatus('running');
    setActivityStatus({ phase: 'thinking' });
    bridge.sendStdin(compactStdinId, '/compact').catch((err) => {
      console.error('[ClaudeDeck] Auto-compact failed:', err);
    });
    // FI-4: Timeout fallback — if compact doesn't complete within 90s, auto-complete
    setTimeout(() => {
      const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
      if (meta.pendingCommandMsgId === compactMsgId) {
        useChatStore.getState().updateMessage(tabId, compactMsgId, {
          commandCompleted: true,
          commandData: {
            ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === compactMsgId)?.commandData,
            output: 'Compact timed out',
            completedAt: Date.now(),
          },
        });
        useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        if (useChatStore.getState().getTab(tabId)?.sessionStatus === 'running') {
          useChatStore.getState().setSessionStatus(tabId, 'idle');
        }
      }
    }, 15_000); // Bug C fix (#27): reduced from 90s to 15s
    return true; // Skip pending message flush — compact takes priority
  }
  return false;
}

/** 排队的消息按 FIFO 每轮发送一条。 */
function sendNextPendingMessage(ctx: StreamContext): void {
  const { tabId, agentActions, setSessionStatus, setSessionMeta, setActivityStatus } = ctx;

  // FIFO drain: dequeue ONE pending message and send it (#142/#70).
  // When this turn completes, the next result event will dequeue the next one.
  // Previously all pending messages were joined and sent at once, which could
  // overwhelm the CLI. Sequential turn-by-turn processing is safer.
  {
    const drainTab = useChatStore.getState().getTab(tabId);
    const next = useChatStore.getState().shiftPendingMessage(tabId);
    const flushStdinId = drainTab?.sessionMeta.stdinId;
    if (next && flushStdinId) {
      const nextMsg = next.text;
      // 气泡在真正发送时才插入，保证排在上一轮回复之后
      if (next.message) ctx.addMessage({ ...next.message, timestamp: Date.now() });
      const nextTurnStartedAt = Date.now();
      setSessionStatus('running');
      setSessionMeta({
        turnStartTime: nextTurnStartedAt,
        lastProgressAt: nextTurnStartedAt,
        inputTokens: 0,
        outputTokens: 0,
      });
      setActivityStatus({ phase: 'thinking' });
      agentActions?.clearAgents();
      agentActions?.upsertAgent({
        id: 'main',
        parentId: null,
        description: nextMsg.slice(0, 100),
        phase: 'spawning',
        startTime: Date.now(),
        isMain: true,
      });
      bridge.sendStdin(flushStdinId, nextMsg).catch((err) => {
        console.error('[TC] Failed to send pending message:', err);
        // Restore failed message + remaining queue to input draft
        const remaining = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
        const allFailed = [nextMsg, ...remaining.map((p) => p.text)];
        const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
        const failedText = allFailed.join('\n\n');
        useChatStore.getState().setInputDraft(tabId, draft ? `${draft}\n\n${failedText}` : failedText);
        useChatStore.getState().clearPendingMessages(tabId);
        setSessionStatus('error');
      });
    }
  }
}
