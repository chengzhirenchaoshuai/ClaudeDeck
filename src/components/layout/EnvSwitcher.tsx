import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { LOCAL_ENV, remoteUri, switchEnv } from '../../lib/remote';
import { useT } from '../../lib/i18n';

/** 侧栏顶部的环境切换：本地 / 各远程主机。没有配置远程主机时不显示 */
export function EnvSwitcher() {
  const t = useT();
  const hosts = useSessionStore((s) => s.remoteHosts);
  const activeEnv = useSettingsStore((s) => s.activeEnv);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 下拉展开时，点击外部或按 Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (hosts.length === 0) return null;
  const isRemote = activeEnv !== LOCAL_ENV;
  const options = [
    { id: LOCAL_ENV, label: t('env.local') },
    ...hosts.map((h) => ({ id: h.id, label: `${t('env.remoteMode')} · ${h.id}` })),
  ];
  const current = options.find((o) => o.id === activeEnv) ?? options[0];

  return (
    <div className="px-3 mb-3">
      <div ref={boxRef} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs
            bg-bg-secondary border transition-smooth
            ${open ? 'border-accent' : 'border-border-subtle hover:border-border-default'}`}
          title={current.label}
        >
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isRemote ? 'bg-accent' : 'bg-success'}`} />
          <span className="flex-1 min-w-0 truncate text-left text-text-primary">{current.label}</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className={`flex-shrink-0 text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`}>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 p-1 rounded-xl
            bg-bg-secondary border border-border-subtle shadow-lg max-h-64 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => { setOpen(false); if (o.id !== activeEnv) switchEnv(o.id); }}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-left transition-smooth
                  ${activeEnv === o.id
                    ? 'bg-accent/15 text-accent font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary'}`}
                title={o.label}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${o.id === LOCAL_ENV ? 'bg-success' : 'bg-accent'}`} />
                <span className="flex-1 min-w-0 truncate">{o.label}</span>
                {activeEnv === o.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
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
