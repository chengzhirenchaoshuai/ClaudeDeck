// 远程文件拉取进度：从文件树把远程文件拖出窗口、但在下载完成前就松开了鼠标时，
// 后台继续下载，这里显示进度；下载完成后复制到松开位置的文件夹，
// 识别不出位置时弹出保存对话框。固定在窗口右下角，在 App 中挂载一次。
import { useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { usePullStore, type PullItem } from '../../stores/pullStore';

/** 轮询间隔 */
const POLL_MS = 250;
/** 成功后自动关闭的延迟 */
const AUTO_CLOSE_MS = 6000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** 关闭任务：通知后端（还在下载就取消）并从列表移除 */
function closePull(id: number) {
  bridge.closePull(id).catch(() => {});
  usePullStore.getState().removePull(id);
}

/** 目标位置未知、下载已完成：弹出保存对话框，选好后复制过去 */
async function promptSave(item: PullItem) {
  const { updatePull } = usePullStore.getState();
  updatePull(item.id, { savePrompted: true });
  const dest = await save({ defaultPath: item.name });
  if (!dest) {
    closePull(item.id);
    return;
  }
  try {
    await bridge.savePull(item.id, dest);
    updatePull(item.id, { savedTo: dest });
  } catch (err) {
    updatePull(item.id, { error: String(err) });
  }
}

function PullCard({ item }: { item: PullItem }) {
  const t = useT();
  const done = !!item.savedTo;
  const failed = !!item.error;
  const percent = item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : null;

  // 成功后自动关闭
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => closePull(item.id), AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [done, item.id]);

  let status: string;
  if (failed) status = item.error!;
  else if (done) status = t('files.pullSaved').replace('{path}', item.savedTo!);
  else if (item.downloaded && !item.target) status = t('files.pullChooseLocation');
  else if (item.target) status = t('files.pullingTo').replace('{dir}', item.target);
  else status = t('files.pullingThenChoose');

  return (
    <div className="w-80 px-3.5 py-3 rounded-xl bg-bg-card/95 backdrop-blur-lg
      border border-border-subtle shadow-lg text-xs">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate font-medium text-text-primary" title={item.name}>
          {item.name}
        </span>
        {done && (
          <button
            onClick={() => bridge.revealInFinder(item.savedTo!).catch(() => {})}
            className="px-2 py-0.5 rounded-md text-accent hover:bg-accent/10 transition-smooth"
          >
            {t('files.pullReveal')}
          </button>
        )}
        <button
          onClick={() => closePull(item.id)}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-secondary transition-smooth"
          title={done || failed ? t('files.pullClose') : t('files.pullCancel')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      </div>
      <div className={`mt-1 break-all ${failed ? 'text-error' : done ? 'text-success' : 'text-text-tertiary'}`}>
        {status}
      </div>
      {!done && !failed && (
        <>
          <div className="mt-2 h-1.5 rounded-full bg-bg-secondary overflow-hidden">
            <div
              className={`h-full bg-accent transition-[width] duration-200 ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
              style={percent === null ? undefined : { width: `${item.downloaded ? 100 : percent}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-text-tertiary tabular-nums">
            {formatBytes(item.received)}
            {item.total > 0 && ` / ${formatBytes(item.total)}`}
            {percent !== null && ` · ${item.downloaded ? 100 : percent}%`}
          </div>
        </>
      )}
    </div>
  );
}

export function PullProgress() {
  const pulls = usePullStore((s) => s.pulls);
  const hasActive = pulls.some((p) => !p.savedTo && !p.error);

  // 有进行中的任务时轮询后端进度
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      const { pulls: list, updatePull } = usePullStore.getState();
      for (const item of list) {
        if (item.savedTo || item.error) continue;
        bridge.pullStatus(item.id)
          .then((s) => {
            updatePull(item.id, {
              received: s.received,
              total: s.total,
              downloaded: s.downloaded,
              error: s.error,
              // 目标未知时 savedTo 由保存对话框那一步填，不能被后端的空值覆盖
              ...(s.savedTo ? { savedTo: s.savedTo } : {}),
            });
            const latest = usePullStore.getState().pulls.find((p) => p.id === item.id);
            if (latest && s.downloaded && !latest.target && !latest.savePrompted && !latest.error) {
              void promptSave(latest);
            }
          })
          // 任务已被关闭（取消、保存完成）时查询会失败，忽略
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  if (pulls.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9997] flex flex-col gap-2">
      {pulls.map((item) => <PullCard key={item.id} item={item} />)}
    </div>
  );
}
