// assistant 消息处理：正文去重、流式状态清理、并行工具、提问卡、计划模式、斜杠命令卡收尾。
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { handleAssistantMessage } from '../stream/handlers/assistant';
import type { AssistantMessage, ContentBlock } from '../../lib/stream-message';
import { makeContext, tabOf } from './stream-test-utils';

const TAB = 'stream_assistant_test_tab';

const assistant = (content: ContentBlock[], uuid?: string): AssistantMessage => ({
  type: 'assistant', uuid, message: { content },
});
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({
  type: 'tool_use', id, name, input,
});
const setPartial = (partialText: string, partialThinking: string) => {
  const tab = tabOf(TAB);
  const tabs = new Map(useChatStore.getState().tabs);
  tabs.set(TAB, { ...tab, partialText, partialThinking, isStreaming: true });
  useChatStore.setState({ tabs });
};
const messages = () => tabOf(TAB).messages;

describe('handleAssistantMessage', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext(TAB);
    useChatStore.getState().setSessionMeta(TAB, { snapshotMode: 'code' });
  });

  describe('正文与流式状态', () => {
    it('同一条消息重复送达时按 uuid + 块序号去重', () => {
      const msg = assistant([{ type: 'text', text: '你好' }], 'a1');
      handleAssistantMessage(ctx, msg);
      handleAssistantMessage(ctx, assistant([{ type: 'text', text: '你好，世界' }], 'a1'));
      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toMatchObject({ id: 'a1_text_0', content: '你好，世界' });
    });

    it('带正文的消息清掉流式正文和思考', () => {
      setPartial('流式中', '思考中');
      handleAssistantMessage(ctx, assistant([{ type: 'text', text: '完整正文' }], 'a1'));
      expect(tabOf(TAB)).toMatchObject({ partialText: '', partialThinking: '', isStreaming: false });
      expect(tabOf(TAB).activityStatus.phase).toBe('writing');
    });

    it('只有思考块的中间消息不能清掉正在流式输出的正文', () => {
      setPartial('正在输出的正文', '思考中');
      handleAssistantMessage(ctx, assistant([{ type: 'thinking', thinking: '想好了' }], 'a1'));
      expect(tabOf(TAB).partialText).toBe('正在输出的正文');
      expect(tabOf(TAB).partialThinking).toBe('');
      expect(messages()[0]).toMatchObject({ id: 'a1_thinking_0', type: 'thinking', content: '想好了' });
    });
  });

  describe('工具调用', () => {
    it('并行调用时累计运行中的工具 ID，重复送达不重复记', () => {
      handleAssistantMessage(ctx, assistant([toolUse('t1', 'Read')]));
      handleAssistantMessage(ctx, assistant([toolUse('t2', 'Grep')]));
      handleAssistantMessage(ctx, assistant([toolUse('t2', 'Grep')]));
      expect(tabOf(TAB).activityStatus).toMatchObject({ phase: 'tool', toolName: 'Grep', runningToolIds: ['t1', 't2'] });
      expect(messages().map((m) => m.id)).toEqual(['t1', 't2']);
    });

    it('TodoWrite 生成待办卡', () => {
      const todos = [{ content: '写测试', status: 'in_progress' }];
      handleAssistantMessage(ctx, assistant([toolUse('t1', 'TodoWrite', { todos })]));
      expect(messages()[0]).toMatchObject({ type: 'todo', todoItems: todos });
    });
  });

  describe('AskUserQuestion', () => {
    const questions = [{ question: '选哪个？', options: [{ label: 'A' }] }];

    it('生成提问卡、进入等待，并跳过同一条消息里的正文', () => {
      handleAssistantMessage(ctx, assistant([
        { type: 'text', text: '问题描述（与提问卡重复）' },
        toolUse('q1', 'AskUserQuestion', { questions }),
      ], 'a1'));
      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toMatchObject({ id: 'q1', type: 'question', questions, resolved: false });
      expect(tabOf(TAB).activityStatus.phase).toBe('awaiting');
    });

    it('权限请求已建过未回答的提问卡时不再重复创建', () => {
      ctx.addMessage({
        id: 'ask_question_current', role: 'assistant', type: 'question', content: '',
        toolName: 'AskUserQuestion', questions, resolved: false, timestamp: 1,
      });
      handleAssistantMessage(ctx, assistant([toolUse('q1', 'AskUserQuestion', { questions })]));
      expect(messages().filter((m) => m.type === 'question')).toHaveLength(1);
    });
  });

  describe('计划模式工具', () => {
    it('代码模式下 EnterPlanMode/ExitPlanMode 不显示卡片，前台记下 ExitPlanMode', () => {
      ctx = { ...ctx, isForeground: true };
      handleAssistantMessage(ctx, assistant([toolUse('p0', 'EnterPlanMode'), toolUse('p1', 'ExitPlanMode')]));
      expect(messages()).toHaveLength(0);
      expect(ctx.config.exitPlanModeSeenRef.current).toBe(true);
    });

    it('后台标签页不记录 ExitPlanMode（静默重启只支持前台）', () => {
      handleAssistantMessage(ctx, assistant([toolUse('p1', 'ExitPlanMode')]));
      expect(ctx.config.exitPlanModeSeenRef.current).toBe(false);
    });

    it('计划模式下 ExitPlanMode 生成计划审阅卡，内容取最近一次 Write', () => {
      useChatStore.getState().setSessionMeta(TAB, { snapshotMode: 'plan' });
      ctx.addMessage({
        id: 'w1', role: 'assistant', type: 'tool_use', content: '', toolName: 'Write',
        toolInput: { content: '# 计划' }, timestamp: 1,
      });
      handleAssistantMessage(ctx, assistant([toolUse('p1', 'ExitPlanMode')]));
      const review = messages().find((m) => m.type === 'plan_review');
      expect(review).toMatchObject({ planContent: '# 计划', resolved: false });
      expect(tabOf(TAB).activityStatus.phase).toBe('awaiting');
    });
  });

  describe('斜杠命令处理卡', () => {
    const commandCard = (commandData: ChatMessage['commandData']): ChatMessage => ({
      id: 'cmd', role: 'system', type: 'text', content: '', commandData, timestamp: 1,
    });

    it('收到回复即标记完成并清掉待完成标记', () => {
      ctx.addMessage(commandCard({ command: '/cost' }));
      useChatStore.getState().setSessionMeta(TAB, { pendingCommandMsgId: 'cmd' });
      handleAssistantMessage(ctx, assistant([{ type: 'text', text: '花费 $0.1' }]));
      const card = messages().find((m) => m.id === 'cmd');
      expect(card?.commandCompleted).toBe(true);
      expect(typeof card?.commandData?.completedAt).toBe('number');
      expect(tabOf(TAB).sessionMeta.pendingCommandMsgId).toBeUndefined();
    });

    it('/compact 缺少 postTokens 时用当前上下文占用兜底', () => {
      ctx.addMessage(commandCard({ command: '/compact', compactSummary: { preTokens: 5000 } }));
      useChatStore.getState().setSessionMeta(TAB, {
        pendingCommandMsgId: 'cmd', contextInputTokens: 1200, contextOutputTokens: 0,
      });
      handleAssistantMessage(ctx, assistant([{ type: 'text', text: '已压缩' }]));
      const summary = messages().find((m) => m.id === 'cmd')?.commandData?.compactSummary;
      expect(summary?.preTokens).toBe(5000);
      expect(summary?.postTokens).toBe(1200);
    });
  });
});
