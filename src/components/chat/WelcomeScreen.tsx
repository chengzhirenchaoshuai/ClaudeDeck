// 聊天区的空状态：欢迎页（未选项目，含新建草稿会话并预热 CLI）、加载中、已就绪。
import { useEffect, useMemo, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore, mapSessionModeToPermissionMode, getContextWindowForModel } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { RemotePathInput } from '../layout/EnvSwitcher';
import { useFileStore } from '../../stores/fileStore';
import { bridge, onClaudeStream, onClaudeStderr } from '../../lib/tauri-bridge';
import { setStreamListener } from '../../lib/stream-listeners';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { cliLaunchArgs, envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { SetupWizard } from '../setup/SetupWizard';
import { AiAvatar } from '../shared/AiAvatar';

/** Start a new draft conversation for the given folder and pre-warm the CLI process */
async function startDraftSession(folderPath: string) {
  useSettingsStore.getState().setWorkingDirectory(folderPath);
  const currentTab = useSessionStore.getState().selectedSessionId;
  if (currentTab) useChatStore.getState().resetTab(currentTab);

  // Reuse existing draft tab if one is already selected, otherwise create a new one
  const currentTabId = useSessionStore.getState().selectedSessionId;
  const currentSession = useSessionStore.getState().sessions.find(
    (s) => s.id === currentTabId,
  );
  let draftId: string;
  if (currentSession && currentSession.path === '') {
    // Reuse the existing draft — just update its project info
    draftId = currentSession.id;
    useSessionStore.getState().updateDraftProject(draftId, folderPath);
  } else {
    // No draft selected — create a new one
    draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().addDraftSession(draftId, folderPath);
  }

  // Pre-warm: spawn CLI process in background so first message is fast.
  // Send empty prompt — Rust will skip the NDJSON send.
  const preWarmId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Register stream listeners before spawning
    const unlisten = await onClaudeStream(preWarmId, (msg: any) => {
      // Tag message with stdinId so the handler can route to correct session
      msg.__stdinId = preWarmId;
      // Forward to InputBar's handler via a global — will be overridden when InputBar mounts
      const handler = window.__claudeStreamHandler;
      if (handler) {
        // Replay any events that arrived while handler was briefly null (React effect cycle)
        const queue = window.__claudeStreamQueue;
        if (queue && queue.length > 0) {
          console.warn(`[ClaudeDeck] replaying ${queue.length} queued pre-warm events`);
          const pending = queue.splice(0);
          for (const queued of pending) handler(queued);
        }
        handler(msg);
      } else {
        // Handler not yet available (InputBar not mounted or React effect cycle) — queue the event
        if (!window.__claudeStreamQueue) window.__claudeStreamQueue = [];
        window.__claudeStreamQueue.push(msg);
        console.warn('[ClaudeDeck] pre-warm event queued (handler not ready):', msg.type);
      }
    });
    const unlistenStderr = await onClaudeStderr(preWarmId, (line: string) => {
      // Log pre-warm stderr for debugging (errors here explain why CLI may fail)
      console.warn('[ClaudeDeck] pre-warm stderr:', line);
    });

    // Store unlisten per stdinId for multi-session support
    setStreamListener(preWarmId, () => {
      unlisten();
      unlistenStderr();
    });

    const selectedModel = useSettingsStore.getState().selectedModel;
    const sessionMode = useSettingsStore.getState().sessionMode;
    const thinkingSetting = useSettingsStore.getState().thinkingLevel;
    const contextWindowMode = useSettingsStore.getState().contextWindowMode;
    const providerId = useProviderStore.getState().activeProviderId || null;
    const resolvedModel = resolveModelForProvider(selectedModel);
    const session = await bridge.startSession({
      prompt: '',  // empty = pre-warm, no message sent
      cwd: folderPath,
      session_id: preWarmId,
      ...cliLaunchArgs(resolvedModel, resolveThinkingLevelForProvider(selectedModel, thinkingSetting)),
      provider_id: providerId || undefined,
      context_window: getContextWindowForModel(resolvedModel, contextWindowMode),
      permission_mode: mapSessionModeToPermissionMode(sessionMode),
      enable_mcp: useSettingsStore.getState().enableMcp,
    });

    // Store stdinId so InputBar can send the first message via stdin
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, {
      sessionId: session.session_id,
      stdinId: preWarmId,
      envFingerprint: envFingerprint(),
      snapshotMode: sessionMode,
      snapshotModel: selectedModel,
      snapshotThinking: thinkingSetting,
      snapshotContextWindowMode: contextWindowMode,
      snapshotProviderId: providerId,
      spawnedModel: resolvedModel,
    });

    // Register stdinId → tabId mapping for background stream routing
    useSessionStore.getState().registerStdinTab(preWarmId, draftId);
  } catch {
    // Pre-warm failed — InputBar will spawn on first message instead
  }
}

/** Welcome screen shown when no project folder is selected */
export function WelcomeScreen() {
  const t = useT();
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const recentProjects = useFileStore((s) => s.recentProjects);
  const fetchProjects = useFileStore((s) => s.fetchRecentProjects);
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const allSessions = useSessionStore((s) => s.sessions);
  const isRemoteEnv = activeEnv !== 'local';
  // 远程环境下，最近项目取自该主机上已有会话的项目目录
  const remoteRecent = useMemo(() => {
    if (!isRemoteEnv) return [];
    const latest = new Map<string, number>();
    for (const s of allSessions) {
      if (s.host !== activeEnv || !s.project) continue;
      latest.set(s.project, Math.max(latest.get(s.project) || 0, s.modifiedAt));
    }
    return Array.from(latest.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([path]) => ({
        path,
        name: path.split('/').filter(Boolean).pop() || path,
        shortPath: path,
      }));
  }, [isRemoteEnv, activeEnv, allSessions]);

  useEffect(() => { fetchProjects(); }, []);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (selected) {
      startDraftSession(selected as string);
    }
  }, [t]);

  // Show SetupWizard if setup has not been completed
  if (!setupCompleted) {
    return <SetupWizard />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-20 h-20" rounded="rounded-3xl" className="mb-6 shadow-glow" />
      <h2 className="text-xl font-semibold text-accent mb-2">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed mb-6">
        {t('welcome.subtitle')}
      </p>

      {isRemoteEnv && (
        <div className="w-full max-w-sm mb-8">
          <p className="text-xs text-text-tertiary mb-2">{t('env.remoteWelcome')}</p>
          <RemotePathInput hostId={activeEnv} onOpen={startDraftSession} />
        </div>
      )}

      {/* Primary action: new chat with folder picker */}
      {!isRemoteEnv && (
      <button
        onClick={handlePickFolder}
        className="px-6 py-3 rounded-[20px] text-sm font-medium
          bg-accent hover:bg-accent-hover text-text-inverse
          hover:shadow-glow transition-smooth
          flex items-center gap-2 mb-8"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h4l2 2h6v7H2V4z" />
        </svg>
        {t('welcome.newChat')}
      </button>
      )}

      {/* Recent projects */}
      {(isRemoteEnv ? remoteRecent : recentProjects).length > 0 && (
        <div className="w-full max-w-sm">
          <div className="text-[11px] font-medium text-text-tertiary uppercase
            tracking-wider mb-3">
            {t('welcome.recentProjects')}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {(isRemoteEnv ? remoteRecent : recentProjects).slice(0, 6).map((project) => (
              <button
                key={project.path}
                onClick={() => startDraftSession(project.path)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5
                  rounded-lg border border-border-subtle text-xs
                  text-text-muted hover:border-accent hover:text-accent
                  hover:bg-accent/5 transition-smooth"
                title={project.shortPath}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5"
                  className="flex-shrink-0 text-text-tertiary">
                  <path d="M2 4h4l2 2h6v7H2V4z" />
                </svg>
                {project.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Empty state shown when project is selected but no messages yet */
/** 从磁盘（含远程 ssh）加载会话内容期间显示，避免看起来和“空的新会话”一样 */
export function LoadingSessionState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-4" />
      <p className="text-sm text-text-muted">{t('chat.loadingSession')}</p>
    </div>
  );
}

export function EmptyReadyState() {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-16 h-16" rounded="rounded-2xl" className="mb-5 shadow-glow" />
      <h2 className="text-lg font-semibold text-accent mb-1">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed">
        {t('chat.welcomeWithProject')}
      </p>
      {workingDirectory && (
        <p className="text-xs text-text-tertiary mt-2 truncate max-w-xs">
          {workingDirectory}
        </p>
      )}
    </div>
  );
}
