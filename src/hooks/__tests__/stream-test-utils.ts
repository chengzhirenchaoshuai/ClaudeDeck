// 流处理 handler 测试的公共辅助：按 useStreamProcessor 的方式构造 StreamContext，
// 写入真实的 chatStore，便于断言处理后的标签页状态。
import { vi } from 'vitest';
import { useChatStore } from '../../stores/chatStore';
import type { StreamContext, StreamProcessorConfig } from '../stream/context';
import type { StreamMessage } from '../../lib/stream-message';

const ref = <T,>(current: T) => ({ current });

/** 构造一份 InputBar 配置，ref 都给初始值，回调都是 mock */
export function makeConfig(overrides: Partial<StreamProcessorConfig> = {}): StreamProcessorConfig {
  return {
    exitPlanModeSeenRef: ref(false),
    autoCompactFiredRef: ref(false),
    silentRestartRef: ref(false),
    handleSubmitRef: ref(vi.fn()),
    handleStderrLineRef: ref(vi.fn()),
    lastStderrRef: ref(''),
    setInputSync: vi.fn(),
    ...overrides,
  };
}

/** 重置标签页并返回与 useStreamProcessor 一致的上下文（默认后台、无代理树） */
export function makeContext(tabId: string, overrides: Partial<StreamContext> = {}): StreamContext {
  const cs = useChatStore.getState();
  cs.ensureTab(tabId);
  cs.resetTab(tabId);
  return {
    tabId,
    isForeground: false,
    agentActions: null,
    agentId: 'main',
    config: makeConfig(),
    dispatch: vi.fn<(msg: StreamMessage) => void>(),
    addMessage: (message) => useChatStore.getState().addMessage(tabId, message),
    setSessionStatus: (status) => useChatStore.getState().setSessionStatus(tabId, status),
    setSessionMeta: (meta) => useChatStore.getState().setSessionMeta(tabId, meta),
    setActivityStatus: (status) => useChatStore.getState().setActivityStatus(tabId, status),
    clearPartial: () => {
      const tab = useChatStore.getState().getTab(tabId);
      if (!tab) return;
      const tabs = new Map(useChatStore.getState().tabs);
      tabs.set(tabId, { ...tab, partialText: '', partialThinking: '', isStreaming: false });
      useChatStore.setState({ tabs });
    },
    ...overrides,
  };
}

/** 基于 Map 的内存版 Storage */
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

/** node 环境下补上 handler 用到的浏览器全局对象（window、document、storage、rAF），用完调 vi.unstubAllGlobals() */
export function stubBrowserGlobals() {
  vi.stubGlobal('window', { __claudeUnlisteners: {} as Record<string, () => void> });
  vi.stubGlobal('document', { hasFocus: () => true });
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
}

/** 读取标签页当前状态 */
export const tabOf = (tabId: string) => useChatStore.getState().getTab(tabId)!;
