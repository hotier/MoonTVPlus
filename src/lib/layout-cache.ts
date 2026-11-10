/* eslint-disable no-console */

// 布局（RootLayout）数据缓存：
// 每次导航都会重新渲染 force-dynamic 的 RootLayout，其中:
//   1) getConfig()        —— config.ts 自带模块级缓存（进程内长期有效）
//   2) getUserFeatureAccess() —— 内部走 db.getUserInfoV2()（user-cache 6h TTL，但用户未登录时
//      username 为 null 直接返回空表，不会打库；登录用户受 user-cache 保护）
//   3) listEnabledSourceScripts() —— source-script 自带 4h TTL 缓存
// 三者本身都有缓存，但 dev 热重载/多 worker 下首帧仍要各打一次远程库（Turso RTT 200ms+）。
// 这里再加一层「layout 聚合结果」短 TTL 缓存，把一次导航的远程库访问从 1~3 次压到 0 次。
//
// 失效策略：
//   - TTL 到期自动失效（后台刷新模式：过期后第一次请求返回旧值并异步刷新，不阻塞导航）
//   - 管理后台保存配置时通过 bumpLayoutCacheVersion() 主动失效（保证改动尽快生效）

import { getConfig } from './config';
import { getUserFeatureAccess, type FeatureAccessMap } from './permissions';
import { listEnabledSourceScripts } from './source-script';
import type { AdminConfig } from './admin.types';
import type { PublicSourceScriptSummary } from './source-script';

export interface LayoutDataSnapshot {
  config: AdminConfig;
  userFeatureAccess: FeatureAccessMap;
  enabledSourceScripts: PublicSourceScriptSummary[];
  cachedAt: number;
}

const LAYOUT_CACHE_TTL_MS = 60 * 1000; // 60 秒软 TTL
const LAYOUT_CACHE_VERSION = Symbol.for('__MOONTV_LAYOUT_CACHE_VERSION__');
const LAYOUT_CACHE_SNAPSHOT = Symbol.for('__MOONTV_LAYOUT_CACHE_SNAPSHOT__');

function getVersion(): number {
  return ((globalThis as any)[LAYOUT_CACHE_VERSION] as number) || 0;
}

let refreshing: Promise<LayoutDataSnapshot> | null = null;

async function fetchFresh(): Promise<LayoutDataSnapshot> {
  const config = await getConfig();
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  const userFeatureAccess =
    storageType === 'localstorage'
      ? await getUserFeatureAccess(process.env.USERNAME || 'localstorage-owner')
      : await getUserFeatureAccess(null);
  const enabledSourceScripts = await listEnabledSourceScripts();
  return {
    config,
    userFeatureAccess,
    enabledSourceScripts,
    cachedAt: Date.now(),
  };
}

/**
 * 读取布局聚合数据（带 60s 软 TTL + stale-while-revalidate）：
 *  - 命中且未过期：直接返回缓存，0 次远程库访问
 *  - 命中但过期：先返回旧值，后台异步刷新（导航不被远程库阻塞）
 *  - 无缓存：同步等待一次完整加载（仅冷启动/版本失效后第一次）
 */
export async function getLayoutData(): Promise<LayoutDataSnapshot> {
  const version = getVersion();
  const cached = (globalThis as any)[LAYOUT_CACHE_SNAPSHOT] as
    | (LayoutDataSnapshot & { _version?: number })
    | undefined;

  if (cached && cached._version === version) {
    const age = Date.now() - cached.cachedAt;
    if (age < LAYOUT_CACHE_TTL_MS) {
      return cached;
    }
    // 过期：stale-while-revalidate，后台刷新
    if (!refreshing) {
      refreshing = fetchFresh()
        .then((fresh) => {
          (globalThis as any)[LAYOUT_CACHE_SNAPSHOT] = {
            ...fresh,
            _version: getVersion(),
          };
          return fresh;
        })
        .catch((err) => {
          console.error('[LayoutCache] background refresh failed:', err);
          return cached; // 刷新失败继续用旧值
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return cached;
  }

  // 无缓存或版本已失效：同步加载
  const fresh = await fetchFresh();
  (globalThis as any)[LAYOUT_CACHE_SNAPSHOT] = {
    ...fresh,
    _version: getVersion(),
  };
  return fresh;
}

/**
 * 主动失效布局缓存（管理后台保存配置后调用，让配置改动立即反映到下一次导航）。
 */
export function bumpLayoutCacheVersion(): void {
  (globalThis as any)[LAYOUT_CACHE_VERSION] = getVersion() + 1;
}
