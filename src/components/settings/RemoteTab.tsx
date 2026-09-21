import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../../lib/tauri-bridge';
import type { RemoteHost, RemoteTestResult, RemoteConfig } from '../../lib/tauri-bridge';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { startRemoteProject } from '../../lib/remote';
import { useT } from '../../lib/i18n';

const INPUT_CLS = `w-full px-2.5 py-1.5 rounded border border-border-subtle bg-bg-secondary
  text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent`;
const BTN_CLS = `px-2.5 py-1.5 rounded border border-border-subtle text-xs text-text-muted
  hover:bg-bg-secondary hover:text-text-primary transition-smooth disabled:opacity-50 disabled:cursor-not-allowed`;

const EMPTY_FORM = { id: '', destination: '', port: '', identityFile: '' };

/** 切换到该主机（远程模式），在指定远端目录新建对话，并关闭设置面板 */
function startRemoteDraft(hostId: string, remotePath: string) {
  startRemoteProject(hostId, remotePath);
  useSettingsStore.getState().toggleSettings();
}

export function RemoteTab() {
  const t = useT();
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [sshAliases, setSshAliases] = useState<string[]>([]);
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [formError, setFormError] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, RemoteTestResult | string>>({});
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [configs, setConfigs] = useState<Record<string, RemoteConfig | string>>({});
  const [readingConfig, setReadingConfig] = useState<string | null>(null);

  const remoteErrors = useSessionStore((s) => s.remoteErrors);
  const isRemoteLoading = useSessionStore((s) => s.isRemoteLoading);
  const fetchRemoteSessions = useSessionStore((s) => s.fetchRemoteSessions);

  const loadHosts = useCallback(async () => {
    setHosts(await bridge.listRemoteHosts().catch(() => []));
  }, []);

  useEffect(() => {
    loadHosts();
    bridge.listSshConfigHosts().then(setSshAliases).catch(() => {});
  }, [loadHosts]);

  const handleSave = async () => {
    if (!form) return;
    const port = form.port.trim() ? Number(form.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setFormError('端口无效');
      return;
    }
    try {
      await bridge.saveRemoteHost({
        id: form.id.trim(),
        destination: form.destination.trim(),
        port,
        identityFile: form.identityFile.trim() || null,
      });
      setForm(null);
      setFormError('');
      await loadHosts();
      fetchRemoteSessions();
    } catch (e) {
      setFormError(String(e));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('remote.confirmDelete'))) return;
    await bridge.deleteRemoteHost(id).catch(() => {});
    await loadHosts();
    fetchRemoteSessions();
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await bridge.testRemoteConnection(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [id]: String(e) }));
    } finally {
      setTesting(null);
    }
  };

  const handleReadConfig = async (id: string) => {
    setReadingConfig(id);
    try {
      const config = await bridge.readRemoteConfig(id);
      setConfigs((prev) => ({ ...prev, [id]: config }));
    } catch (e) {
      setConfigs((prev) => ({ ...prev, [id]: String(e) }));
    } finally {
      setReadingConfig(null);
    }
  };

  const renderConfig = (config: RemoteConfig) => (
    <div className="mt-2 space-y-2 text-xs text-text-muted">
      <div>{config.configDir}</div>
      <div>
        <div className="text-text-secondary">{t('remote.configMcp')}</div>
        {config.mcpServers.length === 0
          ? t('remote.none')
          : config.mcpServers.map((m) => (
              <div key={m.name}>{m.name}（{m.type || 'stdio'}）{m.command || m.url}</div>
            ))}
      </div>
      <div>
        <div className="text-text-secondary">{t('remote.configSkills')}</div>
        {config.skills.length ? config.skills.join('、') : t('remote.none')}
      </div>
      <div>
        <div className="text-text-secondary">{t('remote.configCommands')}</div>
        {config.commands.length ? config.commands.join('、') : t('remote.none')}
      </div>
      <div>
        <div className="text-text-secondary">{t('remote.configSettings')}</div>
        <pre className="mt-1 p-2 rounded bg-bg-secondary overflow-auto max-h-48 whitespace-pre-wrap">
          {config.settings ? JSON.stringify(config.settings, null, 2) : t('remote.none')}
        </pre>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] font-medium text-text-primary">{t('remote.title')}</h3>
        <p className="mt-1 text-xs text-text-tertiary">{t('remote.desc')}</p>
      </div>

      <div className="flex items-center gap-2">
        <button className={BTN_CLS} onClick={() => { setForm({ ...EMPTY_FORM }); setFormError(''); }}>
          {t('remote.add')}
        </button>
        <button className={BTN_CLS} disabled={isRemoteLoading} onClick={() => fetchRemoteSessions()}>
          {isRemoteLoading ? t('remote.refreshing') : t('remote.refresh')}
        </button>
      </div>

      {form && (
        <div className="p-3 rounded-lg border border-border-subtle space-y-2">
          <label className="block text-xs text-text-secondary">
            {t('remote.name')}
            <span className="ml-2 text-text-tertiary">{t('remote.nameHint')}</span>
            <input className={`${INPUT_CLS} mt-1`} value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </label>
          <label className="block text-xs text-text-secondary">
            {t('remote.dest')}
            <span className="ml-2 text-text-tertiary">{t('remote.destHint')}</span>
            <input className={`${INPUT_CLS} mt-1`} list="ssh-config-hosts" value={form.destination}
              onChange={(e) => setForm({ ...form, destination: e.target.value })} />
            <datalist id="ssh-config-hosts">
              {sshAliases.map((a) => <option key={a} value={a} />)}
            </datalist>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-text-secondary">
              {t('remote.port')}
              <input className={`${INPUT_CLS} mt-1`} value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </label>
            <label className="block text-xs text-text-secondary">
              {t('remote.identity')}
              <input className={`${INPUT_CLS} mt-1`} value={form.identityFile}
                onChange={(e) => setForm({ ...form, identityFile: e.target.value })} />
            </label>
          </div>
          {formError && <div className="text-xs text-red-500">{formError}</div>}
          <div className="flex gap-2">
            <button className={BTN_CLS} onClick={handleSave}>{t('remote.save')}</button>
            <button className={BTN_CLS} onClick={() => setForm(null)}>{t('remote.cancel')}</button>
          </div>
        </div>
      )}

      {hosts.length === 0 && !form && (
        <div className="text-xs text-text-tertiary">{t('remote.noHosts')}</div>
      )}

      {hosts.map((host) => {
        const result = testResults[host.id];
        const config = configs[host.id];
        return (
          <div key={host.id} className="p-3 rounded-lg border border-border-subtle space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[13px] font-medium text-text-primary">{host.id}</span>
                <span className="ml-2 text-xs text-text-tertiary">
                  {host.destination}{host.port ? `:${host.port}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button className={BTN_CLS} disabled={testing === host.id} onClick={() => handleTest(host.id)}>
                  {testing === host.id ? t('remote.testing') : t('remote.test')}
                </button>
                <button className={BTN_CLS} disabled={readingConfig === host.id} onClick={() => handleReadConfig(host.id)}>
                  {readingConfig === host.id ? t('remote.reading') : t('remote.readConfig')}
                </button>
                <button className={BTN_CLS} onClick={() => handleDelete(host.id)}>{t('remote.delete')}</button>
              </div>
            </div>

            {result && (
              <div className={`text-xs ${typeof result !== 'string' && result.ok ? 'text-green-600' : 'text-red-500'}`}>
                {typeof result === 'string' ? result : result.message}
              </div>
            )}
            {remoteErrors[host.id] && (
              <div className="text-xs text-red-500">{remoteErrors[host.id]}</div>
            )}

            <div className="flex items-center gap-2">
              <input className={INPUT_CLS} placeholder={t('remote.pathPlaceholder')}
                value={paths[host.id] || ''}
                onChange={(e) => setPaths({ ...paths, [host.id]: e.target.value })} />
              <button className={`${BTN_CLS} whitespace-nowrap`} disabled={!(paths[host.id] || '').trim()}
                onClick={() => startRemoteDraft(host.id, paths[host.id] || '')}>
                {t('remote.newChat')}
              </button>
            </div>
            <div className="text-[11px] text-text-tertiary">{t('remote.notSupportedFiles')}</div>

            {config && (typeof config === 'string'
              ? <div className="text-xs text-red-500">{config}</div>
              : renderConfig(config))}
          </div>
        );
      })}
    </div>
  );
}
