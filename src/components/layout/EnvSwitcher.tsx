import { useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { LOCAL_ENV, remoteUri, switchEnv } from '../../lib/remote';
import { useT } from '../../lib/i18n';

/** 侧栏顶部的环境切换：本地 / 各远程主机。没有配置远程主机时不显示 */
export function EnvSwitcher() {
  const t = useT();
  const hosts = useSessionStore((s) => s.remoteHosts);
  const isRemoteLoading = useSessionStore((s) => s.isRemoteLoading);
  const fetchRemoteSessions = useSessionStore((s) => s.fetchRemoteSessions);
  const activeEnv = useSettingsStore((s) => s.activeEnv);

  if (hosts.length === 0) return null;
  const isRemote = activeEnv !== LOCAL_ENV;
  const options = [{ id: LOCAL_ENV, label: t('env.local') }, ...hosts.map((h) => ({ id: h.id, label: h.id }))];

  return (
    <div className="px-3 mb-3">
      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-bg-secondary border border-border-subtle">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => switchEnv(o.id)}
            className={`flex-1 min-w-0 truncate px-2 py-1 rounded-lg text-xs transition-smooth
              ${activeEnv === o.id
                ? 'bg-accent text-text-inverse font-medium'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary'}`}
            title={o.label}
          >
            {o.label}
          </button>
        ))}
      </div>
      {isRemote && (
        <div className="mt-2 flex items-center justify-between px-2.5 py-1.5 rounded-lg
          border border-accent/40 bg-accent/10 text-xs text-accent">
          <span className="truncate">{t('env.remoteMode')} · {activeEnv}</span>
          <button
            onClick={() => fetchRemoteSessions()}
            disabled={isRemoteLoading}
            className="ml-2 flex-shrink-0 opacity-80 hover:opacity-100 disabled:opacity-40"
            title={t('env.refresh')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className={isRemoteLoading ? 'animate-spin' : ''}>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/** 远程环境下输入远端项目目录并打开；onOpen 收到完整的 ssh:// URI */
export function RemotePathInput({ hostId, onOpen }: { hostId: string; onOpen: (uri: string) => void }) {
  const t = useT();
  const [value, setValue] = useState('');
  const submit = () => {
    const uri = remoteUri(hostId, value);
    if (!uri) return;
    onOpen(uri);
    setValue('');
  };
  return (
    <div className="flex items-center gap-2 w-full">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={t('remote.pathPlaceholder')}
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded border border-border-subtle bg-bg-secondary
          text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
      />
      <button
        onClick={submit}
        disabled={!value.trim()}
        className="px-2.5 py-1.5 rounded border border-border-subtle text-xs text-text-muted
          hover:bg-bg-secondary hover:text-text-primary transition-smooth disabled:opacity-50"
      >
        {t('env.open')}
      </button>
    </div>
  );
}
