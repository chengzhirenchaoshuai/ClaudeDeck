// 聊天区通用的显示格式化：模型名、token 数、耗时。
import { MODEL_OPTIONS } from '../../stores/settingsStore';
import { displayProviderModelName } from '../../lib/deepseek-models';

/** Map raw model ID to friendly display name */
export function getModelDisplayName(modelId: string): string {
  const option = MODEL_OPTIONS.find((m) => modelId === m.id);
  return option?.short || displayProviderModelName(modelId);
}

/** Format token count: "3.2k" for >=1000, raw number for <1000 */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format elapsed seconds into "Xm Ys" or "Xs" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
