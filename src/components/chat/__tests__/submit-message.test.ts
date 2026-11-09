// 发送消息的三个阶段：准备文本、显示/排队用户气泡、写入 stdin 或启动新进程。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
};
vi.stubGlobal('sessionStorage', memoryStorage());
vi.stubGlobal('localStorage', memoryStorage());

// 注册 Tauri 事件监听和判断进程是否过期都依赖真实后端，这里替换掉
vi.mock('../session-launch', () => ({
  registerSessionListeners: vi.fn().mockResolvedValue(undefined),
  dropStaleProcess: vi.fn().mockReturnValue(false),
}));

const { useChatStore } = await import('../../../stores/chatStore');
const { useSessionStore } = await import('../../../stores/sessionStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useCommandStore } = await import('../../../stores/commandStore');
const { bridge } = await import('../../../lib/tauri-bridge');
const sessionLaunch = await import('../session-launch');
const { prepareSubmission, showUserTurn, launchTurn } = await import('../submit-message');
import type { UnifiedCommand } from '../../../lib/tauri-bridge';
import type { FileAttachment } from '../../../hooks/useFileAttachments';
import type { PreparedSubmission } from '../submit-message';

const TAB = 'submit_test_tab';
const tab = () => useChatStore.getState().getTab(TAB)!;
const lastMessage = () => tab().messages[tab().messages.length - 1];
const t = (key: string) => `<${key}>`;
const file = (name: string): FileAttachment => ({ id: name, name, path: `C:/p/${name}`, size: 1, type: 'text/plain', isImage: false });

beforeEach(() => {
  vi.stubGlobal('window', { __claudeUnlisteners: {}, dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  useChatStore.getState().ensureTab(TAB);
  useChatStore.getState().resetTab(TAB);
  useSessionStore.setState({ selectedSessionId: TAB, fetchSessions: vi.fn().mockResolvedValue(undefined) } as never);
  useCommandStore.setState({ activePrefixes: [], commands: [] });
  useSettingsStore.setState({ sessionMode: 'code', followCli: false, skillDirectories: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('prepareSubmission', () => {
  const prepare = (rawInput: string, files: FileAttachment[] = []) => {
    const setInputSync = vi.fn();
    const executeImmediateCommand = vi.fn();
    const result = prepareSubmission({ tabId: TAB, rawInput, files, t, setInputSync, executeImmediateCommand });
    return { result, setInputSync, executeImmediateCommand };
  };

  it('普通消息：去掉首尾空白，清掉上一轮的提示建议', async () => {
    useChatStore.getState().setPromptSuggestion(TAB, '旧建议');
    const prepared = await prepare('  你好  ').result;
    expect(prepared).toMatchObject({ text: '你好', rawInput: '  你好  ', compactWithoutProcess: false });
    expect(tab().promptSuggestion).toBeUndefined();
  });

  it('空输入且没有技能：不发送', async () => {
    expect(await prepare('   ').result).toBeNull();
  });

  it('附件路径附在末尾，回退摘要放在最前面并只用一次', async () => {
    useChatStore.getState().setSessionMeta(TAB, { pendingSummary: '摘要' });
    const prepared = await prepare('看看', [file('a.ts'), file('b.ts')]).result;
    expect(prepared?.text).toBe('摘要\n\n看看\n\n<input.attachedFiles>\nC:/p/a.ts\nC:/p/b.ts');
    expect(prepared?.pendingSummary).toBe('摘要');
    expect(tab().sessionMeta.pendingSummary).toBeUndefined();
  });

  it('单独的 /plan：切换模式并显示提示，不发送', async () => {
    const { result, setInputSync } = prepare('/plan');
    expect(await result).toBeNull();
    expect(useSettingsStore.getState().sessionMode).toBe('plan');
    expect(setInputSync).toHaveBeenCalledWith('');
    expect(tab().messages[0]).toMatchObject({ commandType: 'mode', content: '<cmd.switchedToPlan>' });
  });

  it('/ask 后面带文字：切换模式后照常发送这段文字', async () => {
    const prepared = await prepare('/ask 这是什么').result;
    expect(useSettingsStore.getState().sessionMode).toBe('ask');
    expect(prepared?.text).toBe('/ask 这是什么');
  });

  it('直接输入的内置命令交给立即执行，带上参数', async () => {
    useCommandStore.setState({ commands: [{ name: '/help', immediate: true } as UnifiedCommand] });
    const { result, executeImmediateCommand } = prepare('/HELP 权限');
    expect(await result).toBeNull();
    expect(executeImmediateCommand).toHaveBeenCalledWith('/help', '权限');
  });

  it('历史会话（没有进程）里的 /compact 不拦截，作为消息发给 CLI 续接压缩', async () => {
    useCommandStore.setState({ commands: [{ name: '/compact', immediate: true } as UnifiedCommand] });
    useChatStore.getState().setSessionMeta(TAB, { sessionId: 'old-session' });
    useSettingsStore.setState({ compactInstructions: '用中文写摘要' });
    const { result, executeImmediateCommand } = prepare('/compact');
    expect(await result).toMatchObject({ text: '/compact 用中文写摘要', compactWithoutProcess: true });
    expect(executeImmediateCommand).not.toHaveBeenCalled();
  });

  it('续接压缩时用户自己写了参数：原样使用，不附默认参数', async () => {
    useCommandStore.setState({ commands: [{ name: '/compact', immediate: true } as UnifiedCommand] });
    useChatStore.getState().setSessionMeta(TAB, { sessionId: 'old-session' });
    useSettingsStore.setState({ compactInstructions: '用中文写摘要' });
    const { result } = prepare('/compact 只保留代码改动');
    expect(await result).toMatchObject({ text: '/compact 只保留代码改动', compactWithoutProcess: true });
  });

  it('技能读取失败：提示错误，不发送', async () => {
    const skill = { name: 'review', category: 'skill', path: 'C:/skills/review/SKILL.md' } as UnifiedCommand;
    useCommandStore.setState({ activePrefixes: [skill], commands: [skill] });
    vi.spyOn(bridge, 'readSkill').mockRejectedValue(new Error('not found'));
    expect(await prepare('看看').result).toBeNull();
    expect(lastMessage()).toMatchObject({ commandType: 'error', content: '<skills.readFailed>' });
    expect(useCommandStore.getState().activePrefixes).toHaveLength(0);
  });

  it('有待审阅的计划时空输入按 Enter：批准权限请求并触发执行', async () => {
    vi.spyOn(bridge, 'respondPermission').mockResolvedValue(undefined);
    useSettingsStore.setState({ sessionMode: 'plan' });
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live' });
    useChatStore.getState().addMessage(TAB, {
      id: 'plan', role: 'assistant', type: 'plan_review', content: '', resolved: false, timestamp: 1,
      permissionData: { requestId: 'req-1', toolName: 'ExitPlanMode', input: {} },
    } as never);

    expect(await prepare('').result).toBeNull();
    expect(bridge.respondPermission).toHaveBeenCalledWith('live', 'req-1', true, undefined, undefined, {}, expect.anything());
    expect(tab().messages[0]).toMatchObject({ resolved: true, interactionState: 'resolved' });
    expect(useSettingsStore.getState().sessionMode).toBe('code');
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });
});

describe('showUserTurn', () => {
  const prepared = (extra: Partial<PreparedSubmission> = {}): PreparedSubmission => ({
    text: '你好', rawInput: '你好', sentPrefixes: [], selectedSkills: [], compactWithoutProcess: false, ...extra,
  });
  const show = (p: PreparedSubmission, files: FileAttachment[] = []) => {
    const clearFiles = vi.fn();
    const silentRestartRef = { current: false };
    const queued = showUserTurn({ tabId: TAB, prepared: p, files, clearFiles, silentRestartRef });
    return { queued, clearFiles, silentRestartRef };
  };

  it('空闲时：插入用户气泡（带附件和发送上下文），清空附件，继续启动', async () => {
    const { queued, clearFiles } = show(prepared({ pendingSummary: '摘要' }), [file('a.ts')]);
    expect(await queued).toBe(false);
    expect(tab().messages[0]).toMatchObject({
      role: 'user', content: '你好',
      attachments: [{ name: 'a.ts', path: 'C:/p/a.ts' }],
      sendContext: { rawInput: '你好', pendingSummary: '摘要' },
    });
    expect(clearFiles).toHaveBeenCalled();
  });

  it('只选了技能没写文字：气泡显示技能名', async () => {
    await show(prepared({ rawInput: '', selectedSkills: [{ name: 'review' } as UnifiedCommand] })).queued;
    expect(tab().messages[0].content).toBe('review');
  });

  it('运行中提交：写入 stdin 由 CLI 排队，气泡等回显再插入', async () => {
    vi.spyOn(bridge, 'sendStdin').mockResolvedValue(undefined);
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live' });
    useChatStore.getState().setSessionStatus(TAB, 'running');

    expect(await show(prepared()).queued).toBe(true);

    expect(tab().messages).toHaveLength(0);
    const [pending] = tab().pendingUserMessages;
    expect(pending).toMatchObject({ text: '你好', sent: true });
    expect(bridge.sendStdin).toHaveBeenCalledWith('live', '你好', pending.uuid);
  });

  it('运行中写入失败：改回排队，等本轮结束再发', async () => {
    vi.spyOn(bridge, 'sendStdin').mockRejectedValue(new Error('pipe'));
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live' });
    useChatStore.getState().setSessionStatus(TAB, 'running');
    await show(prepared()).queued;
    expect(tab().pendingUserMessages[0].sent).toBeFalsy();
  });

  it('运行中提交斜杠命令：不写 stdin，等本轮结束按顺序发送', async () => {
    vi.spyOn(bridge, 'sendStdin').mockResolvedValue(undefined);
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live' });
    useChatStore.getState().setSessionStatus(TAB, 'running');
    await show(prepared({ text: '/cost', rawInput: '/cost' })).queued;
    expect(bridge.sendStdin).not.toHaveBeenCalled();
    expect(tab().pendingUserMessages[0]).toMatchObject({ text: '/cost' });
    expect(tab().pendingUserMessages[0].sent).toBeFalsy();
  });

  it('历史会话续接压缩：显示处理卡而不是用户气泡', async () => {
    useChatStore.getState().setSessionMeta(TAB, { contextInputTokens: 5000, contextOutputTokens: 0 });
    expect(await show(prepared({ text: '/compact', rawInput: '/compact', compactWithoutProcess: true })).queued).toBe(false);
    const card = tab().messages[0];
    expect(card).toMatchObject({ role: 'system', commandType: 'processing', commandData: { command: '/compact', compactSummary: { preTokens: 5000 } } });
    expect(tab().sessionMeta.pendingCommandMsgId).toBe(card.id);
  });

  it('静默重启：不显示气泡，标记用完即复位', async () => {
    const clearFiles = vi.fn();
    const silentRestartRef = { current: true };
    expect(await showUserTurn({ tabId: TAB, prepared: prepared(), files: [], clearFiles, silentRestartRef })).toBe(false);
    expect(tab().messages).toHaveLength(0);
    expect(silentRestartRef.current).toBe(false);
  });
});

describe('launchTurn', () => {
  const refs = () => ({
    lastStderrRef: { current: '上一轮的错误' },
    autoCompactFiredRef: { current: true },
    exitPlanModeSeenRef: { current: true },
  });
  const launch = (overrides: Partial<Parameters<typeof launchTurn>[0]> = {}) => {
    const spawning = new Map();
    const r = refs();
    const done = launchTurn({
      tabId: TAB, text: '你好', rawInput: '你好', workingDirectory: 'F:/proj', selectedModel: 'claude-opus-5-5', t,
      spawning, ...r, handleStreamMessage: vi.fn(), handleStderrLine: vi.fn(), ...overrides,
    });
    return { done, spawning, ...r };
  };

  it('有可用进程：直接写入 stdin，不启动新进程', async () => {
    vi.spyOn(bridge, 'sendStdin').mockResolvedValue(undefined);
    vi.spyOn(bridge, 'startSession');
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'live', spawnedModel: 'x' });

    const { done, lastStderrRef } = launch();
    await done;

    expect(bridge.sendStdin).toHaveBeenCalledWith('live', '你好');
    expect(bridge.startSession).not.toHaveBeenCalled();
    expect(tab().sessionStatus).toBe('running');
    expect(lastStderrRef.current).toBe('');
  });

  it('没有进程：用 desk_ ID 先登记映射、注册监听，再启动；历史会话带 --resume', async () => {
    vi.spyOn(bridge, 'startSession').mockResolvedValue({ session_id: 'desk_x', pid: 1, cli_path: 'claude' } as never);
    useChatStore.getState().setSessionMeta(TAB, { sessionId: 'b6f1c2d4-0000-4000-8000-000000000000' });

    const { done, spawning, autoCompactFiredRef, exitPlanModeSeenRef } = launch();
    await done;

    const params = vi.mocked(bridge.startSession).mock.calls[0][0];
    const sid = params.session_id!;
    expect(sid.startsWith('desk_')).toBe(true);
    expect(params.resume_session_id).toBe('b6f1c2d4-0000-4000-8000-000000000000');
    expect(params.prompt).toBe('你好');
    expect(useSessionStore.getState().getTabForStdin(sid)).toBe(TAB);
    expect(sessionLaunch.registerSessionListeners).toHaveBeenCalledWith(sid, expect.any(Function), expect.any(Function), expect.any(Function));
    expect(tab().sessionMeta.stdinId).toBe(sid);
    expect(autoCompactFiredRef.current).toBe(false);
    expect(exitPlanModeSeenRef.current).toBe(false);
    expect(spawning.size).toBe(0);
  });

  it('desk_ 开头的会话 ID 不是 CLI 的真实 ID，不用于 --resume', async () => {
    vi.spyOn(bridge, 'startSession').mockResolvedValue({ session_id: 'desk_x', pid: 1, cli_path: 'claude' } as never);
    useChatStore.getState().setSessionMeta(TAB, { sessionId: 'desk_old' });
    await launch().done;
    expect(vi.mocked(bridge.startSession).mock.calls[0][0].resume_session_id).toBeUndefined();
  });

  it('stdin 写入失败（进程已退出）：改为启动新进程', async () => {
    vi.spyOn(bridge, 'sendStdin').mockRejectedValue(new Error('broken pipe'));
    vi.spyOn(bridge, 'startSession').mockResolvedValue({ session_id: 'desk_x', pid: 1, cli_path: 'claude' } as never);
    useChatStore.getState().setSessionMeta(TAB, { stdinId: 'dead' });
    await launch().done;
    expect(bridge.startSession).toHaveBeenCalledTimes(1);
  });

  it('启动期间被终止：结束刚拿到的进程，不接管会话', async () => {
    vi.spyOn(bridge, 'killSession').mockResolvedValue(undefined);
    let spawningMap: Map<string, { cancelled: boolean }> | undefined;
    vi.spyOn(bridge, 'startSession').mockImplementation(async () => {
      spawningMap!.get(TAB)!.cancelled = true;
      return { session_id: 'desk_x', pid: 1, cli_path: 'claude' } as never;
    });
    const spawning = new Map();
    spawningMap = spawning;
    await launch({ spawning }).done;
    const sid = vi.mocked(bridge.startSession).mock.calls[0][0].session_id!;
    expect(bridge.killSession).toHaveBeenCalledWith(sid);
    expect(tab().sessionMeta.stdinId).toBeUndefined();
    expect(useSessionStore.getState().getTabForStdin(sid)).toBeUndefined();
  });

  it('启动失败：显示错误并注销映射', async () => {
    vi.spyOn(bridge, 'startSession').mockRejectedValue('CLI not found');
    await launch().done;
    expect(tab().sessionStatus).toBe('error');
    expect(lastMessage()?.content).toBe('Error: CLI not found');
    const sid = vi.mocked(bridge.startSession).mock.calls[0][0].session_id!;
    expect(useSessionStore.getState().getTabForStdin(sid)).toBeUndefined();
  });

  it('没有工作目录：报错，不启动', async () => {
    vi.spyOn(bridge, 'startSession');
    await launch({ workingDirectory: '' }).done;
    expect(tab().sessionStatus).toBe('error');
    expect(bridge.startSession).not.toHaveBeenCalled();
  });
});
