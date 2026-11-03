// 把文件“拿到本机”的两种方式：另存为、以文件形式复制到系统剪贴板（可直接粘贴为邮件附件）。
// 本机文件和远程文件（ssh:// URI，后端经 ssh 下载，上限 100MB）都支持。
import { save } from '@tauri-apps/plugin-dialog';
import { bridge, isRemotePath } from './tauri-bridge';
import { showToast } from '../components/shared/Toast';
import { t } from './i18n';

function fileNameOf(path: string): string {
  return path.split(/[\/]/).pop() || 'file';
}

/** 弹出保存对话框，把文件另存到本机。用户取消时返回 false */
export async function saveFileAsWithDialog(path: string): Promise<boolean> {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const dest = await save({
    defaultPath: name,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
  });
  if (!dest) return false;
  try {
    await bridge.saveFileAs(path, dest);
    showToast(t('files.savedAs').replace('{path}', dest), 'success');
  } catch (err) {
    showToast(`${t('files.saveAsFailed')}: ${err}`, 'error');
  }
  return true;
}

/** 以文件形式复制到系统剪贴板，之后可在邮件、聊天软件、资源管理器里粘贴 */
export async function copyFileToClipboard(path: string): Promise<void> {
  // 远程文件要先下载，可能要几秒，先给个提示
  if (isRemotePath(path)) showToast(t('files.downloadingForClipboard'), 'info');
  try {
    await bridge.copyFileToClipboard(path);
    showToast(t('files.copiedToClipboard').replace('{name}', fileNameOf(path)), 'success');
  } catch (err) {
    showToast(`${t('files.copyToClipboardFailed')}: ${err}`, 'error');
  }
}
