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
}
