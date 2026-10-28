// 权限请求：ExitPlanMode → 计划审阅卡，AskUserQuestion → 问题卡，其余 → 权限卡。
import { useChatStore, generateMessageId } from '../../../stores/chatStore';
import { getEffectiveMode } from '../../../stores/settingsStore';
import { bridge } from '../../../lib/tauri-bridge';
import { type PermissionRequestMessage } from '../../../lib/stream-message';

export function handlePermissionRequest(msg: PermissionRequestMessage, tabId: string, msgStdinId: string | undefined): void {

  // ExitPlanMode: only show PlanReviewCard in Plan mode.
  // In other modes, auto-approve so the CLI continues without blocking.
  if (msg.tool_name === 'ExitPlanMode') {
    const tabState = useChatStore.getState().getTab(tabId);
    if (getEffectiveMode(tabState?.sessionMeta) !== 'plan') {
      // Auto-approve: CLI doesn't need user confirmation outside Plan mode
      const stdinId = msgStdinId || tabState?.sessionMeta.stdinId;
      if (stdinId) {
        bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
      }
      return;
    }
    const chatStore = useChatStore.getState();
    const messages = tabState?.messages ?? [];
    const permData = {
      requestId: msg.request_id,
      toolName: msg.tool_name,
      input: msg.input,
      description: msg.description,
      toolUseId: msg.tool_use_id,
    };
    const planReview = messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
    if (planReview) {
      chatStore.updateMessage(tabId, 'plan_review_current', { permissionData: permData });
    } else {
      // PlanReviewCard not yet created — create one with permission data
      let planContent = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].type === 'text' && messages[i].content) {
          planContent = messages[i].content;
          break;
        }
      }
      chatStore.addMessage(tabId, {
        id: 'plan_review_current',
        role: 'assistant',
        type: 'plan_review',
        content: planContent,
        planContent: planContent,
        resolved: false,
        permissionData: permData,
        timestamp: Date.now(),
      });
      chatStore.awaitUser(tabId);
    }
    return;
  }

  // AskUserQuestion: create QuestionCard instead of PermissionCard.
  // User answers are sent back via respondPermission(updatedInput) — NOT sendStdin.
  if (msg.tool_name === 'AskUserQuestion') {
    const chatStore = useChatStore.getState();
    const messages = chatStore.getTab(tabId)?.messages ?? [];
    const questionId = msg.tool_use_id || 'ask_question_current';
    // Search by exact ID first, then fall back to any unresolved AskUserQuestion.
    // This handles the race condition where the assistant message arrives first
    // with block.id (e.g. "toolu_01abc") and the control_request arrives later
    // with a different or missing tool_use_id.
    const existing = messages.find((m) => m.id === questionId && m.type === 'question')
      || messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
    if (existing) {
      // Patch permissionData so QuestionCard uses respondPermission (SDK path)
      // instead of sendStdin (legacy path). Always update — even if permissionData
      // exists — because a new control_request supersedes a stale one.
      chatStore.updateMessage(tabId, existing.id, {
        permissionData: {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          toolUseId: msg.tool_use_id,
        },
        toolInput: msg.input,
      });
      return;
    }
    const questions = msg.input?.questions;
    chatStore.addMessage(tabId, {
      id: questionId,
      role: 'assistant',
      type: 'question',
      content: '',
      toolName: 'AskUserQuestion',
      toolInput: msg.input,
      questions: Array.isArray(questions) ? questions : [],
      resolved: false,
      timestamp: Date.now(),
      // Attach permission data so QuestionCard uses respondPermission instead of sendStdin
      permissionData: {
        requestId: msg.request_id,
        toolName: msg.tool_name,
        input: msg.input,
        toolUseId: msg.tool_use_id,
      },
    });
    chatStore.awaitUser(tabId);
    return;
  }

  // Dedup: skip if we already have a non-failed PermissionCard for this request_id
  const chatStore = useChatStore.getState();
  const messages = chatStore.getTab(tabId)?.messages ?? [];
  const existingPerm = messages.find(
    (m) => m.type === 'permission'
      && m.permissionData?.requestId === msg.request_id
      && m.interactionState !== 'failed'
  );
  if (existingPerm) {
    return;
  }
  chatStore.addMessage(tabId, {
    id: generateMessageId(),
    role: 'assistant',
    type: 'permission',
    content: msg.description || `${msg.tool_name} wants to execute`,
    permissionTool: msg.tool_name,
    permissionDescription: msg.description || '',
    timestamp: Date.now(),
    interactionState: 'pending',
    permissionData: {
      requestId: msg.request_id,
      toolName: msg.tool_name,
      input: msg.input,
      description: msg.description,
      toolUseId: msg.tool_use_id,
    },
  });
  chatStore.awaitUser(tabId);
  return;
}
