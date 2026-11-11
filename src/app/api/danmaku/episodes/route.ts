// 获取剧集列表 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getDanmakuApiBaseUrl } from '@/lib/danmaku/config';
import { cacheGet, cacheSet, dedupeAndLimit } from '@/lib/danmaku/server-cache';
import { persistGet, persistSet } from '@/lib/danmaku/persist-cache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';


export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const animeId = searchParams.get('animeId');

    if (!animeId) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '缺少动漫ID参数',
          bangumi: {
            bangumiId: '',
            animeTitle: '',
            episodes: [],
          },
        },
        { status: 400 }
      );
    }

    const cacheKey = String(animeId);
    const cached = cacheGet('episodes', cacheKey);
    if (cached !== undefined) {
      return NextResponse.json(cached);
    }
    // L2：数据库持久化缓存（跨实例/跨冷启动共享）
    const persisted = await persistGet('episodes', cacheKey);
    if (persisted !== undefined) {
      cacheSet('episodes', cacheKey, persisted);
      return NextResponse.json(persisted);
    }

    // 从数据库读取弹幕配置
    const config = await getConfig();
    const baseUrl = getDanmakuApiBaseUrl(config.SiteConfig);

    const apiUrl = `${baseUrl}/api/v2/bangumi/${animeId}`;
    const token = config.SiteConfig.DanmakuApiToken;
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    // 添加超时控制和重试机制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 10秒超时

    try {
      const data = await dedupeAndLimit(`episodes:${cacheKey}`, async () => {
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': userAgent,
            'Authorization': token,
            'X-API-Token': token,
          },
          signal: controller.signal,
          // 添加 keepalive 避免连接被重置
          keepalive: true,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return (await response.json()) as any;
      });

      // 只缓存成功且含分集的结果
      if (data && data.success !== false && data.bangumi?.episodes?.length) {
        cacheSet('episodes', cacheKey, data);
        // 落库（await 保证 serverless 响应返回前写完，否则后台 promise 可能被回收）
        await persistSet('episodes', cacheKey, data);
      }

      return NextResponse.json(data);
    } catch (fetchError) {
      clearTimeout(timeoutId);

      // 如果是超时错误，返回更友好的错误信息
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('弹幕服务器请求超时，请稍后重试');
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('获取剧集列表代理错误:', error);
    return NextResponse.json(
      {
        errorCode: -1,
        success: false,
        errorMessage:
          error instanceof Error ? error.message : '获取剧集列表失败',
        bangumi: {
          bangumiId: '',
          animeTitle: '',
          episodes: [],
        },
      },
      { status: 500 }
    );
  }
}
