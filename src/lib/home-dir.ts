// 用户主目录判断：文件面板不加载、不监听主目录。
// 主目录（C:\Users\xxx）下 AppData 等层级深、文件多，按深度 8 遍历一次要几十秒，
// 还要把几十 MB 的树经 IPC 传给前端；会话里每次工具执行完都会刷新文件树，CPU 会一直被占满。
import { bridge } from './tauri-bridge';

let homeDirPromise: Promise<string> | null = null;

/** 主目录只取一次，所有入口共用；取不到时返回空字符串 */
export function getHomeDirOnce(): Promise<string> {
  if (!homeDirPromise) homeDirPromise = bridge.getHomeDir().catch(() => '');
  return homeDirPromise;
}

/** Windows 路径不区分大小写，统一斜杠并去掉末尾斜杠后比较 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

export async function isHomeDirectory(path: string): Promise<boolean> {
  return samePath(path, await getHomeDirOnce());
}
