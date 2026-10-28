// assistant 消息：正文、工具调用、思考块写入聊天记录，并收尾待完成的斜杠命令卡。
import { useChatStore, generateMessageId } from '../../../stores/chatStore';
import { getEffectiveMode } from '../../../stores/settingsStore';
import { getContextUsedTokens } from '../../../lib/context-usage';
import { type AssistantMessage } from '../../../lib/stream-message';
import { type StreamContext } from '../context';

export function handleAssistantMessage(ctx: StreamContext, msg: AssistantMessage): void {
  const { tabId, isForeground, agentActions, agentId, agentDepth, addMessage, setActivityStatus, clearPartial } = ctx;
  const { exitPlanModeSeenRef } = ctx.config;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  // With --include-partial-messages, intermediate assistant messages arrive
  // frequently. We must NOT aggressively wipe streaming text state when the
  // message only contains a thinking block (no text block yet).
  const hasTextBlock = content.some((b) => b.type === 'text' && b.text);

  if (hasTextBlock) {
    // Full clear — the text block supersedes streaming partial text
    clearPartial();
  } else {
    // Only clear thinking partial — preserve streaming text
    {
      const td = useChatStore.getState().getTab(tabId);
      if (td?.partialThinking) {
        const nt = new Map(useChatStore.getState().tabs);
        nt.set(tabId, { ...td, partialThinking: '' });
        useChatStore.setState({ tabs: nt });
      }
    }
  }

  // If there's a pending slash command processing card, mark it as
  // completed now — the assistant response means the CLI has responded.
  // Some commands (e.g. /compact) may not emit a 'result' event.
  const pendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
  if (pendingCmd) {
    const pendingCmdData = (useChatStore.getState().getTab(tabId)?.messages ?? [])
      .find((m) => m.id === pendingCmd)?.commandData;
    // /compact 的 compact_boundary 事件里 postTokens 时有时无（同 5h/7d 用量数据
    // 一样，是 CLI 那边不稳定的附加字段）；这里兜底用当前已经算出来的真实上下文
    // 占用量补上，不然只有 preTokens、没有对比数字，看起来像“压缩完成了但读不到
    // 压缩率”。
    const needsPostFallback = pendingCmdData?.command === '/compact'
      && pendingCmdData?.compactSummary?.postTokens === undefined;
    useChatStore.getState().updateMessage(tabId, pendingCmd, {
      commandCompleted: true,
      commandData: {
        ...pendingCmdData,
        completedAt: Date.now(),
        ...(needsPostFallback ? {
          compactSummary: {
            ...pendingCmdData?.compactSummary,
            postTokens: getContextUsedTokens(useChatStore.getState().getTab(tabId)?.sessionMeta ?? {}),
          },
        } : {}),
      },
    });
    useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
  }

  // If this message contains AskUserQuestion, skip text blocks —
  // the interactive question UI makes them redundant and avoids
  // showing raw question descriptions alongside the rich UI.
  const hasAskUserQuestion = content.some(
    (b) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
  );

  for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
    const block = content[blockIdx];
    if (block.type === 'text') {
      if (hasAskUserQuestion) continue;
      setActivityStatus({ phase: 'writing' });
      agentActions?.updatePhase(agentId, 'writing');
      // Use msg.uuid + block index as stable ID so re-delivered
      // messages de-duplicate correctly in the store.
      const textId = msg.uuid ? `${msg.uuid}_text_${blockIdx}` : generateMessageId();
      addMessage({
        id: textId,
        role: 'assistant',
        type: 'text',
        content: block.text,
        subAgentDepth: agentDepth,
        timestamp: Date.now(),
      });
    } else if (block.type === 'tool_use') {
      // Code mode: EnterPlanMode/ExitPlanMode are transparent — CLI handles internally.
      // Don't show tool cards; track ExitPlanMode for auto-restart if CLI exits.
      if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
          && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
        // 静默重启只支持前台标签页，后台不记录
        if (block.name === 'ExitPlanMode' && isForeground) exitPlanModeSeenRef.current = true;
        continue;
      }
      {
        // 记下还在运行的工具：并行调用时等全部返回结果才算这一步结束
        const prev = useChatStore.getState().getTab(tabId)?.activityStatus;
        const running = prev?.phase === 'tool' ? (prev.runningToolIds ?? []) : [];
        setActivityStatus({
          phase: 'tool',
          toolName: block.name,
          toolInput: block.input,
          runningToolIds: block.id && !running.includes(block.id) ? [...running, block.id] : running,
        });
      }
      if (block.name === 'Task' || block.name === 'Agent') {
        agentActions?.upsertAgent({
          id: block.id || generateMessageId(),
          parentId: agentId,
          description: block.input?.description || block.input?.prompt || '',
          phase: 'spawning',
          startTime: Date.now(),
          isMain: false,
        });
      } else if (block.name === 'TaskCreate' || block.name === 'SendMessage') {
        // Agent Team tasks/messages: register as visible agents in the tree.
        // These run in separate CLI processes so we won't get progress events,
        // but showing them makes the team activity visible in the agent panel.
        agentActions?.upsertAgent({
          id: block.id || `team_${Date.now()}`,
          parentId: agentId,
          description: block.input?.subject || block.input?.description || block.input?.recipient || '',
          phase: 'tool',
          startTime: Date.now(),
          isMain: false,
        });
      } else {
        agentActions?.updatePhase(agentId, 'tool', block.name);
      }

      if (block.name === 'AskUserQuestion') {
        // Use a stable sentinel ID so re-delivered blocks de-duplicate
        // instead of creating duplicate question cards (TK-103).
        const questionId = block.id || 'ask_question_current';

        // Guard: skip if question already exists (resolved or not).
        // Search by exact ID first, then by any AskUserQuestion card —
        // the control_request handler may have already created one with
        // a different ID (e.g. 'ask_question_current' vs 'toolu_01abc').
        const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
        const existingQuestion = currentMessages.find(
          (m) => m.id === questionId && m.type === 'question',
        ) || currentMessages.find(
          (m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion',
        );
        if (existingQuestion) {
          // Already exists — just ensure awaiting state if unresolved
          if (!existingQuestion.resolved) {
            useChatStore.getState().awaitUser(tabId);
          }
          break;
        }

        const questions = block.input?.questions;
        addMessage({
          id: questionId,
          role: 'assistant',
          type: 'question',
          content: '',
          toolName: block.name,
          toolInput: block.input,
          questions: Array.isArray(questions) ? questions : [],
          resolved: false,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });
        // Mark as awaiting user input (consistent with ExitPlanMode)
        useChatStore.getState().awaitUser(tabId);
      } else if (block.name === 'TodoWrite' && block.input?.todos) {
        addMessage({
          id: block.id || generateMessageId(),
          role: 'assistant',
          type: 'todo',
          content: '',
          toolName: block.name,
          toolInput: block.input,
          todoItems: block.input.todos,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });
      } else if (block.name === 'ExitPlanMode') {
        // Show ExitPlanMode as a collapsible tool_use (like other tools)
        addMessage({
          id: block.id || generateMessageId(),
          role: 'assistant',
          type: 'tool_use',
          content: '',
          toolName: block.name,
          toolInput: block.input,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });

        // Only create plan_review card in Plan mode.
        // In Code mode the CLI handles ExitPlanMode natively.
        // In Bypass mode the Rust backend auto-approves — no UI card needed.
        if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

          // Guard: skip if already approved (replay)
          const toolAlreadyExisted = block.id && currentMessages.some(
            (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
          );
          const existingReview = currentMessages.find(
            (m) => m.type === 'plan_review' && m.resolved,
          );
          if (!(toolAlreadyExisted && existingReview)) {
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
            useChatStore.getState().awaitUser(tabId);
          }
        }
      } else {
        addMessage({
          id: block.id || generateMessageId(),
          role: 'assistant',
          type: 'tool_use',
          content: '',
          toolName: block.name,
          toolInput: block.input,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });

      }
    } else if (block.type === 'thinking') {
      // Complete thinking block arrived — clear streaming thinking text.
      // DON'T override activityStatus here: if text is currently streaming,
      // the phase should remain 'writing'. The streaming events (thinking_delta,
      // text_delta) are the source of truth for activity phase.
      {
      const td = useChatStore.getState().getTab(tabId);
      if (td?.partialThinking) {
        const nt = new Map(useChatStore.getState().tabs);
        nt.set(tabId, { ...td, partialThinking: '' });
        useChatStore.setState({ tabs: nt });
      }
    }
      agentActions?.updatePhase(agentId, 'thinking');
      addMessage({
        id: msg.uuid ? `${msg.uuid}_thinking_${blockIdx}` : generateMessageId(),
        role: 'assistant',
        type: 'thinking',
        content: block.thinking || '',
        subAgentDepth: agentDepth,
        timestamp: Date.now(),
      });
    }
  }

  // NOTE: No save/restore hack needed here. addMessage no longer clears
  // partialText/isStreaming as a side effect (TK-322 fix), so intermediate
  // assistant messages with only thinking/tool_use blocks won't wipe
  // streaming text state.
}
