#!/usr/bin/env node
/**
 * 只读：从 Turso 拉取 admin_config(原始 JSON)，分析它与当前(上游 v227)代码
 * 期望 schema 的差异，并导出原始备份。不写库。
 *
 * 用法：
 *   node scripts/config-report.mjs
 * 读取 .env.local 中的 TURSO_URL / TURSO_TOKEN。
 */
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

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

const url = process.env.TURSO_URL;
const token = process.env.TURSO_TOKEN;
if (!url || !token) { console.error('缺 TURSO_URL / TURSO_TOKEN'); process.exit(1); }

const client = createClient({ url, authToken: token });

const slug = url.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
const outFile = path.join(process.cwd(), `.data/admin-config-raw-${slug}.json`);

const res = await client.execute('SELECT config, updated_at FROM admin_config WHERE id = 1');
if (!res.rows.length) { console.error('admin_config 表没有 id=1 行（可能是空库？）'); process.exit(2); }

const raw = res.rows[0].config;
const updatedAt = res.rows[0].updated_at;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, raw, 'utf8');

let cfg;
try { cfg = JSON.parse(raw); } catch (e) { console.error('config 不是合法 JSON：', e.message); process.exit(3); }

// ---- 分析 ----
const sourceConfig = Array.isArray(cfg.SourceConfig) ? cfg.SourceConfig : [];
const sourceKeys = sourceConfig.map((s) => s.key).filter(Boolean);
const special = Array.isArray(cfg.SpecialSourceApis) ? cfg.SpecialSourceApis : [];
const clientAd = cfg.ClientAdSourceApis;
const bridge = cfg.TVBoxBridgeConfig;
const bridgeSites = Array.isArray(bridge?.Sites) ? bridge.Sites : [];

// 新代码 getAdminVideoSourceKeys = SourceConfig keys + 'tvbox:<siteKey>'
const newKeySet = new Set([...sourceKeys, ...bridgeSites.map((s) => `tvbox:${s.key}`)]);
const specialOrphans = special.filter((k) => !newKeySet.has(k));
const specialOk = special.filter((k) => newKeySet.has(k));

const report = {
  turso_url_masked: url.replace(/\/\/.*@/, '//***@'),
  config_updated_at: updatedAt,
  config_bytes: raw.length,
  exported_to: outFile,
  schema: {
    has_SourceConfig: Array.isArray(cfg.SourceConfig),
    SourceConfig_count: sourceConfig.length,
    has_SpecialSourceApis: Array.isArray(cfg.SpecialSourceApis),
    SpecialSourceApis_count: special.length,
    SpecialSourceApis_resolvable_under_new_code: specialOk.length,
    SpecialSourceApis_orphaned: specialOrphans,
    has_ClientAdSourceApis: Array.isArray(clientAd),
    ClientAdSourceApis_count: Array.isArray(clientAd) ? clientAd.length : null,
    ClientAdSourceApis_note: '该字段在新代码中已被移除，若有值需迁移到自定义字段保存',
    has_TVBoxBridgeConfig: !!bridge,
    TVBoxBridgeConfig_Sites_count: bridgeSites.length,
    has_VideoSourceOrder: Array.isArray(cfg.VideoSourceOrder),
    VideoSourceOrder_count: Array.isArray(cfg.VideoSourceOrder) ? cfg.VideoSourceOrder.length : null,
  },
  top_level_keys: Object.keys(cfg),
  source_keys_sample: sourceKeys.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
console.log('\n原始配置已导出到:', outFile);
