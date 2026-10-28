// 读取当前应用版本号（tauri.conf.json 的 version），读取前或失败时为空串
import { useEffect, useState } from 'react';

export function useAppVersion(): string {
  const [version, setVersion] = useState('');
  useEffect(() => {
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then(setVersion).catch(() => {})
    );
  }, []);
  return version;
}
