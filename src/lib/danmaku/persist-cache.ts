/* eslint-disable no-console */

// 弹幕数据「持久化 L2 缓存」（数据库层）
//
// 为什么需要它：
//   弹幕上游是别人自建的实例，首次聚合搜索/分集很慢（搜索 10~17s、分集 ~8s），
//   而本项目常部署在 Vercel（serverless）——进程内缓存会在冷启动/多实例间丢失，
//   导致每个冷实例第一个用户都要重新忍受漫长的上游等待。
//   这里把「搜索结果 / 分集列表」这两类小体积、慢产出的数据写入数据库（Turso 等），
//   实现跨实例、跨冷启动共享：只要有人拉过一次，之后任何实例都能秒回。
//
// 只持久化「小且慢」的数据（search / episodes）。弹幕内容（comment）单集可达 700KB，
// 由进程内缓存 + 客户端 IndexedDB 负责，避免把大 body 反复写库/读库。

import { DANMAKU_CACHE_TTL, type DanmakuCacheKind } from './server-cache';
import { db } from '@/lib/db';

const PREFIX = 'danmaku_cache:v1:';
// 只持久化这两类
type PersistedKind = 'search' | 'episodes';
const PERSISTED_KINDS: PersistedKind[] = ['search', 'episodes'];

function isPersistedKind(kind: DanmakuCacheKind): kind is PersistedKind {
  return (PERSISTED_KINDS as string[]).includes(kind);
}

function hashKey(key: string): string {
  // 使用简单稳定的非加密哈希即可（key 本身不敏感，只需短且尽量不冲突）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  const a = (h1 >>> 0).toString(36);
  const b = (h2 >>> 0).toString(36);
  // 附带 key 长度与前缀，进一步降低冲突
  return `${a}${b}${key.length.toString(36)}`;
}

function storageKey(kind: PersistedKind, key: string): string {
  return `${PREFIX}${kind}:${hashKey(key)}`;
}

/**
 * 读取持久化缓存；命中且未过期返回数据，否则 undefined。
 * 任何异常（DB 不可用/JSON 损坏）都静默降级为 undefined。
 */
export async function persistGet(
  kind: DanmakuCacheKind,
  key: string
): Promise<unknown | undefined> {
  if (!isPersistedKind(kind)) return undefined;
  try {
    const raw = await db.getGlobalValue(storageKey(kind, key));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { d?: unknown; e?: number };
    if (!parsed || typeof parsed.e !== 'number') return undefined;
    if (Date.now() > parsed.e) return undefined;
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[danmaku-persist] L2 hit ${kind} ${key.slice(0, 24)}`);
    }
    return parsed.d;
  } catch {
    return undefined;
  }
}

/**
 * 写入持久化缓存（带 TTL）。失败静默忽略，不影响主流程。
 */
export async function persistSet(
  kind: DanmakuCacheKind,
  key: string,
  data: unknown,
  ttlMs?: number
): Promise<void> {
  if (!isPersistedKind(kind)) return;
  try {
    const ttl = ttlMs ?? DANMAKU_CACHE_TTL[kind];
    await db.setGlobalValue(
      storageKey(kind, key),
      JSON.stringify({ d: data, e: Date.now() + ttl })
    );
  } catch {
    /* ignore */
  }
}
