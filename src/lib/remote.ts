import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { useChatStore } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';

export const LOCAL_ENV = 'local';

/** 拼出远程项目 URI：ssh://<主机>/<远端路径>，路径为空返回空串 */
export function remoteUri(hostId: string, remotePath: string): string {
  const cleaned = remotePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return cleaned ? `ssh://${hostId}/${cleaned}` : '';
}

/**
 * 会话里点到的文件路径。当前处于远程项目（工作目录为 ssh://<主机>/...）时，
 * 远端 claude 给出的绝对路径（如 C:\x\y.ts）要转成 ssh://<主机>/C:/x/y.ts 走远程读取，
 * 否则会被当成本机路径——读不到，或者读到本机上恰好同名的另一个文件。
 */
export function toSessionFilePath(path: string): string {
  if (path.startsWith('ssh://')) return path;
  const host = (useSettingsStore.getState().workingDirectory || '').match(/^ssh:\/\/([^/]+)\//)?.[1];
  if (host && /^[a-zA-Z]:[/\\]/.test(path)) return `ssh://${host}/${path.replace(/\\/g, '/')}`;
  return path;
}

/** 保存当前标签的对话与 Agent 状态，切走后回来仍能恢复 */
function saveCurrentTab() {
  const currentTabId = useSessionStore.getState().selectedSessionId;
  if (currentTabId) {
    useChatStore.getState().saveToCache(currentTabId);
    useAgentStore.getState().saveToCache(currentTabId);
  }
}

/** 切换环境（本地 / 远程主机）：保存当前标签状态，取消选中会话，并清空工作目录 */
export function switchEnv(env: string) {
  if (useSettingsStore.getState().activeEnv === env) return;
  saveCurrentTab();
  useSessionStore.getState().setSelectedSession(null);
  useSettingsStore.getState().setActiveEnv(env);
  // 远程会话没有实时同步，进入远程环境时刷新一次
  if (env !== LOCAL_ENV) useSessionStore.getState().fetchRemoteSessions();
}

/** 切换到指定远程主机，并在其目录下新建一个草稿对话 */
export function startRemoteProject(hostId: string, remotePath: string) {
  const uri = remoteUri(hostId, remotePath);
  if (!uri) return;
  // 已在该环境时 switchEnv 不会保存当前标签，这里补一次
  saveCurrentTab();
  switchEnv(hostId);
  useSettingsStore.getState().setWorkingDirectory(uri);
  const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  useChatStore.getState().ensureTab(draftId);
  useChatStore.getState().resetTab(draftId);
  useSessionStore.getState().addDraftSession(draftId, uri);
}
