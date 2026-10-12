import { create } from 'zustand';
import type { RateLimitInfo } from '../lib/stream-message';

/** 一个用量窗口（5 小时 / 7 天）的最新已知状态 */
export interface RateLimitWindow {
  usedPercentage?: number;
  resetsAt?: number;
}

interface CachedShape {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
}

const STORAGE_KEY = 'tokenicode_rate_limits';

function loadCached(): CachedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

interface RateLimitsState extends CachedShape {
  /** 用 stream-json 的 rate_limit_event 更新缓存。全局共享、不挂在某个会话 tab 下——
   *  5h/7d 用量本来就是账户级别的；哪个会话收到新事件都更新同一份，同时落一份到
   *  localStorage，下次打开应用先显示上次已知的值。某个窗口这次没带就保留上次的。 */
  setFromEvent: (info: RateLimitInfo) => void;
}

function toWindow(w?: { utilization?: number; resetsAt?: number }): RateLimitWindow | undefined {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return undefined;
  return { usedPercentage: w.utilization * 100, resetsAt: w.resetsAt };
}

export const useRateLimitsStore = create<RateLimitsState>((set, get) => ({
  ...loadCached(),
  setFromEvent: (info) => {
    const windows = { ...info.unifiedWindows };
    // 旧版 CLI 没有 unifiedWindows，只在顶层带当前触发事件的那个窗口
    if (info.rateLimitType && !windows[info.rateLimitType]) {
      windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
    }
    const prev = get();
    const next: CachedShape = {
      fiveHour: toWindow(windows.five_hour) ?? prev.fiveHour,
      sevenDay: toWindow(windows.seven_day) ?? prev.sevenDay,
    };
    set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用只影响下次启动是否有缓存，不影响本次运行
    }
  },
}));
