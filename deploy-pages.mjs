// 用 Cloudflare Pages 直传 API 部署 _worker.js（无需 wrangler、无需浏览器）
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT;
if (!TOKEN || !ACCOUNT) { console.error('需要 CF_TOKEN / CF_ACCOUNT 环境变量'); process.exit(1); }
const PROJECT = process.env.CF_PROJECT || 'proton-api-relay';
const DIR = process.env.DEPLOY_DIR || join(import.meta.dirname, 'pages');
const BRANCH = 'main';

const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}` };

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

// ---------- 1. 确保项目存在 ----------
console.log(`[1/3] 检查项目 ${PROJECT} ...`);
let r = await api(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`);
if (r.status === 404 || !r.body.success) {
  console.log('      项目不存在，创建...');
  r = await api(`/accounts/${ACCOUNT}/pages/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: PROJECT, production_branch: BRANCH }),
  });
  if (!r.body.success) {
    console.error('创建项目失败:', JSON.stringify(r.body.errors || r.body, null, 2));
    process.exit(1);
  }
  console.log('      已创建');
} else {
  console.log('      已存在 subdomain=' + r.body.result.subdomain);
}

// ---------- 2. 计算 manifest ----------
const files = walk(DIR);
console.log(`[2/3] 打包 ${files.length} 个文件 ...`);
const entries = files.map((f) => {
  const buf = readFileSync(f);
  const hash = createHash('sha256').update(buf).digest('hex');
  let key = '/' + relative(DIR, f).split(sep).join('/');
  return { key, hash, buf };
});
const manifest = {};
for (const e of entries) manifest[e.key] = e.hash;
console.log('      ' + Object.keys(manifest).join(', '));

// ---------- 3. 上传部署 ----------
console.log('[3/3] 上传部署 ...');
const form = new FormData();
form.append('manifest', JSON.stringify(manifest));
form.append('branch', BRANCH);
for (const e of entries) {
  form.append(e.hash, new Blob([e.buf], { type: 'application/javascript' }), e.hash);
}

r = await api(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments`, {
  method: 'POST',
  body: form,
});

if (!r.body.success) {
  console.error('部署失败:', JSON.stringify(r.body.errors || r.body, null, 2));
  process.exit(1);
}

const d = r.body.result;
const url = d.url || `https://${d.aliases?.[0] || PROJECT + '.pages.dev'}`;
console.log('\n=== 部署成功 ===');
console.log('  id      :', d.id);
console.log('  stage   :', d.latest_stage && d.latest_stage.name, '/', d.latest_stage && d.latest_stage.status);
console.log('  url     :', url);
console.log('  aliases :', (d.aliases || []).join(', '));
console.log('\n生产域名: https://' + PROJECT + '.pages.dev');
