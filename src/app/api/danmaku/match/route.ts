// 自动匹配 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getDanmakuApiBaseUrl } from '@/lib/danmaku/config';
import { cacheGet, cacheSet, dedupeAndLimit, getDanmakuCacheScope } from '@/lib/danmaku/server-cache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';


export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileName } = body;

    if (!fileName) {
      return NextResponse.json(
        {
          errorCode: -1,
          success: false,
          errorMessage: '缺少文件名参数',
          isMatched: false,
          matches: [],
        },
        { status: 400 }
      );
    }

    // 先读配置（模块级缓存，开销极小），用于计算缓存 scope（换源自动失效）
    const config = await getConfig();
    const baseUrl = getDanmakuApiBaseUrl(config.SiteConfig);
    const token = config.SiteConfig.DanmakuApiToken;
    const scope = getDanmakuCacheScope(
      config.SiteConfig.DanmakuApiBase || '',
      token || ''
    );
    const cacheKey = `${scope}|${fileName}`;

    const cached = cacheGet('match', cacheKey);
    if (cached !== undefined) {
      return NextResponse.json(cached);
    }

    const apiUrl = `${baseUrl}/api/v2/match`;
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 10秒超时

    try {
      const data = await dedupeAndLimit(`match:${cacheKey}`, async () => {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': userAgent,
            'Authorization': token,
            'X-API-Token': token,
          },
          body: JSON.stringify({ fileName }),
          signal: controller.signal,
          keepalive: true,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return (await response.json()) as any;
      });

      if (data && data.success !== false) {
        cacheSet('match', cacheKey, data);
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
    console.error('自动匹配代理错误:', error);
    return NextResponse.json(
      {
        errorCode: -1,
        success: false,
        errorMessage: error instanceof Error ? error.message : '匹配失败',
        isMatched: false,
        matches: [],
      },
      { status: 500 }
    );
  }
}
