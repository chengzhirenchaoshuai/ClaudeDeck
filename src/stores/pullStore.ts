import { create } from 'zustand';

/** 拖出窗口时松开太快、还在后台拉取的远程文件 */
export interface PullItem {
  id: number;
  name: string;
  /** 识别出的目标文件夹；null 表示下载完成后由用户选择保存位置 */
  target: string | null;
  received: number;
  /** 远端文件大小，0 表示还不知道 */
  total: number;
  downloaded: boolean;
  /** 已保存到的完整路径 */
  savedTo: string | null;
  error: string | null;
  /** 已弹出过保存对话框（目标未知时只弹一次） */
  savePrompted: boolean;
}

interface PullState {
  pulls: PullItem[];
  addPull: (id: number, name: string, target: string | null) => void;
  updatePull: (id: number, patch: Partial<PullItem>) => void;
  removePull: (id: number) => void;
}

export const usePullStore = create<PullState>()((set) => ({
  pulls: [],
  addPull: (id, name, target) =>
    set((s) => ({
      pulls: [...s.pulls, {
        id, name, target, received: 0, total: 0, downloaded: false,
        savedTo: null, error: null, savePrompted: false,
      }],
    })),
  updatePull: (id, patch) =>
    set((s) => ({ pulls: s.pulls.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  removePull: (id) => set((s) => ({ pulls: s.pulls.filter((p) => p.id !== id) })),
}));
