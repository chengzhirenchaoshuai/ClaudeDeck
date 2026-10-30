// 当前登录账号：邮箱、订阅类型和登录入口。主页和 /login 的反馈卡片共用。
import { useEffect, useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useProviderStore } from '../../stores/providerStore';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';

/** pro → Pro；CLI 没有提供时返回空 */
function subscriptionLabel(type: string | null | undefined): string {
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : '';
}

export function AccountStatus() {
  const t = useT();
  const account = useAccountStore((s) => s.account);
  const refresh = useAccountStore((s) => s.refresh);
  const provider = useProviderStore((s) =>
    s.providers.find((p) => p.id === s.activeProviderId),
  );
  const [loginError, setLoginError] = useState('');

  // 在终端登录完切回来时自动更新
  useEffect(() => {
    refresh();
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const login = () => {
    setLoginError('');
    bridge.openTerminalLogin().catch((err) => setLoginError(String(err)));
  };

  // 选了第三方服务商时，会话用的是服务商的密钥，不是 Claude 账号
  if (provider) {
    return (
      <div className="text-xs text-text-tertiary truncate max-w-sm">
        {t('account.provider').replace('{name}', provider.name)}
      </div>
    );
  }
  if (!account) return null;

  const name = account.loggedIn
    ? account.email || account.authMethod || t('account.loggedIn')
    : t('account.loggedOut');
  const subscription = account.loggedIn ? subscriptionLabel(account.subscriptionType) : '';

  return (
    <div className="flex flex-col items-center gap-1 max-w-sm">
      <div
        className="inline-flex max-w-full items-center gap-2 text-xs text-text-muted"
        title={account.orgName || undefined}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0
          ${account.loggedIn ? 'bg-success' : 'bg-warning'}`} />
        <span className="min-w-0 truncate">{name}</span>
        {subscription && <span className="flex-shrink-0 text-text-tertiary">{subscription}</span>}
        <button
          onClick={login}
          className="flex-shrink-0 text-accent hover:underline"
        >
          {t(account.loggedIn ? 'account.switch' : 'account.login')}
        </button>
      </div>
      {loginError && <div className="text-[11px] text-error break-all">{loginError}</div>}
    </div>
  );
}
