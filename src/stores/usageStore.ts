import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import type { UsageRow, UsageStats } from '../lib/usage';
import { useProviderStore } from './providerStore';

export interface ProviderBalance {
  isAvailable: boolean;
  balances: { currency: string; total: string; granted: string; toppedUp: string }[];
}

/** 某台远程主机的用量（按需读取并缓存，读取很慢） */
export interface RemoteUsage {
  rows: UsageRow[];
  sessionCount: number;
  loading: boolean;
  error: string;
  fetchedAt: number;
}

const REMOTE_TTL = 30 * 60 * 1000;

interface UsageState {
  stats: UsageStats | null;
  /** 各远程主机的用量，键为主机 id */
  remote: Record<string, RemoteUsage>;
  loading: boolean;
  error: string;
  lastFetched: number;
  balance: ProviderBalance | null;
  balanceError: string;
  balanceLoading: boolean;
  /** 刷新用量；force 为 false 时 30 秒内不重复读取 */
  refresh: (force?: boolean) => Promise<void>;
  refreshBalance: () => Promise<void>;
  /** 读取某台远程主机的用量；未 force 时 30 分钟内不重复读取 */
  refreshRemote: (hostId: string, force?: boolean) => Promise<void>;
  /** 读取全部已配置远程主机的用量，并清掉已被删除的主机 */
  refreshAllRemote: (force?: boolean) => Promise<void>;
}

/** 当前供应商是否支持余额查询（目前仅 DeepSeek 官方主机） */
export function activeProviderSupportsBalance(): boolean {
  const provider = useProviderStore.getState().getActive();
  if (!provider) return false;
  try {
    const host = new URL(provider.baseUrl).hostname;
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

export const useUsageStore = create<UsageState>()((set, get) => ({
  stats: null,
  remote: {},
  loading: false,
  error: '',
  lastFetched: 0,
  balance: null,
  balanceError: '',
  balanceLoading: false,

  refresh: async (force = false) => {
    const { loading, lastFetched } = get();
    if (loading || (!force && Date.now() - lastFetched < 30_000)) return;
    set({ loading: true, error: '' });
    try {
      const stats = await bridge.getUsageStats();
      set({ stats, loading: false, lastFetched: Date.now() });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  refreshRemote: async (hostId, force = false) => {
    const current = get().remote[hostId];
    if (current?.loading) return;
    if (!force && current && !current.error && Date.now() - current.fetchedAt < REMOTE_TTL) return;
    const base: RemoteUsage = current ?? { rows: [], sessionCount: 0, loading: false, error: '', fetchedAt: 0 };
    set((state) => ({ remote: { ...state.remote, [hostId]: { ...base, loading: true, error: '' } } }));
    try {
      const result = await bridge.getRemoteUsage(hostId);
      set((state) => ({
        remote: {
          ...state.remote,
          [hostId]: { rows: result.rows, sessionCount: result.sessionCount, loading: false, error: '', fetchedAt: Date.now() },
        },
      }));
    } catch (e) {
      set((state) => ({
        remote: { ...state.remote, [hostId]: { ...base, loading: false, error: String(e) } },
      }));
    }
  },

  refreshAllRemote: async (force = false) => {
    let hosts: { id: string }[] = [];
    try {
      hosts = await bridge.listRemoteHosts();
    } catch {
      return;
    }
    const ids = new Set(hosts.map((h) => h.id));
    set((state) => ({
      remote: Object.fromEntries(Object.entries(state.remote).filter(([id]) => ids.has(id))),
    }));
    await Promise.allSettled(hosts.map((h) => get().refreshRemote(h.id, force)));
  },

  refreshBalance: async () => {
    const provider = useProviderStore.getState().getActive();
    if (!provider || !activeProviderSupportsBalance()) {
      set({ balance: null, balanceError: '' });
      return;
    }
    if (get().balanceLoading) return;
    set({ balanceLoading: true, balanceError: '' });
    try {
      const balance = await bridge.getProviderBalance(provider.id);
      set({ balance, balanceLoading: false });
    } catch (e) {
      set({ balanceLoading: false, balanceError: String(e), balance: null });
    }
  },
}));
