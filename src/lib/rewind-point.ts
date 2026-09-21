import { bridge } from './tauri-bridge';
import { useSessionStore } from '../stores/sessionStore';
import type { Turn } from './turns';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 回退点对应的 JSONL 用户记录 uuid：
 * 实时会话取流里的 checkpointUuid；从磁盘加载的会话，消息 ID 本身就是记录 uuid。
 */
export function recordUuidOf(turn: Turn): string {
  const id = turn.checkpointUuid || turn.userMessageId;
  if (!UUID_RE.test(id)) throw new Error('该消息没有可用的记录 ID');
  return id;
}

/** 在会话列表里找到该会话的 JSONL 路径；还没出现时刷新列表再找（新会话文件可能刚写入） */
async function findSessionPath(sessionId: string): Promise<string | null> {
  const find = () =>
    useSessionStore.getState().sessions.find((s) => s.id === sessionId && s.path)?.path ?? null;
  let path = find();
  if (path) return path;
  await useSessionStore.getState().fetchSessions();
  path = find();
  if (path) return path;
  // 远程会话不在本机列表里，再刷新一次远程列表
  await useSessionStore.getState().fetchRemoteSessions();
  return find();
}

/**
 * 计算回退到某一轮时，CLI 应该续接到哪条消息（--resume-session-at 的参数）：
 * 即该轮用户消息之前、最近的一条助手消息的 uuid。
 * 返回 null 表示回退到第一轮（之前没有任何历史），应当开启全新会话。
 * 找不到会话文件或消息链不完整时抛出错误，调用方应中止回退，而不是悄悄丢掉全部上下文。
 */
export async function resolveResumeAt(sessionId: string, userRecordUuid: string): Promise<string | null> {
  const path = await findSessionPath(sessionId);
  if (!path) throw new Error('找不到会话文件');

  const records = (await bridge.loadSession(path)) as Array<Record<string, unknown>>;
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    if (typeof r.uuid === 'string') byUuid.set(r.uuid, r);
  }

  const start = byUuid.get(userRecordUuid);
  if (!start) throw new Error('会话文件里没有该消息');

  const seen = new Set<string>();
  let parent = start.parentUuid;
  while (typeof parent === 'string' && parent && !seen.has(parent)) {
    seen.add(parent);
    const record = byUuid.get(parent);
    if (!record) throw new Error('消息链不完整');
    if (record.type === 'assistant') return record.uuid as string;
    parent = record.parentUuid;
  }
  return null;
}
