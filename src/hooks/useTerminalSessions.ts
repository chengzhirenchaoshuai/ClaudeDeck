import { useEffect } from 'react';
import { bridge, type TerminalSessionInfo, type TerminalSessionStatus } from '../lib/tauri-bridge';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { LOCAL_ENV } from '../lib/remote';

/** 本机只读几个小文件，轮询可以频繁一些 */
const LOCAL_INTERVAL_MS = 3000;
/** 远程每次都要建立 ssh 连接，间隔放长 */
const REMOTE_INTERVAL_MS = 10000;
/** 窗口隐藏（最小化、收到托盘）时远程进一步放慢；本机照常轮询，回复完成时任务栏角标仍能及时更新 */
const REMOTE_HIDDEN_INTERVAL_MS = 30000;

function toStatus(info: TerminalSessionInfo): TerminalSessionStatus {
  return info.status === 'busy' ? 'busy' : 'idle';
}

/**
 * 终端里直接运行的 claude 会话：定时读取 CLI 的进程状态文件（本机，以及当前所在的远程主机），
 * 写入 sessionStore.terminalSessions，供左侧会话列表显示“终端中运行”。
 * 读取失败时保留上次结果，不让指示器因一次失败而闪烁。
 */
export function useTerminalSessions(): void {
  useEffect(() => {
    let local: TerminalSessionInfo[] = [];
    let remote: TerminalSessionInfo[] = [];
    let remoteHost: string | null = null;
    let remoteBusy = false;
    let disposed = false;

    const publish = () => {
      if (disposed) return;
      const next = new Map<string, TerminalSessionStatus>();
      for (const info of [...local, ...remote]) next.set(info.sessionId, toStatus(info));
      useSessionStore.getState().setTerminalSessions(next);
    };

    const pollLocal = async () => {
      try {
        local = await bridge.listTerminalSessions();
        publish();
      } catch {
        // 保留上次结果
      }
    };

    const pollRemote = async () => {
      const env = useSettingsStore.getState().activeEnv;
      if (env === LOCAL_ENV) {
        if (remote.length > 0) { remote = []; publish(); }
        remoteHost = null;
        return;
      }
      if (remoteBusy) return;
      // 切换了远程主机：旧主机的结果作废
      if (remoteHost !== env) { remote = []; remoteHost = env; publish(); }
      remoteBusy = true;
      try {
        const result = await bridge.listRemoteTerminalSessions(env);
        if (useSettingsStore.getState().activeEnv === env) { remote = result; publish(); }
      } catch {
        // ssh 连接失败等：保留上次结果
      } finally {
        remoteBusy = false;
      }
    };

    // 远程按窗口可见性决定下一次的间隔，用 setTimeout 逐次排期
    let remoteTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRemote = () => {
      clearTimeout(remoteTimer);
      if (disposed) return;
      remoteTimer = setTimeout(async () => {
        await pollRemote();
        scheduleRemote();
      }, document.hidden ? REMOTE_HIDDEN_INTERVAL_MS : REMOTE_INTERVAL_MS);
    };
    const pollRemoteNow = () => {
      void pollRemote();
      scheduleRemote();
    };

    void pollLocal();
    pollRemoteNow();
    const localTimer = setInterval(pollLocal, LOCAL_INTERVAL_MS);
    // 切换环境时立即刷新一次，不必等下一个周期
    const unsubscribe = useSettingsStore.subscribe((state, prev) => {
      if (state.activeEnv !== prev.activeEnv) pollRemoteNow();
    });
    // 窗口重新显示时立即刷新，补上隐藏期间放慢的那部分
    const onVisibility = () => {
      if (!document.hidden) pollRemoteNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      clearInterval(localTimer);
      clearTimeout(remoteTimer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
