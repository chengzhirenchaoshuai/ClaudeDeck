// result 消息：子代理结果不结束会话、本轮收尾、命令卡、token 校正、排队消息、自动压缩、远程草稿刷新、AI 标题。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useChatStore, type ChatMessage } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { bridge, type SessionListItem } from '../../lib/tauri-bridge';
import { handleResultMessage } from '../stream/handlers/result';
import type { ResultMessage } from '../../lib/stream-message';
import { makeContext, stubBrowserGlobals, tabOf } from './stream-test-utils';

const TAB = 'stream_result_test_tab';
const STDIN = 'stdin_result_test';

const success = (extra: Partial<ResultMessage> = {}): ResultMessage => ({ type: 'result', subtype: 'success', ...extra });
const text = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id, role, type: 'text', content, timestamp: 1,
});

describe('handleResultMessage', () => {
  let ctx: ReturnType<typeof makeContext>;
  let sendStdin: Mock<typeof bridge.sendStdin>;
  let generateTitle: Mock<typeof bridge.generateSessionTitle>;
  let fetchRemoteSessions: Mock<() => Promise<void>>;
  const settingsBackup = useSettingsStore.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    stubBrowserGlobals();
    sendStdin = vi.fn<typeof bridge.sendStdin>().mockResolvedValue(undefined);
    generateTitle = vi.fn<typeof bridge.generateSessionTitle>().mockResolvedValue('自动标题');
    fetchRemoteSessions = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.spyOn(bridge, 'sendStdin').mockImplementation(sendStdin);
    vi.spyOn(bridge, 'generateSessionTitle').mockImplementation(generateTitle);
    useSessionStore.setState({
      fetchSessions: vi.fn().mockResolvedValue(undefined),
      fetchRemoteSessions,
      sessions: [],
      customPreviews: {},
    } as never);
    ctx = makeContext(TAB, { msgStdinId: STDIN });
    useChatStore.getState().setSessionMeta(TAB, { stdinId: STDIN, snapshotMode: 'code' });
    ctx.setSessionStatus('running');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useSettingsStore.setState(settingsBackup);
  });

  it('子代理的结果（带 parent_tool_use_id）不能结束主会话', () => {
    handleResultMessage(ctx, success({ parent_tool_use_id: 'task_1', result: '子任务完成' }));
    expect(tabOf(TAB).sessionStatus).toBe('running');
    expect(tabOf(TAB).messages).toHaveLength(0);
  });

  describe('本轮收尾', () => {
    it('成功为 completed、失败为 error', () => {
      handleResultMessage(ctx, success());
      expect(tabOf(TAB).sessionStatus).toBe('completed');
      ctx.setSessionStatus('running');
      handleResultMessage(ctx, { type: 'result', subtype: 'error_during_execution' });
      expect(tabOf(TAB).sessionStatus).toBe('error');
    });

    it('result 正文已经由 assistant 事件送达时不重复添加', () => {
      ctx.addMessage(text('a1', 'assistant', '回答'));
      handleResultMessage(ctx, success({ result: '回答' }));
      expect(tabOf(TAB).messages).toHaveLength(1);
    });

    it('只有 result 带正文时补成一条回复', () => {
      handleResultMessage(ctx, success({ uuid: 'r1', result: '只在 result 里' }));
      expect(tabOf(TAB).messages[0]).toMatchObject({ id: 'r1', role: 'assistant', content: '只在 result 里' });
    });

    it('用 result 的权威值校正累计 token（减去流式期间已计入的部分）', () => {
      useChatStore.getState().setSessionMeta(TAB, {
        inputTokens: 80, outputTokens: 20, totalInputTokens: 1080, totalOutputTokens: 220,
      });
      handleResultMessage(ctx, success({
        usage: { input_tokens: 100, output_tokens: 30 }, total_cost_usd: 0.05, num_turns: 2,
      }));
      expect(tabOf(TAB).sessionMeta).toMatchObject({
        inputTokens: 100, outputTokens: 30, totalInputTokens: 1100, totalOutputTokens: 230,
        cost: 0.05, turns: 2, turnStartTime: undefined,
      });
    });

    it('切换模型后的第一轮成功：清掉切换标记，免得以后签名错误时重发旧消息', () => {
      useChatStore.getState().setSessionMeta(TAB, { modelSwitched: true, modelSwitchPendingText: '旧消息' });
      handleResultMessage(ctx, success());
      expect(tabOf(TAB).sessionMeta).toMatchObject({ modelSwitched: false, modelSwitchPendingText: undefined });
    });
  });

  it('斜杠命令卡：写入输出和费用，不另起回复消息', () => {
    ctx.addMessage({ id: 'cmd', role: 'system', type: 'text', content: '', commandData: { command: '/cost' }, timestamp: 1 });
    useChatStore.getState().setSessionMeta(TAB, { pendingCommandMsgId: 'cmd' });
    handleResultMessage(ctx, success({ result: '总计 $0.12', total_cost_usd: 0.12, duration_ms: 1500, num_turns: 1 }));
    const card = tabOf(TAB).messages.find((m) => m.id === 'cmd');
    expect(card?.commandCompleted).toBe(true);
    expect(card?.commandData).toMatchObject({
      output: '总计 $0.12',
      costSummary: { cost: '0.1200', duration: '1.5s', turns: 1 },
    });
    expect(tabOf(TAB).messages).toHaveLength(1);
    expect(tabOf(TAB).sessionMeta.pendingCommandMsgId).toBeUndefined();
  });

  describe('排队消息', () => {
    it('已写入 stdin 的消息由 CLI 接着处理：保持运行（中途不闪成已完成），不再重发', () => {
      const statuses: string[] = [];
      const setSessionStatus = ctx.setSessionStatus;
      ctx = { ...ctx, setSessionStatus: (s) => { statuses.push(s); setSessionStatus(s); } };
      useChatStore.getState().addPendingMessage(TAB, { text: '已发送', sent: true });
      handleResultMessage(ctx, success());
      expect(statuses).not.toContain('completed');
      expect(tabOf(TAB).sessionStatus).toBe('running');
      expect(tabOf(TAB).sessionMeta.awaitingQueuedTurn).toBe(true);
      expect(sendStdin).not.toHaveBeenCalled();
    });

    it('未发送的排队消息每轮按先进先出发一条，气泡此时才插入', () => {
      const store = useChatStore.getState();
      ctx.addMessage(text('reply', 'assistant', '上一轮回复'));
      store.addPendingMessage(TAB, { text: '排队一', message: text('q1', 'user', '排队一') });
      store.addPendingMessage(TAB, { text: '排队二', message: text('q2', 'user', '排队二') });

      handleResultMessage(ctx, success());

      expect(sendStdin).toHaveBeenCalledTimes(1);
      expect(sendStdin).toHaveBeenCalledWith(STDIN, '排队一');
      expect(tabOf(TAB).messages.map((m) => m.id)).toEqual(['reply', 'q1']);
      expect(tabOf(TAB).pendingUserMessages.map((p) => p.text)).toEqual(['排队二']);
      expect(tabOf(TAB).sessionStatus).toBe('running');
    });

    it('发送失败：失败的和剩下的排队消息都退回输入框，状态为 error', async () => {
      sendStdin.mockRejectedValueOnce(new Error('pipe closed'));
      useChatStore.getState().addPendingMessage(TAB, { text: '排队一' });
      useChatStore.getState().addPendingMessage(TAB, { text: '排队二' });

      handleResultMessage(ctx, success());
      await vi.waitFor(() => expect(tabOf(TAB).sessionStatus).toBe('error'));

      expect(tabOf(TAB).inputDraft).toBe('排队一\n\n排队二');
      expect(tabOf(TAB).pendingUserMessages).toHaveLength(0);
    });
  });

  describe('自动压缩', () => {
    const huge = success({ usage: { input_tokens: 5_000_000, output_tokens: 0 } });

    it('前台超过阈值时发送一次 /compact（附默认参数），并跳过排队消息', () => {
      useSettingsStore.setState({ followCli: false, compactInstructions: '用中文写摘要' });
      ctx = { ...ctx, isForeground: true };
      useChatStore.getState().addPendingMessage(TAB, { text: '排队' });

      handleResultMessage(ctx, huge);

      expect(sendStdin).toHaveBeenCalledWith(STDIN, '/compact 用中文写摘要');
      expect(sendStdin).toHaveBeenCalledTimes(1);
      expect(ctx.config.autoCompactFiredRef.current).toBe(true);
      expect(tabOf(TAB).sessionMeta.pendingCommandMsgId).toBeDefined();

      // 每个会话只触发一次
      handleResultMessage(ctx, huge);
      expect(sendStdin.mock.calls.filter((c) => String(c[1]).startsWith('/compact'))).toHaveLength(1);
    });

    it('跟随 CLI 配置时交给 CLI 自己压缩', () => {
      useSettingsStore.setState({ followCli: true });
      ctx = { ...ctx, isForeground: true };
      handleResultMessage(ctx, huge);
      expect(sendStdin.mock.calls.some((c) => String(c[1]).startsWith('/compact'))).toBe(false);
    });

    it('/compact 15 秒没完成时自动收尾，不让会话卡在运行中', () => {
      useSettingsStore.setState({ followCli: false });
      ctx = { ...ctx, isForeground: true };
      handleResultMessage(ctx, huge);
      const cardId = tabOf(TAB).sessionMeta.pendingCommandMsgId!;
      vi.advanceTimersByTime(15_000);
      expect(tabOf(TAB).messages.find((m) => m.id === cardId)?.commandCompleted).toBe(true);
      expect(tabOf(TAB).sessionStatus).toBe('idle');
    });
  });

  it('远程新会话第一轮结束：刷新远程列表，替换掉草稿行', () => {
    const draftRow = { id: TAB, host: 'devbox', path: '' } as unknown as SessionListItem;
    useSessionStore.setState({ sessions: [draftRow] });
    handleResultMessage(ctx, success());
    expect(fetchRemoteSessions).toHaveBeenCalledTimes(1);
  });

  describe('AI 标题', () => {
    const addTurns = (n: number) => {
      for (let i = 0; i < n; i++) {
        ctx.addMessage(text(`u${i}`, 'user', `问题 ${i}`));
        ctx.addMessage(text(`a${i}`, 'assistant', `回答 ${i}`));
      }
    };

    it('第 3 轮成功后生成标题', async () => {
      useChatStore.getState().setSessionMeta(TAB, { sessionId: 'sess-1' });
      addTurns(3);
      handleResultMessage(ctx, success());
      expect(generateTitle).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(useSessionStore.getState().customPreviews['sess-1']).toBe('自动标题'));
    });

    it('不足 3 轮或已有自定义标题时不生成', () => {
      addTurns(2);
      handleResultMessage(ctx, success());
      ctx.setSessionStatus('running');
      useSessionStore.setState({ customPreviews: { [TAB]: '我起的名字' } });
      addTurns(3);
      handleResultMessage(ctx, success());
      expect(generateTitle).not.toHaveBeenCalled();
    });
  });
});
