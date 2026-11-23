#!/usr/bin/env node
/**
 * 修复：把 global_config.duanju 里的源回填到 admin_config.SourceConfig，
 * 并补齐新 schema 字段，使新代码 getAvailableApiSites() 能读到源、
 * configSelfCheck() 不再把空 SourceConfig 当权威来源过滤。
 *
 * 默认 dry-run（不写库）；加 --apply 才写入。
 *
 * 用法：
 *   node scripts/fix-sources.mjs            # 预览
 *   node scripts/fix-sources.mjs --apply    # 真正写入
 */
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');

function loadEnv(file) {
  const abs = path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) return;
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv('.env.local');
const client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });

// 读 duanju
const dj = await client.execute("SELECT value FROM global_config WHERE key = 'duanju'");
if (!dj.rows.length) { console.error('duanju 不存在，终止'); process.exit(1); }
const duanjuSources = JSON.parse(dj.rows[0].value);
if (!duanjuSources.length) { console.error('duanju 为空，终止（避免把空源写进去）'); process.exit(1); }

// 读 admin_config
const ac = await client.execute('SELECT config FROM admin_config WHERE id = 1');
const cfg = ac.rows.length ? JSON.parse(ac.rows[0].config) : {};

// 构造 SourceConfig：以 duanju 为准，保留已有 SourceConfig 中 duanju 没有的源
const existing = Array.isArray(cfg.SourceConfig) ? cfg.SourceConfig : [];
const byKey = new Map();
for (const s of existing) if (s && s.key) byKey.set(s.key, s);
for (const s of duanjuSources) {
  byKey.set(s.key, {
    // 保留已有额外字段，覆盖关键字段
    ...(byKey.get(s.key) || {}),
    key: s.key,
    name: s.name,
    api: s.api,
    detail: byKey.get(s.key)?.detail ?? s.name,
    disabled: byKey.get(s.key)?.disabled ?? false,
    weight: byKey.get(s.key)?.weight ?? 0,
  });
}
const newSourceConfig = Array.from(byKey.values());

// 补齐新 schema 字段（只做加法）
const before = JSON.stringify(cfg).length;
cfg.SourceConfig = newSourceConfig;
cfg.SpecialSourceApis = Array.isArray(cfg.SpecialSourceApis) ? cfg.SpecialSourceApis : [];
cfg.VideoSourceOrder = Array.isArray(cfg.VideoSourceOrder)
  ? Array.from(new Set([...cfg.VideoSourceOrder, ...newSourceConfig.map((s) => s.key)]))
  : newSourceConfig.map((s) => s.key);
cfg.TVBoxBridgeConfig ??= { BaseUrl: '', Sites: [], BlockedLocalSites: [] };
// 保留旧 ClientAdSourceApis 到自定义字段，避免丢失
if (Array.isArray(cfg.ClientAdSourceApis) && cfg.ClientAdSourceApis.length) {
  cfg.__legacyClientAdSourceApis = cfg.ClientAdSourceApis;
}

console.log('=== 将写入 SourceConfig ===');
console.log('原 SourceConfig 条数:', existing.length);
console.log('duanju 源条数:', duanjuSources.length);
console.log('合并后 SourceConfig 条数:', newSourceConfig.length);
console.log('VideoSourceOrder 条数:', cfg.VideoSourceOrder.length);
console.log('字段体积:', before, '->', JSON.stringify(cfg).length, 'bytes');
console.log('\n前 5 条源预览:');
newSourceConfig.slice(0, 5).forEach((s) => console.log('  -', s.key, '|', s.name, '| disabled=', s.disabled));

if (!APPLY) {
  console.log('\n[dry-run] 未写库。确认无误后加 --apply 执行。');
  process.exit(0);
}

// 写前再备份一次
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(process.cwd(), '.data', `backup-beforesourcesfix-${ts}`);
fs.mkdirSync(dir, { recursive: true });
if (ac.rows.length) fs.writeFileSync(path.join(dir, 'admin_config.json'), ac.rows[0].config, 'utf8');

await client.execute({
  sql: 'UPDATE admin_config SET config = ?, updated_at = ? WHERE id = 1',
  args: [JSON.stringify(cfg), Date.now()],
});
console.log('\n✅ 已写入 admin_config.SourceConfig，备份在:', dir);
