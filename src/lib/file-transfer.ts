// 把文件“拿到本机”：另存为，或从文件树拖出窗口（系统级拖拽）。
// 本机文件和远程文件（ssh:// URI）都支持。
import { save } from '@tauri-apps/plugin-dialog';
import { bridge } from './tauri-bridge';
import { showToast } from '../components/shared/Toast';
import { t } from './i18n';
import { finishSystemDrag } from './drag-state';
import { usePullStore } from '../stores/pullStore';

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

/**
 * 把文件树里的文件拖出窗口（系统级拖拽），放到桌面、资源管理器等处。
 * 远程文件要先经 scp 下载：按住到下载完成就正常拖拽；提前松开则转为后台拉取，
 * 由 PullProgress 显示进度，完成后保存到松开位置的文件夹。
 */
export async function dragOutToSystem(path: string): Promise<void> {
  try {
    const outcome = await bridge.startFileDrag(path);
    if (outcome.kind === 'pulling') {
      usePullStore.getState().addPull(outcome.id, outcome.name, outcome.target);
    }
  } catch (err) {
    showToast(`${t('files.dragOutFailed')}: ${err}`, 'error');
  } finally {
    finishSystemDrag();
  }
}
