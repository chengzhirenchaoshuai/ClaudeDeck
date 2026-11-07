// CLI 进程退出：保留流式正文、无回复时提示错误、交互卡标记失败、排队消息退回输入框、清理映射与监听器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useBackgroundTaskStore } from '../../stores/backgroundTaskStore';
import { handleProcessExit } from '../stream/handlers/process-exit';
import { makeConfig, makeContext, stubBrowserGlobals, tabOf } from './stream-test-utils';

const TAB = 'stream_exit_test_tab';
const STDIN = 'stdin_exit_test';

const exit = () => ({ type: 'process_exit' as const, __stdinId: STDIN });
const systemTexts = () => tabOf(TAB).messages.filter((m) => m.role === 'system').map((m) => m.content);

describe('handleProcessExit', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    stubBrowserGlobals();
    useSessionStore.setState({ fetchSessions: vi.fn().mockResolvedValue(undefined) } as never);
    ctx = makeContext(TAB, { msgStdinId: STDIN });
    useSessionStore.getState().registerStdinTab(STDIN, TAB);
    useChatStore.getState().setSessionMeta(TAB, { stdinId: STDIN, turnStartTime: 1000 });
    ctx.setSessionStatus('running');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('退出时的回复检查', () => {
    it('本轮没有任何回复：提示 CLI 意外退出', () => {
      handleProcessExit(ctx, exit());
      expect(systemTexts().some((c) => c.includes('CLI'))).toBe(true);
    });

    it('上一轮的回复不能掩盖本轮失败', () => {
      ctx.addMessage({ id: 'old', role: 'assistant', type: 'text', content: '上一轮', timestamp: 500 });
      handleProcessExit(ctx, exit());
      expect(systemTexts()).toHaveLength(1);
    });

    it('前台会话优先显示最近一行 stderr', () => {
      const config = makeConfig();
      config.lastStderrRef.current = 'Invalid API key';
      ctx = { ...ctx, isForeground: true, config };
      handleProcessExit(ctx, exit());
      expect(systemTexts().some((c) => c.includes('Invalid API key'))).toBe(true);
    });

    it('服务商没发完整 assistant 事件时，把流式正文保存为消息且不报错', () => {
      const tab = tabOf(TAB);
      const tabs = new Map(useChatStore.getState().tabs);
      tabs.set(TAB, { ...tab, partialText: '只来了流式正文', isStreaming: true });
      useChatStore.setState({ tabs });
      vi.spyOn(Date, 'now').mockReturnValue(2000);

      handleProcessExit(ctx, exit());

      vi.restoreAllMocks();
      const msgs = tabOf(TAB).messages;
      expect(msgs.map((m) => m.content)).toEqual(['只来了流式正文']);
      expect(tabOf(TAB).partialText).toBe('');
    });

    it('已经空闲（正常结束后才退出）时不提示错误', () => {
      ctx.setSessionStatus('idle');
      handleProcessExit(ctx, exit());
      expect(systemTexts()).toHaveLength(0);
    });
  });

  describe('退出后的清理', () => {
    it('未回答的权限卡/提问卡标记失败，已回答的不动', () => {
      const card = (id: string, type: ChatMessage['type'], resolved: boolean): ChatMessage => ({
        id, role: 'assistant', type, content: '', resolved, timestamp: 1,
      });
      ctx.addMessage(card('p1', 'permission', false));
      ctx.addMessage(card('q1', 'question', true));
      handleProcessExit(ctx, exit());
      const byId = (id: string) => tabOf(TAB).messages.find((m) => m.id === id);
      expect(byId('p1')?.interactionState).toBe('failed');
      expect(byId('q1')?.interactionState).toBeUndefined();
    });

    it('没发出去的排队消息退回输入框，接在已有草稿后面', () => {
      useChatStore.getState().setInputDraft(TAB, '草稿');
      useChatStore.getState().addPendingMessage(TAB, { text: '排队一', sent: false });
      useChatStore.getState().addPendingMessage(TAB, { text: '排队二', sent: false });
      handleProcessExit(ctx, exit());
      expect(tabOf(TAB).inputDraft).toBe('草稿\n\n排队一\n\n排队二');
      expect(tabOf(TAB).pendingUserMessages).toHaveLength(0);
    });

    it('状态回到空闲，释放监听器与 stdin 映射，清零后台任务，收尾卡住的命令卡', () => {
      const unlisten = vi.fn();
      window.__claudeUnlisteners![STDIN] = unlisten;
      useSessionStore.getState().setBackgroundTasks(TAB, 2);
      useBackgroundTaskStore.getState().applyLiveList(TAB, [{ task_id: 'bg', task_type: 'local_bash', description: 'pnpm dev' }]);
      ctx.addMessage({ id: 'cmd', role: 'system', type: 'text', content: '', timestamp: 1 });
      useChatStore.getState().setSessionMeta(TAB, { pendingCommandMsgId: 'cmd' });

      handleProcessExit(ctx, exit());

      const tab = tabOf(TAB);
      expect(tab.sessionStatus).toBe('idle');
      expect(tab.sessionMeta.stdinId).toBeUndefined();
      expect(tab.sessionMeta.pendingCommandMsgId).toBeUndefined();
      expect(tab.messages.find((m) => m.id === 'cmd')?.commandCompleted).toBe(true);
      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().getTabForStdin(STDIN)).toBeUndefined();
      expect(useSessionStore.getState().backgroundTasks.get(TAB) ?? 0).toBe(0);
      expect(useBackgroundTaskStore.getState().tasksByTab.get(TAB)?.[0].status).toBe('ended');
      expect(useSessionStore.getState().fetchSessions).toHaveBeenCalled();
    });
  });
});
