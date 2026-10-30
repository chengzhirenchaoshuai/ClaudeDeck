/**
 * 会话消息里的文件路径：识别哪些行内代码是文件路径（渲染成可点击的文件链接），
 * 以及点击后实际要读取的路径。助手消息（MarkdownRenderer）和用户消息（UserMessage）共用。
 */
import { toSessionFilePath } from './remote';

/** 已知的代码 / 配置 / 文档类扩展名：相对路径和裸文件名只在扩展名属于这些时才算文件 */
export const KNOWN_FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl',
  'toml', 'yaml', 'yml', 'py', 'pyi', 'rs', 'go', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'fish',
  'env', 'conf', 'cfg', 'ini', 'xml', 'sql', 'graphql', 'gql', 'proto',
  'lock', 'log', 'txt', 'csv', 'tsv', 'rb', 'php', 'java', 'kt', 'kts', 'swift', 'c',
  'cpp', 'h', 'hpp', 'cs', 'r', 'lua', 'zig', 'ex', 'exs', 'erl', 'ml',
  'mli', 'tf', 'hcl', 'dockerfile', 'makefile', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'webp', 'ico', 'wasm', 'map', 'ps1', 'bat', 'cmd',
  'gradle', 'dart', 'scala', 'pdf', 'csproj', 'sln', 'vbs',
]);

/** 路径里允许的字符：字母（含中文等）、数字、下划线和 . @ + - 以及两种分隔符 */
const PATH_BODY = /^[\p{L}\p{N}_.@+\-/\\]+$/u;
/** 结尾的行号：a.ts:12、a.ts:12-30、a.ts:12:5 */
const LINE_SUFFIX = /:(\d+)(?:[-:]\d+)?$/;

export interface InlineFilePath {
  /** 去掉行号后的路径（原样，未解析） */
  path: string;
  line?: number;
}

/**
 * 判断一段行内代码是不是文件路径。
 * - 绝对路径（C:\x、C:/x、/x、/f/x）、./ ../ 开头：扩展名任意
 * - 其余相对路径和裸文件名：扩展名须是已知类型，避免把 a.b、v1.2 之类误认成文件
 */
export function parseInlineFilePath(text: string): InlineFilePath | null {
  let s = text.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!s || s.length > 400 || s.includes('://')) return null;
  let line: number | undefined;
  const lineMatch = s.match(LINE_SUFFIX);
  if (lineMatch && !/^[a-zA-Z]:\d/.test(s)) {
    line = Number(lineMatch[1]);
    s = s.slice(0, lineMatch.index);
  }
  // 带盘符的绝对路径允许空格（文件夹、文件名常带空格）；相对路径不放开，否则 cat a.md 这类命令会被当成文件。
  // 排除 C:\python.exe run.py、C:\a.exe --x 这类命令行：空格前已出现扩展名，或空格后是选项
  const body = s.replace(/^[a-zA-Z]:/, '');
  const spaced = /^[a-zA-Z]:[\\/]/.test(s) && !/\.[a-zA-Z0-9]{1,10} |(^| )-/.test(body);
  if (!PATH_BODY.test(spaced ? body.replace(/ /g, '_') : body)) return null;
  const name = s.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  // 扩展名至少含一个字母：排除 1.2.3 这类版本号
  if (!/^[a-z0-9]{1,10}$/.test(ext) || !/[a-z]/.test(ext)) return null;
  const absolute = /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || /^\.\.?[\\/]/.test(s);
  if (!absolute && !KNOWN_FILE_EXTENSIONS.has(ext)) return null;
  return { path: s, line };
}

/** 把 a/b/../c、a/./b 规整成 a/c、a/b：本机和远程的读取接口都拒绝含 .. 的路径 */
function normalizeSegments(path: string): string {
  const prefix = path.match(/^(ssh:\/\/[^/]+\/)?([a-zA-Z]:\/|\/)?/)?.[0] ?? '';
  const out: string[] = [];
  for (const seg of path.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return prefix + out.join('/');
}

/**
 * 点击文件链接时实际读取的路径：
 * - Git Bash 风格的 /f/AI/x 转成 F:/AI/x（本应用只在 Windows 上运行，远端也是 Windows）
 * - 相对路径拼到 base（项目目录，远程时为 ssh://主机/...）上
 * - 远程项目里的绝对路径转成 ssh://主机/...（toSessionFilePath）
 */
export function resolveSessionPath(path: string, base: string): string {
  let p = path.replace(/\\/g, '/');
  const msys = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) p = `${msys[1].toUpperCase()}:/${msys[2]}`;
  const absolute = /^[a-zA-Z]:\//.test(p) || p.startsWith('/') || p.startsWith('ssh://');
  if (!absolute && base) p = `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`;
  return toSessionFilePath(normalizeSegments(p));
}

const normDir = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 只有文件名（不含目录）的链接，项目根目录里确实没有这个文件时返回 true。
 * 用文件面板已加载的目录树判断（本机和远程都有），不额外读磁盘或走 ssh；
 * 目录树不是当前项目的、还没加载出来时无法判断，返回 false（照常显示为链接）。
 */
export function isBareFileMissing(
  path: string,
  base: string,
  tree: { rootPath: string; nodes: { name: string; is_dir: boolean }[] },
): boolean {
  if (/[\\/]/.test(path) || !base || tree.nodes.length === 0) return false;
  if (normDir(tree.rootPath) !== normDir(base)) return false;
  const name = path.toLowerCase();
  return !tree.nodes.some((n) => !n.is_dir && n.name.toLowerCase() === name);
}
