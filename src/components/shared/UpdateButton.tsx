import { useUpdateStore } from '../../stores/updateStore';
import { useT } from '../../lib/i18n';

/**
 * 顶栏的应用更新按钮，只在有新版本后显示。
 * 可应用内更新时：点击下载 → 下载完成后点击安装并重启；否则点击打开发布页手动下载。
 */
export function UpdateButton() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const canSelfUpdate = useUpdateStore((s) => s.canSelfUpdate);
  const t = useT();

  if (phase !== 'available' && phase !== 'downloading' && phase !== 'ready' && phase !== 'installing') {
    return null;
  }

  const handleClick = () => {
    const store = useUpdateStore.getState();
    if (phase === 'available') {
      if (canSelfUpdate) store.download();
      else store.openReleasePage();
    } else if (phase === 'ready') {
      store.install(t);
    }
  };

  const busy = phase === 'downloading' || phase === 'installing';
  const title =
    phase === 'ready' ? t('update.readyRestart')
    : phase === 'downloading' ? `${t('update.downloading')} ${progress}%`
    : phase === 'installing' ? t('update.installing')
    : canSelfUpdate ? `${t('update.available')} v${version}`
    : `${t('update.available')} v${version}，${t('update.portableHint')}`;

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium
        transition-smooth mr-1
        ${phase === 'ready'
          ? 'bg-success/15 text-success border border-success/30 hover:bg-success/25'
          : busy
            ? 'bg-accent/10 text-accent cursor-wait'
            : 'bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20'
        }`}
      title={title}
    >
      {busy ? (
        <>
          <div className="w-3 h-3 border-[1.5px] border-accent/30
            border-t-accent rounded-full animate-spin" />
          <span>{phase === 'downloading' ? `${progress}%` : t('update.installing')}</span>
        </>
      ) : phase === 'ready' ? (
        <>
          {/* 对勾图标 */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6l2.5 2.5 4.5-4.5" />
          </svg>
          <span>{t('update.installRestart')}</span>
        </>
      ) : (
        <>
          {/* 下载图标 */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 2v6M3.5 5.5L6 8l2.5-2.5M2 10h8" />
          </svg>
          <span>v{version}</span>
        </>
      )}
    </button>
  );
}
