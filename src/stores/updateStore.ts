import { create } from 'zustand';
import type { Update } from '@tauri-apps/plugin-updater';
import { bridge } from '../lib/tauri-bridge';
import { confirmAndShutdownSessions } from '../lib/app-quit';

/** 应用更新流程：检查 → 有新版 → 下载 → 下载完成 → 安装（程序退出后自动打开新版本） */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

/** msi：运行安装包更新；portable：替换 exe 自身；dev：开发版不做应用内更新 */
type UpdateMode = 'msi' | 'portable' | 'dev';

/** 无法应用内更新时（开发版、发布缺少免安装版条目），引导到这里手动下载 */
export const RELEASES_URL = 'https://github.com/chengzhirenchaoshuai/ClaudeDeck/releases/latest';

/** latest.json 中免安装版的条目名，由 scripts/collect-release.mjs 写入 */
const PORTABLE_PLATFORM = 'windows-x86_64-portable';

// 更新插件返回的句柄，不可序列化，放在 store 外
let handle: Update | null = null;
let mode: UpdateMode = 'dev';
// 免安装版的新 exe 下载地址与签名，取自 latest.json
let portableAsset: { url: string; signature: string } | null = null;

function readPortableAsset(update: Update): { url: string; signature: string } | null {
  const platforms = update.rawJson.platforms as Record<string, { url?: unknown; signature?: unknown }> | undefined;
  const entry = platforms?.[PORTABLE_PLATFORM];
  return typeof entry?.url === 'string' && typeof entry?.signature === 'string'
    ? { url: entry.url, signature: entry.signature }
    : null;
}

interface UpdateState {
  phase: UpdatePhase;
  /** 新版本号 */
  version: string;
  /** 下载进度 0-100 */
  progress: number;
  error: string;
  /** 能在应用内下载安装；否则只能打开发布页手动下载 */
  canSelfUpdate: boolean;

  /** 检查更新。manual 为 false 时（启动、定时检查）失败不提示，也不显示“已是最新” */
  check: (manual: boolean) => Promise<void>;
  download: () => Promise<void>;
  /** 安装前确认并结束运行中的会话；成功后程序会退出并打开新版本 */
  install: (t: (key: string) => string) => Promise<void>;
  openReleasePage: () => void;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  phase: 'idle',
  version: '',
  progress: 0,
  error: '',
  canSelfUpdate: false,

  check: async (manual) => {
    // 正在下载或已下载时不重复检查，避免丢掉已下载的更新
    const busy: UpdatePhase[] = ['checking', 'downloading', 'ready', 'installing'];
    if (busy.includes(get().phase)) return;
    set({ phase: 'checking', error: '' });
    try {
      const env = await bridge.getUpdateEnv();
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check(env.proxy ? { proxy: env.proxy } : undefined);
      await handle?.close().catch(() => {});
      handle = update;
      mode = env.mode;
      portableAsset = update && mode === 'portable' ? readPortableAsset(update) : null;
      const canSelfUpdate = mode === 'msi' || (mode === 'portable' && portableAsset !== null);
      if (update) {
        set({ phase: 'available', version: update.version, canSelfUpdate });
      } else {
        set({ phase: manual ? 'latest' : 'idle', version: '', canSelfUpdate });
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
    if (!handle || get().phase !== 'available' || !get().canSelfUpdate) return;
    set({ phase: 'downloading', progress: 0, error: '' });
    const report = (received: number, total: number) => {
      if (total > 0) set({ progress: Math.min(100, Math.round((received / total) * 100)) });
    };
    try {
      if (mode === 'portable' && portableAsset) {
        await bridge.downloadPortableUpdate(portableAsset.url, portableAsset.signature,
          ({ downloaded, total }) => report(downloaded, total));
      } else {
        let total = 0;
        let received = 0;
        await handle.download((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
          } else if (event.event === 'Progress') {
            received += event.data.chunkLength;
            report(received, total);
          }
        });
      }
      set({ phase: 'ready', progress: 100 });
    } catch (e) {
      set({ phase: 'error', error: String(e) });
    }
  },

  install: async (t) => {
    if (!handle || get().phase !== 'ready') return;
    if (!(await confirmAndShutdownSessions(t, 'update.confirmRunning'))) return;
    set({ phase: 'installing' });
    try {
      // 两种方式成功后本程序都会立即退出：MSI 启动 msiexec，免安装版替换 exe 后启动新进程
      if (mode === 'portable') await bridge.applyPortableUpdate();
      else await handle.install();
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
