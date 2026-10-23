/**
 * 计算某个会话实际的上下文窗口（上下文占用条、运行中提示、自动压缩阈值共用）。
 */
import { CLI_DEFAULT, getContextWindowForModel, useSettingsStore, type ContextWindowMode } from '../stores/settingsStore';
import type { SessionMeta } from '../stores/chatStore';
import { resolveModelForProvider } from './api-provider';
import { getContextUsedTokens } from './context-usage';

export interface SessionContextWindow {
  /** 用于判断窗口的模型 */
  model: string;
  /** 用于计算自动压缩阈值的窗口模式 */
  mode: ContextWindowMode;
  /** 窗口大小（tokens） */
  window: number;
}

/**
 * 1. 模型优先用 CLI 实际报告的 `sessionMeta.model`（init 事件或会话 JSONL 里的真实模型），
 *    其次是启动进程时的模型、会话快照的模型，最后才是当前选中的模型——
 *    会话可能被 CLI 设置或会话内的 /model 换成了别的模型，选中的模型不一定是实际在用的。
 *    选中「CLI 默认」且 CLI 还没上报时（新会话发第一条消息前），用 CLI 上次上报的模型估算。
 * 2. 已用量超过按模型算出的窗口时，说明实际窗口更大（200K 的会话不可能用到 200K 以上），
 *    改按 1M 计算，避免显示成 100% 并误触发自动压缩。
 */
export function resolveSessionContextWindow(
  meta: SessionMeta,
  selectedModel: string,
  contextWindowMode: ContextWindowMode,
): SessionContextWindow {
  // “CLI 默认”不是真实模型名，跳过，等 CLI 的 init 事件报告实际模型
  const real = (m?: string) => (m && m !== CLI_DEFAULT ? m : undefined);
  const model = real(meta.model)
    || real(meta.spawnedModel)
    || real(meta.snapshotModel)
    || real(resolveModelForProvider(selectedModel))
    || (selectedModel === CLI_DEFAULT ? real(useSettingsStore.getState().lastCliModel) : undefined)
    || '';
  const mode = meta.snapshotContextWindowMode ?? contextWindowMode;
  const window = getContextWindowForModel(model, mode);
  if (getContextUsedTokens(meta) > window) {
    return { model, mode: 'large1m', window: getContextWindowForModel(model, 'large1m') };
  }
  return { model, mode, window };
}
