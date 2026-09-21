import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import type { UsageStats } from '../lib/usage';
import { useProviderStore } from './providerStore';

export interface ProviderBalance {
  isAvailable: boolean;
  balances: { currency: string; total: string; granted: string; toppedUp: string }[];
}

interface UsageState {
  stats: UsageStats | null;
  loading: boolean;
  error: string;
  lastFetched: number;
  balance: ProviderBalance | null;
  balanceError: string;
  balanceLoading: boolean;
  /** 刷新用量；force 为 false 时 30 秒内不重复读取 */
  refresh: (force?: boolean) => Promise<void>;
  refreshBalance: () => Promise<void>;
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
