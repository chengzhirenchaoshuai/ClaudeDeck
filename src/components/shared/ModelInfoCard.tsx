// 模型说明卡片：鼠标悬停模型选择器时显示的浮层，取代样式无法控制的系统原生 tooltip。
// 只负责内容与外观，定位交给外层容器。
import { useT } from '../../lib/i18n';
import { formatTokens, modelInfo } from '../../lib/model-info';

/** 一行「字段名 —— 值」 */
function SpecRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-text-tertiary">{label}</span>
      <span className="text-right text-text-secondary">
        <span className="font-medium tabular-nums">{value}</span>
        {note && <span className="ml-1 text-text-tertiary">{note}</span>}
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-card px-3 py-2.5 shadow-lg
      animate-in fade-in duration-150">
      {children}
    </div>
  );
}

/**
 * modelId 是官方模型时显示结构化参数；否则（「CLI 默认」、服务商映射的模型）
 * 退回显示 fallbackText。两者都没有就不渲染。
 */
export function ModelInfoCard({ modelId, fallbackText }: { modelId: string; fallbackText?: string }) {
  const t = useT();
  const info = modelInfo(modelId, t);

  if (!info) {
    if (!fallbackText) return null;
    return (
      <Shell>
        <div className="whitespace-pre-line text-[11px] leading-relaxed text-text-secondary">
          {fallbackText}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-xs font-medium text-text-primary">{info.label}</span>
        {info.isLatest && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] leading-none text-accent">
            {t('model.latest')}
          </span>
        )}
      </div>

      {info.familyDesc && (
        <div className="mt-1 text-[11px] leading-relaxed text-text-tertiary">{info.familyDesc}</div>
      )}

      <div className="mt-2 space-y-1 border-t border-border-subtle pt-2 text-[11px]">
        <SpecRow label={t('model.spec.context')} value={formatTokens(info.context)} />
        <SpecRow label={t('model.spec.maxOutput')} value={formatTokens(info.maxOutput)} />
        <SpecRow label={t('model.spec.cutoff')} value={info.cutoff} />
        {info.price && (
          <SpecRow
            label={t('model.spec.price')}
            value={`${info.price.currency} ${info.price.input} / ${info.price.output}`}
            note={info.price.custom ? t('model.tip.priceCustom') : t('model.spec.priceUnit')}
          />
        )}
        {info.price && (
          <div className="text-right text-[10px] text-text-tertiary">{t('model.spec.priceInOut')}</div>
        )}
      </div>
    </Shell>
  );
}
