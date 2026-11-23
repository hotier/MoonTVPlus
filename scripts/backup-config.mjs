#!/usr/bin/env node
/**
 * 只读：完整备份 Turso 中与源/配置相关的关键数据到本地 .data/backup-<ts>/
 *  - admin_config  (id=1 整份 JSON)
 *  - global_config: duanju, source-script:registry, video.metainfo
 * 不写库。
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
const client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(process.cwd(), '.data', `backup-${ts}`);
fs.mkdirSync(dir, { recursive: true });

// 1) admin_config
const ac = await client.execute('SELECT config, updated_at FROM admin_config WHERE id = 1');
fs.writeFileSync(path.join(dir, 'admin_config.json'), ac.rows[0].config, 'utf8');
console.log('✓ admin_config.json', ac.rows[0].config.length, 'bytes');

// 2) global_config 关键键
const keys = ['duanju', 'source-script:registry', 'video.metainfo'];
for (const k of keys) {
  const r = await client.execute({ sql: 'SELECT value, updated_at FROM global_config WHERE key = ?', args: [k] });
  if (!r.rows.length) { console.log('– 缺 key:', k); continue; }
  const safe = k.replace(/[^a-z0-9]/gi, '_');
  fs.writeFileSync(path.join(dir, `global_${safe}.json`), r.rows[0].value, 'utf8');
  console.log(`✓ global_${safe}.json`, r.rows[0].value.length, 'bytes');
}

// 3) 全表 global_config 兜底导出（key→value 摘要，value 全量）
const all = await client.execute('SELECT key, value FROM global_config');
const dump = {};
for (const row of all.rows) dump[row.key] = row.value;
fs.writeFileSync(path.join(dir, 'global_config_ALL.json'), JSON.stringify(dump, null, 2), 'utf8');
console.log('✓ global_config_ALL.json  keys =', all.rows.length);

console.log('\n备份目录:', dir);
