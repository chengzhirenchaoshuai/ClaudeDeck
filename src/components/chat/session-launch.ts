// 发送消息时的 CLI 进程管理：判断已有进程是否过期、给新进程注册事件监听。
import { useChatStore, getActiveTabState, generateMessageId } from '../../stores/chatStore';
import { MODEL_OPTIONS, useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { bridge, onClaudeStream, onClaudeStderr, onSessionExit, onPermissionRequest } from '../../lib/tauri-bridge';
import { releaseStreamListener, setStreamListener } from '../../lib/stream-listeners';
import { envFingerprint, resolveModelForProvider } from '../../lib/api-provider';
import { displayProviderModelName } from '../../lib/deepseek-models';
import type { StreamMessage } from '../../lib/stream-message';

/**
 * 已有进程的启动条件（服务商环境、权限模式、上下文窗口、模型）与当前设置不一致时结束它。
 * 返回 true 表示已结束、需要新起进程；sessionId 保留，新进程会 --resume 续接上下文。
 */
export function dropStaleProcess(tabId: string, stdinId: string, text: string, selectedModel: string): boolean {
  const { setSessionMeta } = useChatStore.getState();
  const meta = getActiveTabState().sessionMeta;
  const kill = () => {
    bridge.killSession(stdinId).catch(() => {});
    releaseStreamListener(stdinId);
  };

  // 服务商配置变了（TK-303）：预热进程带的是旧环境变量。
  // 续接若因思考块签名不匹配失败，流处理里的自动重试会改为不续接重发。
  if (envFingerprint() !== meta.envFingerprint) {
    console.warn('[ClaudeDeck] API provider config changed, killing stale session');
    kill();
    setSessionMeta(tabId, { stdinId: undefined, envFingerprint: undefined, providerSwitched: true, providerSwitchPendingText: text });
    return true;
  }

  const currentMode = useSettingsStore.getState().sessionMode;
  const spawnedMode = meta.snapshotMode;
  if (spawnedMode && currentMode !== spawnedMode) {
    console.warn(`[ClaudeDeck] Permission mode changed (${spawnedMode} -> ${currentMode}), killing stale session`);
    kill();
    setSessionMeta(tabId, { stdinId: undefined, snapshotMode: undefined });
    return true;
  }

  const currentContextMode = useSettingsStore.getState().contextWindowMode;
  const spawnedContextMode = meta.snapshotContextWindowMode ?? 'default';
  if (currentContextMode !== spawnedContextMode) {
    console.warn(`[ClaudeDeck] Context window mode changed (${spawnedContextMode} -> ${currentContextMode}), killing stale session`);
    kill();
    setSessionMeta(tabId, { stdinId: undefined, snapshotContextWindowMode: undefined });
    return true;
  }

  const currentModel = resolveModelForProvider(selectedModel);
  const spawnedModel = meta.spawnedModel;
  if (spawnedModel && currentModel !== spawnedModel) {
    const oldShort = MODEL_OPTIONS.find((m) => m.id === spawnedModel)?.short ?? displayProviderModelName(spawnedModel);
    const newShort = MODEL_OPTIONS.find((m) => m.id === currentModel)?.short ?? displayProviderModelName(currentModel);
    console.warn(`[ClaudeDeck] Model changed (${oldShort} → ${newShort}), killing stale session`);
    kill();
    // 切换模型的系统提示已由 ModelSelector 插入，这里不重复
    setSessionMeta(tabId, { stdinId: undefined, spawnedModel: undefined, modelSwitched: true, modelSwitchPendingText: text });
    // 思考块签名与模型绑定，换模型续接会被 API 拒绝（400），先从历史里去掉思考块
    useChatStore.setState((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return {};
      const cleanedMessages = tab.messages.filter((m) => m.type !== 'thinking');
      if (cleanedMessages.length === tab.messages.length) return {};
      const newTabs = new Map(state.tabs);
      newTabs.set(tabId, { ...tab, messages: cleanedMessages });
      return { tabs: newTabs };
    });
    return true;
  }

  return false;
}

/**
 * 在启动进程之前注册它的 stdout / stderr / 权限请求 / 退出监听，并登记到 stream-listeners。
 * fallbackTabId 在进程退出时才读取（发送过程中标签页 ID 可能因回溯而改变）。
 */
export async function registerSessionListeners(
  stdinId: string,
  fallbackTabId: () => string | null,
  onStream: (msg: StreamMessage) => void,
  onStderr: (line: string, sid: string) => void,
): Promise<void> {
  const unlisten = await onClaudeStream(stdinId, (msg: StreamMessage) => {
    msg.__stdinId = stdinId;
    onStream(msg);
  });

  const unlistenStderr = await onClaudeStderr(stdinId, (line: string) => {
    onStderr(line, stdinId);
  });

  // SDK 控制协议的权限请求：写到该进程所属的后台标签页，否则写到当前标签页
  const unlistenPermission = await onPermissionRequest(stdinId, (req) => {
    const ownerTabId = useSessionStore.getState().getTabForStdin(stdinId);
    const activeTabId = useSessionStore.getState().selectedSessionId;
    const targetTabId = ownerTabId && ownerTabId !== activeTabId ? ownerTabId : activeTabId;
    if (!targetTabId) return;
    const chat = useChatStore.getState();
    chat.addMessage(targetTabId, {
      id: generateMessageId(),
      role: 'assistant',
      type: 'permission',
      content: req.description || `${req.tool_name} wants to execute`,
      permissionTool: req.tool_name,
      permissionDescription: req.description || '',
      timestamp: Date.now(),
      interactionState: 'pending',
      permissionData: {
        requestId: req.request_id,
        toolName: req.tool_name,
        input: req.input,
        description: req.description,
        toolUseId: req.tool_use_id,
      },
    });
    chat.setActivityStatus(targetTabId, { phase: 'awaiting' });
  });

  // 兜底的退出检测：stdout 里的 process_exit 漏掉时（如监听已被移除）由它清理
  const unlistenExit = await onSessionExit(stdinId, () => {
    const exitTabId = useSessionStore.getState().getTabForStdin(stdinId) || fallbackTabId();
    if (!exitTabId) return;
    const exitTab = useChatStore.getState().getTab(exitTabId);
    if (!exitTab) return;
    // 只在它仍是该标签页当前进程时处理，避免误清理
    if (exitTab.sessionMeta.stdinId === stdinId) {
      useChatStore.getState().setSessionMeta(exitTabId, { stdinId: undefined });
      if (exitTab.sessionStatus === 'running') {
        useChatStore.getState().setSessionStatus(exitTabId, 'idle');
      }
    }
  });

  setStreamListener(stdinId, () => {
    unlisten();
    unlistenStderr();
    unlistenPermission();
    unlistenExit();
  });
}
