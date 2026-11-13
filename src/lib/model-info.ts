// 模型说明的数据来源：供 components/shared/ModelInfoCard 渲染成说明卡片。
// 内容全是客观参数，来源是已安装 CLI（2.1.319）内置的模型目录与 usage.ts 的内置价格表，
// 只有「系列定位」那一句是概括性描述。
import {
  LATEST_MODELS,
  MODEL_OPTIONS,
  MODEL_TIER_MAP,
  getContextWindowForModel,
  useSettingsStore,
} from '../stores/settingsStore';
import { priceFor } from './usage';

/** 200000 → 200K，1000000 → 1M，64000 → 64K */
export function formatTokens(n: number): string {
  return n >= 1_000_000 && n % 100_000 === 0 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
}

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku';

/** 模型所属系列。Fable 在档位映射里算 opus 档，这里要单独认出来 */
export function modelFamily(id: string): ModelFamily | null {
  if (id.startsWith('claude-fable')) return 'fable';
  return MODEL_TIER_MAP[id] ?? null;
}

/** 价格数字去掉多余的 0：4 → 4，0.1 → 0.1 */
function formatPrice(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** 模型的结构化说明，供带样式的说明卡片渲染 */
export interface ModelInfo {
  label: string;
  /** 系列定位的概括描述 */
  familyDesc: string;
  /** 是不是本系列的当前代 */
  isLatest: boolean;
  /** 上下文窗口（token） */
  context: number;
  /** 单次输出上限（token） */
  maxOutput: number;
  /** 知识截止，YYYY-MM */
  cutoff: string;
  price?: { input: string; output: string; currency: string; custom: boolean };
}

/**
 * 官方模型的结构化说明。未收录的模型（第三方服务商的自定义模型等）返回 null，
 * 调用方自行决定要不要显示。
 */
export function modelInfo(id: string, t: (key: string) => string): ModelInfo | null {
  const option = MODEL_OPTIONS.find((m) => m.id === id);
  if (!option) return null;

  const family = modelFamily(id);
  const hit = priceFor(id, useSettingsStore.getState().customModelPrices);

  return {
    label: option.label,
    familyDesc: family ? t(`model.family.${family}`) : '',
    isLatest: LATEST_MODELS.has(id),
    context: getContextWindowForModel(id, 'default'),
    maxOutput: option.maxOutput,
    cutoff: option.cutoff,
    price: hit
      ? {
        input: formatPrice(hit.price.input),
        output: formatPrice(hit.price.output),
        currency: hit.price.currency,
        custom: hit.source === 'custom',
      }
      : undefined,
  };
}

/** 「CLI 默认」选项的说明：没指定模型，用 CLI 自己配置的那个 */
export function cliDefaultTooltip(t: (key: string) => string): string {
  const lastCliModel = useSettingsStore.getState().lastCliModel;
  const lines = [t('model.tip.cliDefault')];
  if (lastCliModel) lines.push(t('model.tip.cliDefaultLast').replace('{model}', lastCliModel));
  return lines.join('\n');
}

/** 经服务商映射的选项说明：实际跑的是服务商的模型，官方参数不适用 */
export function mappedTooltip(providerModel: string, t: (key: string) => string): string {
  return t('model.tip.mapped').replace('{model}', providerModel);
}
