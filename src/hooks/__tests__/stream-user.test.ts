// user 消息处理：回溯 checkpoint、运行中消息的回显、工具结果回填、并行工具的状态。
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { createCompactNotice } from '../../lib/compact-notice';
import { handleUserMessage } from '../stream/handlers/user';
import type { UserMessage } from '../../lib/stream-message';
import { makeContext, tabOf } from './stream-test-utils';

const TAB = 'stream_user_test_tab';

const userBubble = (id: string, content: string): ChatMessage => ({
  id, role: 'user', type: 'text', content, timestamp: 1,
});
const toolCard = (id: string, toolName = 'Read'): ChatMessage => ({
  id, role: 'assistant', type: 'tool_use', content: '', toolName, timestamp: 2,
});
const findMsg = (id: string) => tabOf(TAB).messages.find((m) => m.id === id);

describe('handleUserMessage', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext(TAB);
  });

  describe('回溯 checkpoint', () => {
    it('把 UUID 记到最近一条用户消息上', () => {
      ctx.addMessage(userBubble('u1', '第一条'));
      ctx.addMessage(userBubble('u2', '第二条'));
      handleUserMessage(ctx, { type: 'user', uuid: 'cp-1', message: { content: '第二条' } });
      expect(findMsg('u2')?.checkpointUuid).toBe('cp-1');
      expect(findMsg('u1')?.checkpointUuid).toBeUndefined();
    });

    it('工具结果的 UUID 不能当 checkpoint（与 file-history-snapshot 对不上）', () => {
      ctx.addMessage(userBubble('u1', '改文件'));
      handleUserMessage(ctx, {
        type: 'user',
        uuid: 'tool-result-uuid',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      });
      expect(findMsg('u1')?.checkpointUuid).toBeUndefined();
    });

    it('压缩摘要不算用户输入：写进压缩提示，不改 checkpoint', () => {
      ctx.addMessage(userBubble('u1', '继续'));
      ctx.addMessage(createCompactNotice('notice', 3, { trigger: 'auto', preTokens: 100 }));
      handleUserMessage(ctx, {
        type: 'user',
        uuid: 'summary-uuid',
        isCompactSummary: true,
        message: { content: [{ type: 'text', text: 'This session is being continued' }] },
      });
      expect(findMsg('notice')?.commandData).toMatchObject({ preTokens: 100, summary: 'This session is being continued' });
      expect(findMsg('u1')?.checkpointUuid).toBeUndefined();
    });
  });

  describe('运行中发出的消息', () => {
    it('CLI 回显后才插入气泡，checkpoint 落在这条气泡上', () => {
      ctx.addMessage(userBubble('u1', '第一轮'));
      useChatStore.getState().addPendingMessage(TAB, {
        text: '插队的消息', message: userBubble('queued', '插队的消息'), sent: true,
      });
      useChatStore.getState().setSessionMeta(TAB, { awaitingQueuedTurn: true });

      handleUserMessage(ctx, { type: 'user', uuid: 'cp-q', isReplay: true, message: { content: '插队的消息' } });

      const ids = tabOf(TAB).messages.map((m) => m.id);
      expect(ids).toEqual(['u1', 'queued']);
      expect(findMsg('queued')?.checkpointUuid).toBe('cp-q');
      expect(findMsg('u1')?.checkpointUuid).toBeUndefined();
      expect(tabOf(TAB).pendingUserMessages).toHaveLength(0);
      expect(tabOf(TAB).sessionMeta.awaitingQueuedTurn).toBeUndefined();
    });

    it('回显对不上排队消息时不插入气泡', () => {
      useChatStore.getState().addPendingMessage(TAB, {
        text: '排队中', message: userBubble('queued', '排队中'), sent: true,
      });
      handleUserMessage(ctx, { type: 'user', isReplay: true, message: { content: '别的内容' } });
      expect(findMsg('queued')).toBeUndefined();
      expect(tabOf(TAB).pendingUserMessages).toHaveLength(1);
    });
  });

  describe('工具结果', () => {
    const resultOf = (ids: string[]): UserMessage => ({
      type: 'user',
      message: { content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: `结果 ${id}` })) },
    });

    it('回填到对应的工具卡', () => {
      ctx.addMessage(toolCard('t1'));
      handleUserMessage(ctx, resultOf(['t1']));
      expect(findMsg('t1')?.toolResultContent).toBe('结果 t1');
      expect(findMsg('t1')?.toolResultError).toBeUndefined();
    });

    it('回合被中断、执行失败：工具卡记下没有成功完成的原因（文案取自真实 CLI 输出）', () => {
      ctx.addMessage(toolCard('t1', 'Bash'));
      ctx.addMessage(toolCard('t2', 'Bash'));
      handleUserMessage(ctx, {
        type: 'user',
        message: { content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: true,
            content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. Correction to the text above: this call was stopped while running, not refused before it ran." },
          { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 1' },
        ] },
      });
      expect(findMsg('t1')?.toolResultError).toBe('interrupted');
      expect(findMsg('t2')?.toolResultError).toBe('failed');
    });

    it('content 为空时用 tool_use_result.stdout 回填', () => {
      ctx.addMessage(toolCard('t1', 'Bash'));
      handleUserMessage(ctx, {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        tool_use_result: { stdout: 'hello' },
      });
      expect(findMsg('t1')?.toolResultContent).toBe('hello');
    });

    it('并行工具：部分返回时仍在运行，全部返回后回到思考', () => {
      ctx.setActivityStatus({ phase: 'tool', toolName: 'Read', runningToolIds: ['t1', 't2'] });
      handleUserMessage(ctx, resultOf(['t1']));
      expect(tabOf(TAB).activityStatus).toMatchObject({ phase: 'tool', runningToolIds: ['t2'] });
      handleUserMessage(ctx, resultOf(['t2']));
      expect(tabOf(TAB).activityStatus).toEqual({ phase: 'thinking' });
    });

    it('等待确认期间其他工具返回：只更新等待结束后要恢复的状态', () => {
      ctx.setActivityStatus({
        phase: 'awaiting',
        resumeStatus: { phase: 'tool', toolName: 'Bash', runningToolIds: ['t1', 't2'] },
      });
      handleUserMessage(ctx, resultOf(['t1']));
      const status = tabOf(TAB).activityStatus;
      expect(status.phase).toBe('awaiting');
      expect(status.resumeStatus?.runningToolIds).toEqual(['t2']);
      handleUserMessage(ctx, resultOf(['t2']));
      expect(tabOf(TAB).activityStatus.resumeStatus).toEqual({ phase: 'thinking' });
    });
  });
});
