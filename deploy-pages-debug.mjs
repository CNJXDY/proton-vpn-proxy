// 调试版：明确 content-type，同时带 index.html，验证 Pages Functions 是否生效
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT;
const PROJECT = process.argv[2] || 'proton-api-relay';
const DIR = join(import.meta.dirname, 'pages');
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}` };

const CT = {
  '.js': 'application/javascript+module',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
};

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}
const hashOf = (b) => createHash('sha256').update(b).digest('hex');

const files = walk(DIR);
const entries = files.map((f) => {
  const buf = readFileSync(f);
  const key = '/' + relative(DIR, f).split(sep).join('/');
  const ext = key.slice(key.lastIndexOf('.'));
  return { key, buf, hash: hashOf(buf), ct: CT[ext] || 'application/octet-stream' };
});

const manifest = {};
for (const e of entries) manifest[e.key] = e.hash;
console.log('manifest:', JSON.stringify(manifest, null, 2));

const form = new FormData();
form.append('manifest', JSON.stringify(manifest));
for (const e of entries) {
  form.append(e.hash, new Blob([e.buf], { type: e.ct }), e.hash);
}

const res = await fetch(`${API}/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments`, {
  method: 'POST',
  headers: H,
  body: form,
});
const body = await res.json();
if (!body.success) {
  console.log('FAIL', res.status, JSON.stringify(body.errors, null, 2));
  process.exit(1);
}
const d = body.result;
console.log('\nOK id=' + d.id);
console.log('   uses_functions=' + d.uses_functions);
console.log('   files=' + JSON.stringify((d.files || []).map((f) => f.name)));
console.log('   url=' + d.url);
