/**
 * 消息里的目录路径：渲染成可点击的目录链接，点击在资源管理器中打开。
 * 助手消息（MarkdownRenderer）和用户消息（UserMessage）共用。
 */
import { bridge } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { showToast } from './Toast';

/** 助手消息里的样式；用户气泡底色是强调色，用白色半透明 */
const STYLES = {
  assistant: 'bg-accent/10 border-accent/25 text-accent hover:bg-accent/20 hover:border-accent/40',
  user: 'bg-white/15 border-white/25 hover:bg-white/25 hover:border-white/40',
};

export function InlineDirChip({ path, copyText, variant = 'assistant' }: {
  path: string;
  copyText: string;
  variant?: keyof typeof STYLES;
}) {
  const t = useT();
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        bridge.openDirectory(path).catch((err) => showToast(String(err), 'error'));
      }}
      className={`inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 mx-0.5
        border rounded-md text-xs font-medium cursor-pointer
        transition-all duration-150 select-none
        align-baseline leading-normal whitespace-nowrap ${STYLES[variant]}`}
      title={`${path}\n${t('md.openDirectory')}`}
      data-copy-text={copyText}
    >
      <span className="text-[10px]">📁</span>
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}
