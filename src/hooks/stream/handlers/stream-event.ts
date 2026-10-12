// stream_event：--include-partial-messages 的实时增量（正文/思考缓冲、子代理登记、token 计数）。
import { useChatStore } from '../../../stores/chatStore';
import { getEffectiveMode } from '../../../stores/settingsStore';
import { getContextOutputTokens } from '../../../lib/context-usage';
import { contextSnapshot, persistTokenState } from '../token-state';
import { bufferStreamDelta } from '../buffer';
import { type StreamEventMessage } from '../../../lib/stream-message';
import { type StreamContext } from '../context';

export function handleStreamEvent(ctx: StreamContext, msg: StreamEventMessage): void {
  const { tabId, msgStdinId, agentActions, agentId, addMessage, setSessionMeta, setActivityStatus } = ctx;

  const evt = msg.event;
  if (!evt) return;

  // Diagnostic: log tool_use starts for debugging plan mode flow
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    console.log('[ClaudeDeck:stream] tool_use start:', evt.content_block.name);
  }

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    const text = evt.delta.text || '';
    if (text && msgStdinId) {
      // Buffer text and flush via rAF to avoid excessive re-renders
      // TK-329: per-stdinId buffer prevents cross-session contamination
      bufferStreamDelta(msgStdinId, 'text', text);
      agentActions?.updatePhase(agentId, 'writing');
    }
  } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
    const thinkingText = evt.delta.thinking || '';
    if (thinkingText && msgStdinId) {
      bufferStreamDelta(msgStdinId, 'thinking', thinkingText);
      agentActions?.updatePhase(agentId, 'thinking');
    } else {
      setActivityStatus({ phase: 'thinking' });
      agentActions?.updatePhase(agentId, 'thinking');
    }
  }

  // Early agent creation: register sub-agent as soon as Agent/Task tool_use
  // starts streaming, so subsequent events resolve to the correct agent.
  if (evt.type === 'content_block_start'
      && evt.content_block?.type === 'tool_use'
      && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
    agentActions?.upsertAgent({
      id: evt.content_block.id || `task_${Date.now()}`,
      parentId: agentId,
      description: '',
      phase: 'spawning',
      startTime: Date.now(),
      isMain: false,
    });
  }
  // Agent Team tools (TaskCreate, SendMessage): register as visible agents
  // so the agent panel shows team activity. These run in separate CLI processes
  // so we won't get real-time progress, but visibility is the goal.
  if (evt.type === 'content_block_start'
      && evt.content_block?.type === 'tool_use'
      && (evt.content_block?.name === 'TaskCreate' || evt.content_block?.name === 'SendMessage')) {
    agentActions?.upsertAgent({
      id: evt.content_block.id || `team_${Date.now()}`,
      parentId: agentId,
      description: '',
      phase: 'tool',
      startTime: Date.now(),
      isMain: false,
    });
  }
  // Early detection: create plan_review card ONLY in explicit Plan mode.
  // In Code mode the CLI handles ExitPlanMode natively.
  // In Bypass mode the Rust backend auto-approves — no UI card needed.
  if (evt.type === 'content_block_start'
      && evt.content_block?.type === 'tool_use'
      && evt.content_block?.name === 'ExitPlanMode'
      && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
    const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

    // Guard: if plan_review_current already exists and was resolved,
    // this is a replay after plan approval — don't create a new card.
    const existingReview = currentMessages.find((m) => m.id === 'plan_review_current');
    if (!existingReview || !existingReview.resolved) {
      let planContent = '';
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const m = currentMessages[i];
        if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
          planContent = m.toolInput.content;
          break;
        }
      }

      addMessage({
        id: 'plan_review_current',
        role: 'assistant',
        type: 'plan_review',
        content: planContent,
        planContent: planContent,
        resolved: false,
        timestamp: Date.now(),
      });
      setActivityStatus({ phase: 'awaiting' });
    }
  }

  // Track input tokens from message_start (per-turn + cumulative total)
  if (evt.type === 'message_start' && evt.message?.usage) {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    const delta = evt.message.usage.input_tokens || 0;
    const snapshot = contextSnapshot(evt.message.usage);
    setSessionMeta({
      inputTokens: (meta.inputTokens || 0) + delta,
      totalInputTokens: (meta.totalInputTokens || 0) + delta,
      ...(snapshot ? { ...snapshot, contextOutputTokens: 0 } : {}),
    });
    const updatedMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
    if (updatedMeta) persistTokenState(tabId, updatedMeta);
  }

  // Track output tokens from message_delta (per-turn + cumulative total)
  if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
    const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
    const delta = evt.usage.output_tokens;
    setSessionMeta({
      outputTokens: (meta.outputTokens || 0) + delta,
      totalOutputTokens: (meta.totalOutputTokens || 0) + delta,
      contextOutputTokens: getContextOutputTokens(evt.usage),
    });
    const updatedMeta2 = useChatStore.getState().getTab(tabId)?.sessionMeta;
    if (updatedMeta2) persistTokenState(tabId, updatedMeta2);
  }
}
