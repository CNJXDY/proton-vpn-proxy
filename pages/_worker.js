/**
 * Proton API 中转 — Cloudflare Pages (Advanced Mode Worker)
 *
 * 国内直连 account.proton.me 会超时。本服务部署在 Cloudflare 边缘，
 * 由它去访问 Proton，国内只跟 pages.dev 通信。
 *
 * 路由:
 *   GET  /                       说明页
 *   GET  /health                 健康检查 + 出站连通性自测
 *   ANY  /proxy/<完整URL>         透明转发到 Proton API
 *   ANY  /p/<host>/<path>         同上，host 用别名（proton | vpn | mail ...）
 *
 * 例:
 *   curl https://xxx.pages.dev/proxy/https://account.proton.me/core/v4/auth/modulus
 *   curl https://xxx.pages.dev/p/proton/core/v4/auth/modulus
 */

const ALLOW_HOSTS = new Set([
  'account.proton.me',
  'api.protonvpn.ch',
  'api.protonvpn.net',
  'api.protonmail.ch',
  'mail.proton.me',
  'drive.proton.me',
  'pass.proton.me',
  'calendar.proton.me',
  'vpn-api.proton.me',
  'protonvpn.com',
  'www.protonvpn.com',
]);

const HOST_ALIAS = {
  proton: 'account.proton.me',
  account: 'account.proton.me',
  vpn: 'api.protonvpn.ch',
  vpn2: 'api.protonvpn.net',
  mail: 'mail.proton.me',
  api: 'api.protonmail.ch',
  drive: 'drive.proton.me',
  pass: 'pass.proton.me',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const SKIP_REQ_HEADERS = new Set([
  'host', 'content-length', 'connection', 'cf-connecting-ip',
  'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
  'accept-encoding',
]);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

function buildTarget(pathname, search) {
  // 形式 1: /proxy/https://host/path
  if (pathname.startsWith('/proxy/')) {
    const raw = pathname.slice('/proxy/'.length) + (search || '');
    if (!/^https?:\/\//i.test(raw)) return { error: 'proxy 后面的目标必须是完整 URL，如 /proxy/https://account.proton.me/...' };
    let u;
    try { u = new URL(raw); } catch { return { error: '目标 URL 解析失败: ' + raw }; }
    if (!ALLOW_HOSTS.has(u.hostname)) return { error: 'host 不在白名单: ' + u.hostname, allowed: [...ALLOW_HOSTS] };
    return { url: u };
  }

  // 形式 2: /p/<alias>/<path>
  if (pathname.startsWith('/p/')) {
    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    const alias = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? '/' : rest.slice(slash);
    const host = HOST_ALIAS[alias];
    if (!host) return { error: '未知别名: ' + alias, aliases: Object.keys(HOST_ALIAS) };
    return { url: new URL('https://' + host + tail + (search || '')) };
  }

  return { error: 'not a proxy path' };
}

async function doProxy(request, target) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (!SKIP_REQ_HEADERS.has(lk) && lk !== 'host') headers.set(k, v);
  }
  if (!headers.has('user-agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  }

  const init = { method: request.method, headers, redirect: 'follow' };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (e) {
    return json({ ok: false, error: 'upstream_fetch_failed', target: target.toString(), detail: String((e && e.message) || e), ms: Date.now() - t0 }, 502);
  }

  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'set-cookie') continue;
    outHeaders.set(k, v);
  }
  for (const c of upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : []) {
    outHeaders.append('Set-Cookie', c);
  }
  for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);
  outHeaders.set('X-Upstream-Status', String(upstream.status));
  outHeaders.set('X-Upstream-Ms', String(Date.now() - t0));

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Proton API 中转</title>
<style>
  body{font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1b1b1f;background:#fbfbfd}
  h1{font-size:22px}code,pre{font-family:ui-monospace,Consolas,monospace;background:#f0f0f4;border-radius:5px;padding:2px 6px;font-size:13px}
  pre{padding:12px;overflow:auto}button{padding:7px 14px;border:1px solid #c8c8d0;background:#fff;border-radius:7px;cursor:pointer}
  .muted{color:#6b6b76}
</style>
<h1>Proton API 中转</h1>
<p class="muted">部署在 Cloudflare 边缘，国内经此访问 Proton。</p>
<h3>用法</h3>
<pre># 完整 URL 形式
curl "https://<此域名>/proxy/https://account.proton.me/api/core/v4/auth/modulus"</pre>
<pre># 别名形式（推荐）
curl "https://<此域名>/p/proton/api/core/v4/auth/modulus"</pre>
<p class="muted">注意：Proton 账户 API 的路径前缀是 <code>/api/core/v4/</code>，少了 <code>/api</code> 会命中前端页面。</p>
<p>别名：<code>proton</code> <code>account</code> <code>vpn</code> <code>vpn2</code> <code>mail</code> <code>api</code> <code>drive</code> <code>pass</code></p>
<h3>探活</h3>
<p><button onclick="t()">测试出站到 Proton</button></p>
<pre id="out" class="muted">—</pre>
<script>
async function t(){
  const o=document.getElementById('out'); o.textContent='请求中…';
  try{
    const r=await fetch('/health?probe=1');
    o.textContent=JSON.stringify(await r.json(),null,2);
  }catch(e){ o.textContent='失败: '+e.message; }
}
</script>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/health') {
      const base = { ok: true, service: 'proton-api-relay', runtime: 'cloudflare-pages', host: url.host, time: new Date().toISOString() };
      if (url.searchParams.get('probe')) {
        const probe = { account_proton_me: null, api_protonvpn_ch: null };
        for (const [key, host] of [['account_proton_me', 'account.proton.me'], ['api_protonvpn_ch', 'api.protonvpn.ch']]) {
          const t0 = Date.now();
          try {
            const r = await fetch('https://' + host + '/', { method: 'GET', redirect: 'manual' });
            probe[key] = { status: r.status, ms: Date.now() - t0, ok: true };
          } catch (e) {
            probe[key] = { ok: false, ms: Date.now() - t0, detail: String(e && e.message || e) };
          }
        }
        base.probe = probe;
      }
      return json(base);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
    }

    const t = buildTarget(url.pathname, url.search);
    if (t.error) {
      return json({
        ok: false,
        error: t.error,
        allowed: t.allowed || [...ALLOW_HOSTS],
        aliases: t.aliases,
        routes: ['/health', '/proxy/<full-url>', '/p/<alias>/<path>'],
      }, 400);
    }
    try {
      return await doProxy(request, t.url);
    } catch (e) {
      return json({ ok: false, error: 'proxy_exception', target: t.url.toString(), detail: String((e && e.stack) || e) }, 500);
    }
  },
};