import { create } from 'zustand';

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
  /** 用 statusLine 钩子写下来的原始数据（two windows，字段可能各自缺失）更新缓存。
   *  全局共享、不挂在某个会话 tab 下——5h/7d 用量本来就是账户级别的，不是会话级别的，
   *  哪个窗口打开时刷出新数据都应该让所有地方看到同一份最新结果；同时落一份到
   *  localStorage，下次打开应用能立刻显示上次已知的值，不用等第一次轮询回来。 */
  setFromHook: (data: {
    five_hour?: { used_percentage: number; resets_at: number };
    seven_day?: { used_percentage: number; resets_at: number };
  }) => void;
}

export const useRateLimitsStore = create<RateLimitsState>((set, get) => ({
  ...loadCached(),
  setFromHook: (data) => {
    const next: CachedShape = {
      fiveHour: data.five_hour
        ? { usedPercentage: data.five_hour.used_percentage, resetsAt: data.five_hour.resets_at }
        : get().fiveHour,
      sevenDay: data.seven_day
        ? { usedPercentage: data.seven_day.used_percentage, resetsAt: data.seven_day.resets_at }
        : get().sevenDay,
    };
    set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时只影响下次启动是否有缓存可用，不影响本次运行
    }
  },
}));
