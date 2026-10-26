import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUpdateStore } from '../../stores/updateStore';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { ChangelogModal } from '../shared/ChangelogModal';
import { isPermissionError, isNetworkError } from './settingsUtils';
import { GeneralTab } from './GeneralTab';
import { InterfaceTab } from './InterfaceTab';
import { ProviderTab } from './ProviderTab';
import { CliTab } from './CliTab';
import { McpTab } from './McpTab';
import { LocalModelsTab } from './LocalModelsTab';
import { RemoteTab } from './RemoteTab';

type SettingsTab = 'general' | 'interface' | 'provider' | 'cli' | 'localModels' | 'mcp' | 'remote';

const TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  general: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  ),
  interface: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M5.5 6v7.5" />
    </svg>
  ),
  provider: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 016 0v2" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
    </svg>
  ),
  cli: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <path d="M4 6l3 2.5L4 11M9 11h3" />
    </svg>
  ),
  localModels: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6h6M5 9h3" />
      <circle cx="11" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  remote: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="8" rx="1.5" />
      <path d="M8 10v3M5 13.5h6" />
    </svg>
  ),
  mcp: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="1" y="3" width="14" height="4" rx="1.5" />
      <rect x="1" y="9" width="14" height="4" rx="1.5" />
      <circle cx="4" cy="5" r="0.75" fill="currentColor" />
      <circle cx="4" cy="11" r="0.75" fill="currentColor" />
    </svg>
  ),
};

const TAB_ITEMS: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'interface', labelKey: 'settings.tab.interface' },
  { id: 'provider', labelKey: 'settings.tab.provider' },
  { id: 'cli', labelKey: 'settings.tab.cli' },
  { id: 'localModels', labelKey: '本地模型' },
  { id: 'mcp', labelKey: 'settings.tab.mcp' },
  { id: 'remote', labelKey: 'settings.tab.remote' },
];

export function SettingsPanel() {
  const t = useT();
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSettings]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) toggleSettings(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-[min(90vw,960px)] h-[min(85vh,720px)] min-h-[440px]
        rounded-2xl bg-bg-card border border-border-subtle shadow-2xl
        overflow-hidden animate-fade-in flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4
          border-b border-border-subtle flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('settings.title')}
          </h2>
          <button onClick={toggleSettings}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary
              text-text-tertiary transition-smooth">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <nav className="w-[160px] border-r border-border-subtle px-2 py-4 space-y-1 flex-shrink-0">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[13px]
                  font-medium transition-smooth text-left whitespace-nowrap
                  ${activeTab === tab.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
                  }`}
              >
                <span className="flex-shrink-0 opacity-70">{TAB_ICONS[tab.id]}</span>
                {t(tab.labelKey)}
                {tab.id === 'cli' && useSettingsStore.getState().cliUpdateAvailable && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                )}
              </button>
            ))}
          </nav>

          {/* Content area */}
          {/* key 随页签变化：切换页签时内容区重新挂载，滚动位置回到顶部 */}
          <div key={activeTab} className="flex-1 overflow-y-auto px-8 py-6">
            {activeTab === 'general' && <GeneralTab />}
            {activeTab === 'interface' && <InterfaceTab />}
            {activeTab === 'provider' && <ProviderTab />}
            {activeTab === 'cli' && <CliTab />}
            {activeTab === 'localModels' && <LocalModelsTab />}
            {activeTab === 'mcp' && <McpTab />}
            {activeTab === 'remote' && <RemoteTab />}
          </div>
        </div>

        {/* Footer: version + update */}
        <SettingsFooter />
      </div>
    </div>
  );
}

/* ================================================================
   Footer with version + update controls
   ================================================================ */

function SettingsFooter() {
  const t = useT();
  const [appVersion, setAppVersion] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const errorMsg = useUpdateStore((s) => s.error);
  const installed = useUpdateStore((s) => s.installed);

  useEffect(() => {
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then(setAppVersion).catch(() => {})
    );
  }, []);

  const store = useUpdateStore.getState;
  const btnPrimary = `px-2.5 py-1 text-xs font-medium rounded-md
    bg-accent text-text-inverse hover:bg-accent-hover transition-smooth`;
  const spinner = (
    <span className="w-3 h-3 border-[1.5px] border-accent/30
      border-t-accent rounded-full animate-spin" />
  );

  return (
    <>
      <div className="flex items-center justify-between px-6 h-10
        border-t border-border-subtle bg-bg-secondary/30 flex-shrink-0">
        {/* 左侧：版本号 */}
        <span className="text-xs text-text-tertiary flex items-center gap-1.5">
          <svg width="11" height="11" viewBox="0 0 171 171" fill="none" className="flex-shrink-0 opacity-60">
            <path d="M66.79 58.73L40.33 85.19L66.79 111.66L57.53 120.92L21.8 85.19L57.53 49.47Z" fill="currentColor" />
            <path d="M111.5 49.47L147.22 85.19L111.5 120.92L102.24 111.66L128.7 85.19L102.24 58.73Z" fill="currentColor" />
            <path d="M90.01 39.92L102.01 39.92L79.24 129.92L67.24 129.92L79.24 81.92Z" className="fill-accent" />
          </svg>
          {APP_NAME} {appVersion ? `v${appVersion}` : '...'}
        </span>

        {/* 右侧：更新日志与应用更新 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChangelog(true)}
            className="px-2.5 py-1 text-xs font-medium rounded-md
              text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-smooth"
          >
            {t('settings.footer.changelog')}
          </button>

          {(phase === 'idle' || phase === 'latest') && (
            phase === 'latest' ? (
              <span className="text-xs text-green-500 font-medium">
                {t('settings.footer.upToDate')}
              </span>
            ) : (
              <button
                onClick={() => store().check(true)}
                className="px-2.5 py-1 text-xs font-medium rounded-md
                  text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-smooth"
              >
                {t('settings.footer.checkUpdate')}
              </button>
            )
          )}

          {phase === 'checking' && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              {spinner}
              {t('update.checking')}
            </span>
          )}

          {phase === 'available' && (
            installed ? (
              <button onClick={() => store().download()} className={btnPrimary}>
                {t('update.install')} v{version}
              </button>
            ) : (
              <button onClick={() => store().openReleasePage()} className={btnPrimary}
                title={t('update.portableHint')}>
                {t('update.openRelease')} v{version}
              </button>
            )
          )}

          {phase === 'downloading' && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              {spinner}
              {t('update.downloading')} {progress}%
            </span>
          )}

          {phase === 'ready' && (
            <button onClick={() => store().install(t)} className={btnPrimary}>
              {t('update.installRestart')}
            </button>
          )}

          {phase === 'installing' && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              {spinner}
              {t('update.installing')}
            </span>
          )}

          {phase === 'error' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500" title={errorMsg}>
                {t('update.error')}
              </span>
              {isPermissionError(errorMsg) && (
                <span className="text-[10px] text-amber-500">
                  {t('error.permissionHint')}
                </span>
              )}
              {isNetworkError(errorMsg) && (
                <span className="text-[10px] text-amber-500">
                  {t('network.firewallHint')}
                </span>
              )}
              <button
                onClick={() => store().check(true)}
                className="px-2 py-0.5 text-xs text-text-muted hover:text-text-primary transition-smooth"
              >
                {t('cli.retry')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 更新日志弹窗 */}
      {showChangelog && appVersion && (
        <ChangelogModal
          version={appVersion}
          onClose={() => setShowChangelog(false)}
        />
      )}
    </>
  );
}
