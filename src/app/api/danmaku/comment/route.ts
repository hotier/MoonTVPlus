// 获取弹幕 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getDanmakuApiBaseUrl } from '@/lib/danmaku/config';
import { cacheGet, cacheSet } from '@/lib/danmaku/server-cache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';


// 解析弹幕 XML 为 JSON
function parseXmlDanmaku(xmlText: string): Array<{ p: string; m: string; cid: number }> {
  const comments: Array<{ p: string; m: string; cid: number }> = [];

  // 使用正则表达式提取所有 <d> 标签
  const dTagRegex = /<d\s+p="([^"]+)"[^>]*>([^<]*)<\/d>/g;
  let match;

  while ((match = dTagRegex.exec(xmlText)) !== null) {
    const p = match[1];
    const m = match[2];

    // 从 p 属性中提取 cid（弹幕ID）
    const pParts = p.split(',');
    const cid = pParts[7] ? parseInt(pParts[7]) : 0;

    comments.push({
      p,
      m,
      cid,
    });
  }

  return comments;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const episodeId = searchParams.get('episodeId');
    const url = searchParams.get('url');

    // 至少需要一个参数
    if (!episodeId && !url) {
      return NextResponse.json(
        {
          count: 0,
          comments: [],
        },
        { status: 400 }
      );
    }

    // 服务端缓存：同一集的弹幕内容短时间内不会变（一集可能 6000+ 条、700KB），
    // 首次聚合慢（~4s），命中后所有用户即时返回。
    const cacheKey = episodeId ? `ep:${episodeId}` : `url:${url}`;
    const cached = cacheGet('comment', cacheKey);
    if (cached !== undefined) {
      return NextResponse.json(cached);
    }

    // 从数据库读取弹幕配置
    const config = await getConfig();
    const baseUrl = getDanmakuApiBaseUrl(config.SiteConfig);
    const token = config.SiteConfig.DanmakuApiToken;
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';


    let apiUrl: string;

    if (episodeId) {
      // 通过剧集 ID 获取弹幕 - 使用 XML 格式
      apiUrl = `${baseUrl}/api/v2/comment/${episodeId}?format=xml`;
    } else {
      // 通过视频 URL 获取弹幕 - 使用 XML 格式
      apiUrl = `${baseUrl}/api/v2/comment?url=${encodeURIComponent(url!)}&format=xml`;
    }

    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2分钟超时

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/xml, text/xml',
          'User-Agent': userAgent,
          'Authorization': config.SiteConfig.DanmakuApiToken,
          'X-API-Token': config.SiteConfig.DanmakuApiToken,
        },
        signal: controller.signal,
        keepalive: true,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 获取 XML 文本
      const xmlText = await response.text();

      // 解析 XML 为 JSON
      const comments = parseXmlDanmaku(xmlText);

      const payload = {
        count: comments.length,
        comments,
      };
      // 有弹幕才缓存（空结果可能是上游临时异常，不缓存以便稍后重试）
      if (comments.length > 0) {
        cacheSet('comment', cacheKey, payload);
      }

      return NextResponse.json(payload);
    } catch (fetchError) {
      clearTimeout(timeoutId);

      // 如果是超时错误，返回更友好的错误信息
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('弹幕服务器请求超时，请稍后重试');
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('获取弹幕代理错误:', error);
    return NextResponse.json(
      {
        count: 0,
        comments: [],
      },
      { status: 500 }
    );
  }
}
