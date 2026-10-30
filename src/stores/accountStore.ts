import { create } from 'zustand';
import { bridge, type ClaudeAccount } from '../lib/tauri-bridge';

/** 窗口反复切换焦点时，这段时间内不重复运行 claude auth status */
const REFRESH_INTERVAL_MS = 5000;

interface AccountState {
  /** 本机 CLI 的登录信息；null 表示还没查到或查询失败（找不到 CLI 等） */
  account: ClaudeAccount | null;
  /** force：用户手动检查时不受时间间隔限制 */
  refresh: (force?: boolean) => Promise<void>;
}

let inFlight: Promise<void> | null = null;
let lastRefreshAt = 0;

export const useAccountStore = create<AccountState>((set) => ({
  account: null,
  refresh: (force = false) => {
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return Promise.resolve();
    lastRefreshAt = Date.now();
    inFlight = bridge.getClaudeAccount()
      .then((account) => set({ account }))
      .catch((err) => {
        console.warn('[ClaudeDeck] failed to read account:', err);
        set({ account: null });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },
}));
