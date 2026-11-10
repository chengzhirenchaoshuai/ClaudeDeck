import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { SecondaryPanel } from './components/layout/SecondaryPanel';
import { CommandPalette } from './components/commands/CommandPalette';
import { ImageLightbox } from './components/shared/ImageLightbox';
import { Toast } from './components/shared/Toast';
import { PullProgress } from './components/files/PullProgress';
import { FileLinkMenuHost } from './components/shared/FileLinkMenu';
import { useSettingsStore } from './stores/settingsStore';
import { useProviderStore } from './stores/providerStore';
import type { FontFamily } from './stores/settingsStore';
import { useFileStore } from './stores/fileStore';
import { useChatStore, useActiveTab } from './stores/chatStore';
import { useSessionStore } from './stores/sessionStore';
import { useAgentStore } from './stores/agentStore';
import { bridge, onFileChange, isRemotePath, setPermissionAnsweredHook } from './lib/tauri-bridge';
import { disposableListen } from './lib/disposable-listen';
import { useScrollZoom } from './lib/useScrollZoom';
import { useT } from './lib/i18n';
import { startReconnect } from './hooks/stream/reconnect';
import { requestQuit } from './lib/app-quit';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTaskbarBadge } from './hooks/useTaskbarBadge';
import { useAutoUpdateCheck } from './hooks/useAutoUpdateCheck';
import { useUnreadSessions } from './hooks/useUnreadSessions';
import { useSystemNotifications } from './hooks/useSystemNotifications';
import { installChipCopy } from './lib/chip-copy';
import { installDraftCleanup } from './lib/draft-cleanup';
import { useTerminalSessions } from './hooks/useTerminalSessions';
import { skinForMode } from './lib/themes';
import { resolveProjectPath } from './components/conversations/session-list-model';
import { isHomeDirectory } from './lib/home-dir';
import './App.css';

// 设置面板、用量统计打开时才加载
const SettingsPanel = lazy(() => import('./components/settings/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const UsageModal = lazy(() => import('./components/usage/UsageModal').then((m) => ({ default: m.UsageModal })));

const FONT_FAMILY_STACKS: Record<FontFamily, string> = {
  system: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif',
  microsoft: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
  sourceHan: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  lxgw: '"LXGW WenKai Screen", "LXGW WenKai", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Microsoft YaHei UI", monospace',
};

/**
 * 设置、用量弹窗。单独订阅开关状态：若放在 App 里，每次打开/关闭都会让 App 重渲染，
 * 连带侧栏、消息区（含当前会话全部消息）一起重渲染，长会话下打开设置会明显卡一下。
 */
function Overlays() {
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const usageOpen = useSettingsStore((s) => s.usageOpen);
  return (
    <Suspense fallback={null}>
      {settingsOpen && <SettingsPanel />}
      {usageOpen && <UsageModal />}
    </Suspense>
  );
}

function App() {
  const theme = useSettingsStore((s) => s.theme);
  const lightSkin = useSettingsStore((s) => s.lightSkin);
  const darkSkin = useSettingsStore((s) => s.darkSkin);
  const customBgImage = useSettingsStore((s) => s.customBgImage);
  const glassBlur = useSettingsStore((s) => s.glassBlur);
  const glassOpacity = useSettingsStore((s) => s.glassOpacity);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const monoFontFollowsInterface = useSettingsStore((s) => s.monoFontFollowsInterface);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const loadTree = useFileStore((s) => s.loadTree);
  const refreshTree = useFileStore((s) => s.refreshTree);
  const markFileChanged = useFileStore((s) => s.markFileChanged);
  const prevDirRef = useRef<string | null>(null);

  const t = useT();

  // 启动后静默检查应用更新
  useAutoUpdateCheck();

  // 复制消息文本时把文件链接换成原文（完整路径），否则链接会被整个丢掉
  useEffect(() => installChipCopy(), []);

  // 没发消息就切走的新建会话不保留，避免列表里堆满空会话
  useEffect(() => installDraftCleanup(), []);

  // 回复权限请求/提问后，运行状态从“等待确认”恢复成之前的工具（工具此时才真正开始运行）。
  // 延后一拍：卡片在回复成功后才把自己标为已处理，要等它更新完再判断是否还有待确认项
  useEffect(() => {
    setPermissionAnsweredHook((stdinId) => {
      setTimeout(() => {
        const tabId = useSessionStore.getState().getTabForStdin(stdinId);
        if (tabId) useChatStore.getState().resumeAfterAwaiting(tabId);
      }, 0);
    });
    return () => setPermissionAnsweredHook(null);
  }, []);

  // CLI update detection: check on startup + poll every 30 minutes
  useEffect(() => {
    const checkCliUpdate = () => {
      bridge.checkCliUpdate().then((result) => {
        useSettingsStore.setState({
          cliUpdateAvailable: result.update_available,
          cliLatestVersion: result.latest ?? '',
        });
      }).catch(() => {}); // silently ignore
    };
    checkCliUpdate();
    const interval = setInterval(checkCliUpdate, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // 关闭窗口：默认隐藏到系统托盘（可在设置里关闭）；关闭该选项后走“退出”流程
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    return disposableListen(Promise.resolve().then(() => {
      const win = getCurrentWindow();
      return win.onCloseRequested(async (event) => {
        event.preventDefault();
        if (useSettingsStore.getState().minimizeOnClose) {
          await win.hide().catch(() => {});
          return;
        }
        await requestQuit(tRef.current);
      });
    }));
  }, []);

  // 托盘菜单“退出”：后端已唤起窗口，这里走统一的退出流程（确认 + 有序收尾）
  useEffect(() => {
    return disposableListen(listen('tray:quit-requested', () => { void requestQuit(tRef.current); }));
  }, []);

  // 应用不在最前时，会话结束会在任务栏图标上显示数字提醒
  useTaskbarBadge();

  // 会话结束时不在该会话窗口，则标记为未读
  useUnreadSessions();
  // 窗口不在前台时，回复完成或需要确认会弹出系统通知
  useSystemNotifications();
  useTerminalSessions();

  // 页面刷新（F5、WebView 重新加载）后重新接上仍存活的 CLI 进程，结束没有标签页对应的孤儿进程。
  // 只执行一次；ConversationList 恢复上次选中的会话前也会等它完成
  useEffect(() => {
    void startReconnect();
  }, []);

  // Load custom session names and provider config on startup
  useEffect(() => {
    useSessionStore.getState().loadCustomPreviewsFromDisk();
    useProviderStore.getState().load();
  }, []);

  // Disable browser context menu globally (native app feel)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow context menu only in input fields and textareas
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // 应用主题方案：按外观（浅色 / 深色 / 跟随系统）选出方案，
  // 写入 data-skin，并按方案自身的深浅切换 .dark（供 Tailwind dark: 变体使用）。
  // 用 layout effect 在首次绘制前生效，避免深色用户启动时闪一下浅色
  useLayoutEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const mode = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      const skin = skinForMode(mode === 'dark' ? darkSkin : lightSkin, mode);
      root.dataset.skin = skin.id;
      root.toggleAttribute('data-flat', skin.flat);
      root.classList.toggle('dark', skin.mode === 'dark');
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme, lightSkin, darkSkin]);

  // Apply custom background image + glass morphism CSS variables
  useEffect(() => {
    const root = document.documentElement;
    if (customBgImage) {
      root.classList.add('custom-bg-active');
      root.style.setProperty('--custom-bg-image', `url("${customBgImage}")`);
      root.style.setProperty('--glass-blur', `${glassBlur}px`);
      root.style.setProperty('--glass-opacity', `${glassOpacity / 100}`);
    } else {
      root.classList.remove('custom-bg-active');
      root.style.removeProperty('--custom-bg-image');
      root.style.removeProperty('--glass-blur');
      root.style.removeProperty('--glass-opacity');
    }
  }, [customBgImage, glassBlur, glassOpacity]);

  // Apply font size to document root
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  // Ctrl/Cmd+wheel UI zoom (ported from vscode-cc-enhance)
  useScrollZoom();

  // Apply font family to document root
  useEffect(() => {
    const stack = FONT_FAMILY_STACKS[fontFamily] || FONT_FAMILY_STACKS.microsoft;
    document.documentElement.style.setProperty('--tokenicode-font-family', stack);
  }, [fontFamily]);

  useEffect(() => {
    document.documentElement.dataset.monoFollowsInterface = monoFontFollowsInterface ? 'true' : 'false';
  }, [monoFontFollowsInterface]);

  // Cmd+/- global shortcut for font size
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        useSettingsStore.getState().increaseFontSize();
      } else if (e.key === '-') {
        e.preventDefault();
        useSettingsStore.getState().decreaseFontSize();
      } else if (e.key === '0') {
        e.preventDefault();
        useSettingsStore.getState().setFontSize(14);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+Tab: quick-switch between the two most recent sessions
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const sessionState = useSessionStore.getState();
        const { previousSessionId, selectedSessionId, sessions } = sessionState;
        if (!previousSessionId || previousSessionId === selectedSessionId) return;
        // Verify previous session still exists
        const prevSession = sessions.find((s) => s.id === previousSessionId);
        if (!prevSession) return;

        // Save current session to cache
        if (selectedSessionId) {
          useChatStore.getState().ensureTab(selectedSessionId);
          useAgentStore.getState().saveToCache(selectedSessionId);
        }

        // Close file preview
        useFileStore.getState().closePreview();

        // Switch selection (this also updates previousSessionId)
        sessionState.setSelectedSession(previousSessionId);

        // Restore from cache
        const restored = useChatStore.getState().restoreFromCache(previousSessionId);
        if (restored) {
          useAgentStore.getState().restoreFromCache(previousSessionId);
          // Restore working directory
          const projectPath = prevSession.project || prevSession.projectDir;
          if (projectPath) {
            // 与会话列表共用解析逻辑：ssh:// 远程路径原样保留（原先手写的一份会把其中的 - 换成 /）
            useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectPath));
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load file tree + start watcher when working directory changes
  useEffect(() => {
    if (!workingDirectory) return;

    // 远程项目（ssh://）：经 ssh 读取文件树。远端没有文件监听，只在切换时加载一次，
    // 之后在会话回合结束时刷新（见下方 effect）或由用户手动刷新
    if (isRemotePath(workingDirectory)) {
      loadTree(workingDirectory);
      return;
    }

    // Unwatch previous directory
    if (prevDirRef.current && prevDirRef.current !== workingDirectory) {
      bridge.unwatchDirectory(prevDirRef.current).catch(() => {});
    }
    prevDirRef.current = workingDirectory;

    // loadTree 自己会跳过主目录；监听要等确认不是主目录后再开始（主目录系统文件变化太频繁）
    loadTree(workingDirectory);
    let cancelled = false;
    let watching = false;
    isHomeDirectory(workingDirectory).then((isHome) => {
      if (cancelled || isHome) return;
      watching = true;
      bridge.watchDirectory(workingDirectory).catch(console.error);
    });

    return () => {
      cancelled = true;
      if (watching) bridge.unwatchDirectory(workingDirectory).catch(() => {});
    };
  }, [workingDirectory]);

  // 远程项目没有文件监听：会话回合结束（running → 非 running）时刷新一次文件树，反映 claude 刚改动的文件
  const activeSessionStatus = useActiveTab((t) => t.sessionStatus);
  const prevSessionStatusRef = useRef(activeSessionStatus);
  useEffect(() => {
    const was = prevSessionStatusRef.current;
    prevSessionStatusRef.current = activeSessionStatus;
    if (was !== 'running' || activeSessionStatus === 'running') return;
    const dir = useSettingsStore.getState().workingDirectory;
    if (isRemotePath(dir)) useFileStore.getState().refreshTree(dir);
  }, [activeSessionStatus]);

  // 启动时保证当前环境与工作目录一致（本地环境不应指向 ssh://，远程环境不应指向本机路径）
  useEffect(() => {
    const { activeEnv, workingDirectory: dir, setWorkingDirectory } = useSettingsStore.getState();
    if (isRemotePath(dir) !== (activeEnv !== 'local')) setWorkingDirectory('');
  }, []);

  // Listen for file change events from the watcher
  // Debounce tree refresh for created/removed events (structure changes)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unlisten = onFileChange((event) => {
      // Defense-in-depth: skip paths under noisy directories (also filtered in Rust)
      const filtered = event.paths.filter((p) =>
        !/(^|[/\\])(\.(claude|git)|node_modules|__pycache__)[/\\]/.test(p)
      );
      if (filtered.length === 0) return;

      for (const filePath of filtered) {
        markFileChanged(filePath, event.kind);
      }

      // When files are created or removed, the tree structure changes —
      // debounce a full tree reload (300ms to batch rapid changes)
      if (event.kind === 'created' || event.kind === 'removed') {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTree();
          refreshTimerRef.current = null;
        }, 300);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [markFileChanged, refreshTree]);

  return (
    <>
      <AppShell
        sidebar={<Sidebar />}
        main={<ChatPanel key={selectedSessionId || 'new'} />}
        secondary={<SecondaryPanel />}
      />
      <CommandPalette />
      <Overlays />
      <ImageLightbox />
      <Toast />
      <PullProgress />
      <FileLinkMenuHost />
    </>
  );
}

export default App;
