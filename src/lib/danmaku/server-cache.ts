/* eslint-disable no-console */

// 弹幕上游 API 服务端缓存（进程内 LRU + TTL）
//
// 背景：弹幕上游（danmu 聚合服务）首次聚合一部剧/一集的弹幕很慢——
//   - search  首次 2~17s
//   - episodes 首次 ~8s
//   - comment  首次 ~4s（一集可能 6000+ 条、约 700KB）
// 这些数据在短时间内不会变，因此加一层服务端缓存：
//   - 同一上游结果只聚合一次，后续所有用户/所有请求直接命中（跨用户共享）
//   - 不依赖 Next 的 Data Cache 行为（force-dynamic 下行为不确定），显式可控
//
// 缓存对象：任意 JSON 可序列化值（这里都是上游 JSON）。

interface Entry {
  value: unknown;
  expiresAt: number;
}

class TTLRUCache {
  private map = new Map<string, Entry>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get(key: string): unknown | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // 刷新 LRU 顺序
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteByPrefix(prefix: string): number {
    let n = 0;
    for (const key of Array.from(this.map.keys())) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const GLOBAL_KEY = Symbol.for('__MOONTV_DANMAKU_SERVER_CACHE__');

interface CacheBundle {
  search: TTLRUCache;
  episodes: TTLRUCache;
  comment: TTLRUCache;
  match: TTLRUCache;
}

function bundle(): CacheBundle {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      // 搜索关键词数量有限，给 500 条
      search: new TTLRUCache(500),
      // 分集列表：按 animeId，500 条
      episodes: new TTLRUCache(500),
      // 弹幕内容：单条可能很大，限制 200 集
      comment: new TTLRUCache(200),
      // 文件名自动匹配：300 条
      match: new TTLRUCache(300),
    } as CacheBundle;
  }
  return g[GLOBAL_KEY] as CacheBundle;
}

// 各类型 TTL（毫秒）
export const DANMAKU_CACHE_TTL = {
  search: 30 * 60 * 1000, // 30 分钟
  episodes: 6 * 60 * 60 * 1000, // 6 小时
  comment: 60 * 60 * 1000, // 1 小时（新弹幕会陆续产生，1 小时刷新一次较合理）
  match: 6 * 60 * 60 * 1000, // 6 小时
} as const;

export type DanmakuCacheKind = keyof typeof DANMAKU_CACHE_TTL;

export function cacheGet(kind: DanmakuCacheKind, key: string): unknown | undefined {
  return bundle()[kind].get(key);
}

export function cacheSet(
  kind: DanmakuCacheKind,
  key: string,
  value: unknown
): void {
  bundle()[kind].set(key, value, DANMAKU_CACHE_TTL[kind]);
}

export function cacheClear(kind?: DanmakuCacheKind): void {
  if (kind) {
    bundle()[kind].clear();
  } else {
    Object.values(bundle()).forEach((c) => c.clear());
  }
}

export function cacheStats(): Record<string, number> {
  const b = bundle();
  return {
    search: b.search.size,
    episodes: b.episodes.size,
    comment: b.comment.size,
    match: b.match.size,
  };
}

// ---------------------------------------------------------------------------
// 上游请求「去重 + 并发限制」
//
// 自建 danmu_api 通常是小机器/单实例，多源聚合很吃 CPU 与上游连接。
// 实测：同时对它发起几条新的搜索请求就能把实例打满，连根路径都要 hang 30s+。
// 因此：
//   1) 同一 cacheKey 的并发请求只打一次上游（in-flight 去重），其余等结果
//   2) 全局限制同时打到上游的请求数（默认 4），避免把自建服务打崩
// ---------------------------------------------------------------------------

const INFLIGHT_KEY = Symbol.for('__MOONTV_DANMAKU_INFLIGHT__');
const LIMITER_KEY = Symbol.for('__MOONTV_DANMAKU_LIMITER__');

const MAX_UPSTREAM_CONCURRENCY = Number(
  process.env.MOONTV_DANMAKU_UPSTREAM_CONCURRENCY || 4
);

interface LimiterState {
  active: number;
  waiters: Array<() => void>;
}

function limiter(): LimiterState {
  const g = globalThis as any;
  if (!g[LIMITER_KEY]) {
    g[LIMITER_KEY] = { active: 0, waiters: [] } as LimiterState;
  }
  return g[LIMITER_KEY] as LimiterState;
}

function inflightMap(): Map<string, Promise<unknown>> {
  const g = globalThis as any;
  if (!g[INFLIGHT_KEY]) {
    g[INFLIGHT_KEY] = new Map<string, Promise<unknown>>();
  }
  return g[INFLIGHT_KEY] as Map<string, Promise<unknown>>;
}

async function acquire(): Promise<void> {
  const l = limiter();
  if (l.active < MAX_UPSTREAM_CONCURRENCY) {
    l.active++;
    return;
  }
  await new Promise<void>((resolve) => l.waiters.push(resolve));
  l.active++;
}

function release(): void {
  const l = limiter();
  l.active = Math.max(0, l.active - 1);
  const next = l.waiters.shift();
  if (next) next();
}

/**
 * 去重 + 限流地执行一次上游请求。
 * @param dedupeKey 唯一标识（建议 `${kind}:${key}`）
 * @param fn 真正的上游请求逻辑
 */
export async function dedupeAndLimit<T>(
  dedupeKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const existing = inflightMap().get(dedupeKey);
  if (existing) {
    return existing as Promise<T>;
  }
  const p = (async () => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  })();
  inflightMap().set(dedupeKey, p as Promise<unknown>);
  try {
    return await p;
  } finally {
    inflightMap().delete(dedupeKey);
  }
}

export function getDanmakuUpstreamLimitInfo(): {
  maxConcurrency: number;
  active: number;
  queued: number;
  inflightKeys: number;
} {
  const l = limiter();
  return {
    maxConcurrency: MAX_UPSTREAM_CONCURRENCY,
    active: l.active,
    queued: l.waiters.length,
    inflightKeys: inflightMap().size,
  };
}
