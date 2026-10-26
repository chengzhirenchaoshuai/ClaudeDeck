import { create } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { bridge } from '../lib/tauri-bridge';
import { confirmAndShutdownSessions } from '../lib/app-quit';

/** 应用更新流程：检查 → 有新版 → 下载 → 下载完成 → 安装（程序退出，MSI 装完后自动重新打开） */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

/** 免安装版、开发版无法应用内安装，引导到这里手动下载 */
export const RELEASES_URL = 'https://github.com/chengzhirenchaoshuai/ClaudeDeck/releases/latest';

// 更新插件返回的句柄，不可序列化，放在 store 外
let handle: Update | null = null;

interface UpdateState {
  phase: UpdatePhase;
  /** 新版本号 */
  version: string;
  /** 下载进度 0-100 */
  progress: number;
  error: string;
  /** 当前为 MSI 安装版，可以应用内下载安装 */
  installed: boolean;

  /** 检查更新。manual 为 false 时（启动、定时检查）失败不提示，也不显示“已是最新” */
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  /** 安装前确认并结束运行中的会话；成功后程序会直接退出 */
  install: (t: (key: string) => string) => Promise<void>;
  openReleasePage: () => void;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  phase: 'idle',
  version: '',
  progress: 0,
  error: '',
  installed: false,

  check: async (manual) => {
    // 正在下载或已下载时不重复检查，避免丢掉已下载的安装包
    const busy: UpdatePhase[] = ['checking', 'downloading', 'ready', 'installing'];
    if (busy.includes(get().phase)) return;
    set({ phase: 'checking', error: '' });
    try {
      const env = await bridge.getUpdateEnv();
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check(env.proxy ? { proxy: env.proxy } : undefined);
      await handle?.close().catch(() => {});
      handle = update;
      if (update) {
        set({ phase: 'available', version: update.version, installed: env.installed });
      } else {
        set({ phase: manual ? 'latest' : 'idle', version: '', installed: env.installed });
        if (manual) {
          setTimeout(() => {
            if (get().phase === 'latest') set({ phase: 'idle' });
          }, 3000);
        }
      }
    } catch (e) {
      set({ phase: manual ? 'error' : 'idle', error: String(e) });
    }
  },

  download: async () => {
    if (!handle || get().phase !== 'available') return;
    set({ phase: 'downloading', progress: 0, error: '' });
    let total = 0;
    let received = 0;
    try {
      await handle.download((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(100, Math.round((received / total) * 100)) });
        } else if (event.event === 'Finished') {
          set({ progress: 100 });
        }
      });
      set({ phase: 'ready' });
    } catch (e) {
      set({ phase: 'error', error: String(e) });
    }
  },

  install: async (t) => {
    if (!handle || get().phase !== 'ready') return;
    if (!(await confirmAndShutdownSessions(t, 'update.confirmRunning'))) return;
    set({ phase: 'installing' });
    try {
      // Windows 上这一步会启动 msiexec 并立即退出本程序
      await handle.install();
    } catch (e) {
      set({ phase: 'error', error: String(e) });
    }
  },

  openReleasePage: () => {
    import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(RELEASES_URL))
      .catch(() => {});
  },
}));
