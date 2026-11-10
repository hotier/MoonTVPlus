/* eslint-disable no-console */

// 路由数据预取（Route Data Prefetch）
//
// 背景：本项目所有页面都是 'use client' 组件，数据在客户端挂载后才发请求，
// 造成「顶部进度条读完 → 页面 skeleton 再转 1~6 秒」的两段式等待。
// 本模块在导航发起时（TopProgressBar 拦截 router.push/replace 的那一刻）
// 就把目标页面的关键 API 提前发出，页面挂载后直接复用飞行中/已完成的结果。
//
// 使用方式：
//   - TopProgressBar 在 push/replace 时调用 prefetchRoute(pathname)
//   - 页面组件用 usePrefetched(key) 获取 promise，拿到后 await 即可替代原 fetch
//
// 结果只缓存一次（取走即清），避免跨导航误用旧数据。

export interface PrefetchEntry {
  promise: Promise<Response[]>;
  createdAt: number;
}

const STORE_KEY = Symbol.for('__MOONTV_ROUTE_PREFETCH__');

function store(): Map<string, PrefetchEntry> {
  if (!(globalThis as any)[STORE_KEY]) {
    (globalThis as any)[STORE_KEY] = new Map<string, PrefetchEntry>();
  }
  return (globalThis as any)[STORE_KEY] as Map<string, PrefetchEntry>;
}

const ENTRY_TTL_MS = 15 * 1000; // 15 秒未被取走则丢弃（用户可能取消了导航）

function normalizePath(pathname: string): string {
  // 去掉末尾斜杠（除根路径），让 /admin/ 与 /admin 命中同一 key
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function cleanup() {
  const now = Date.now();
  const s = store();
  s.forEach((entry, key) => {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      s.delete(key);
    }
  });
  // 数据型预取同样按 TTL 清理
  const ds = dataStore();
  ds.forEach((entry, key) => {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      ds.delete(key);
    }
  });
}

// 各路由的预取请求列表：返回相对 URL 数组（fetch 时携带 cookie）
const ROUTE_PREFETCH_MAP: Record<string, string[]> = {
  '/admin': ['/api/admin/config', '/api/admin/users?page=1&limit=10'],
};

/**
 * 在导航发起时调用：为目标路由提前发出关键请求。
 * fire-and-forget：任何失败都不影响导航本身。
 */
export function prefetchRoute(pathname: string): void {
  cleanup();
  const normalized = normalizePath(pathname);

  // 数据型预取（首页等客户端聚合数据）
  const dataPrefetcher = DATA_PREFETCHERS[normalized];
  if (dataPrefetcher) {
    const ds = dataStore();
    if (!ds.has(normalized)) {
      ds.set(normalized, {
        promise: dataPrefetcher().catch((err) => {
          console.error('[Prefetch] data prefetch failed:', normalized, err);
          return null;
        }),
        createdAt: Date.now(),
      });
    }
    return;
  }

  // Response 型预取（固定 API 列表）
  const urls = ROUTE_PREFETCH_MAP[normalized];
  if (!urls || urls.length === 0) return;
  if (store().has(normalized)) return; // 已在飞行中/已预取

  const promises = urls.map((u) =>
    fetch(u, { cache: 'no-store', credentials: 'same-origin' }).catch((err) => {
      console.error('[Prefetch] failed:', u, err);
      // 返回一个永不 resolve 的占位？不行——页面会挂死。
      // 改为：失败时页面端拿到的 Response 状态为 0，走正常错误分支。
      return new Response(null, { status: 0, statusText: 'prefetch-failed' });
    })
  );

  // 页面端按顺序取结果
  store().set(normalized, {
    promise: Promise.all(promises),
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// 数据型预取（Data Prefetch）
// 某些页面（如首页）的数据来自客户端聚合函数（豆瓣/Bangumi 走 CDN，非本服务 API），
// 无法用「预取固定 URL」的方式。这里用 data prefetcher：在导航发起时动态 import
// 对应 client 库并直接跑一遍聚合逻辑，把「已解析的数据」存起来给页面复用。
// 用动态 import 是为了不把这些 client 库打进共享 chunk（只在真正导航时按需加载）。
// ---------------------------------------------------------------------------

export interface PrefetchDataEntry {
  promise: Promise<Record<string, any> | null>;
  createdAt: number;
}

const DATA_STORE_KEY = Symbol.for('__MOONTV_ROUTE_PREFETCH_DATA__');

function dataStore(): Map<string, PrefetchDataEntry> {
  if (!(globalThis as any)[DATA_STORE_KEY]) {
    (globalThis as any)[DATA_STORE_KEY] = new Map<string, PrefetchDataEntry>();
  }
  return (globalThis as any)[DATA_STORE_KEY] as Map<string, PrefetchDataEntry>;
}

const HOMEPAGE_CACHE_DURATION = 60 * 60 * 1000; // 与首页一致：1 小时

function readHomeCache(key: string): { data: any; expired: boolean } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    return { data, expired: Date.now() - timestamp > HOMEPAGE_CACHE_DURATION };
  } catch {
    return null;
  }
}

// 首页数据预取：只补「缺失或已过期」的部分，新鲜缓存完全跳过，不浪费请求。
async function prefetchHomepageData(): Promise<Record<string, any> | null> {
  const keys = {
    movies: 'homepage_movies',
    tv: 'homepage_tvshows',
    variety: 'homepage_variety',
    bangumi: 'homepage_bangumi',
    duanju: 'homepage_duanju',
    upcoming: 'homepage_upcoming',
  } as const;

  const need = (cacheKey: string) => {
    const c = readHomeCache(cacheKey);
    return !c || c.expired;
  };

  const result: Record<string, any> = {};
  const jobs: Promise<void>[] = [];

  const needMovies = need(keys.movies);
  const needTv = need(keys.tv);
  const needVariety = need(keys.variety);
  const needBangumi = need(keys.bangumi);

  if (needMovies || needTv || needVariety || needBangumi) {
    jobs.push(
      (async () => {
        const { getDoubanCategories } = await import('./douban.client');
        const { GetBangumiCalendarData } = await import('./bangumi.client');
        const [movies, tv, variety, bangumi] = await Promise.all([
          needMovies
            ? getDoubanCategories({ kind: 'movie', category: '热门', type: '全部' }).catch(() => null)
            : Promise.resolve(null),
          needTv
            ? getDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' }).catch(() => null)
            : Promise.resolve(null),
          needVariety
            ? getDoubanCategories({ kind: 'tv', category: 'show', type: 'show' }).catch(() => null)
            : Promise.resolve(null),
          needBangumi ? GetBangumiCalendarData().catch(() => null) : Promise.resolve(null),
        ]);
        if (movies?.code === 200) result.movies = movies.list;
        if (tv?.code === 200) result.tv = tv.list;
        if (variety?.code === 200) result.variety = variety.list;
        if (Array.isArray(bangumi) && bangumi.length > 0) result.bangumi = bangumi;
      })()
    );
  }

  if (need(keys.duanju)) {
    jobs.push(
      (async () => {
        try {
          const res = await fetch('/api/duanju/recommends', { credentials: 'same-origin' });
          if (!res.ok) return;
          const json = await res.json();
          if (json.code === 200 && Array.isArray(json.data) && json.data.length > 0) {
            result.duanju = json.data;
          }
        } catch {
          /* ignore */
        }
      })()
    );
  }

  if (need(keys.upcoming)) {
    jobs.push(
      (async () => {
        try {
          const res = await fetch('/api/tmdb/upcoming', { credentials: 'same-origin' });
          if (!res.ok) return;
          const json = await res.json();
          if (json.code === 200 && Array.isArray(json.data) && json.data.length > 0) {
            result.upcoming = [...json.data].sort((a: any, b: any) => {
              const da = new Date(a.release_date || '9999-12-31').getTime();
              const db = new Date(b.release_date || '9999-12-31').getTime();
              return da - db;
            });
          }
        } catch {
          /* ignore */
        }
      })()
    );
  }

  if (jobs.length === 0) return null; // 全部新鲜，无需预取
  await Promise.all(jobs);

  // 只要有一个「本应预取」的 key 没拿到数据，就整体放弃（返回 null），
  // 让页面走原始完整请求路径，避免出现「部分板块空白」的降级体验。
  const neededKeys: string[] = [];
  if (needMovies) neededKeys.push('movies');
  if (needTv) neededKeys.push('tv');
  if (needVariety) neededKeys.push('variety');
  if (needBangumi) neededKeys.push('bangumi');
  if (need(keys.duanju)) neededKeys.push('duanju');
  if (need(keys.upcoming)) neededKeys.push('upcoming');

  if (neededKeys.some((k) => result[k] === undefined)) {
    return null;
  }
  return Object.keys(result).length > 0 ? result : null;
}

const DATA_PREFETCHERS: Record<string, () => Promise<Record<string, any> | null>> = {
  '/': prefetchHomepageData,
};

/**
 * 页面挂载时取走数据型预取结果（取走即清）。返回 null 表示无可用预取。
 */
export async function takePrefetchedData(
  pathname: string
): Promise<Record<string, any> | null> {
  const normalized = normalizePath(pathname);
  const s = dataStore();
  const entry = s.get(normalized);
  s.delete(normalized);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ENTRY_TTL_MS) return null;
  try {
    return await entry.promise;
  } catch {
    return null;
  }
}

// 在单一路由入口统一决定：先看 Response 型预取，再看 Data 型预取

/**
 * 页面挂载时取走预取结果（取走即清）。
 * 返回 null 表示没有可用预取（直接路径访问/刷新/过期）。
 */
export async function takePrefetchedResponses(
  pathname: string
): Promise<Response[] | null> {
  const normalized = normalizePath(pathname);
  const s = store();
  const entry = s.get(normalized);
  s.delete(normalized);
  if (!entry) return null;

  // 双保险：太旧的预取不可信（可能对应上一次导航）
  if (Date.now() - entry.createdAt > ENTRY_TTL_MS) return null;

  try {
    const responses = await entry.promise;
    // 任一请求彻底失败（网络级）则放弃预取，让页面走原始请求路径
    if (responses.some((r) => !r || r.status === 0)) return null;
    return responses;
  } catch {
    return null;
  }
}

/**
 * 清空预取存储（登出/切账号时调用，防止跨账号数据泄漏）。
 */
export function clearPrefetchStore(): void {
  store().clear();
  dataStore().clear();
}
