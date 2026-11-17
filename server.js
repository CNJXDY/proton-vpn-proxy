const express = require('express');
const https = require('https');
const http = require('http');
const url = require('url');
const { HttpsProxyAgent, HttpProxyAgent } = require('https-proxy-agent');
const { HttpsProxyAgent: HPA2 } = require('https-proxy-agent');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ====== Proton VPN Proxy Config ======
// Proton VPN relay endpoint. We forward client requests through an
// optional upstream proxy to Proton's relay infrastructure.
//
// Env vars:
//   PROTON_PROXY_HOST   - upstream SOCKS/HTTP proxy (optional, for outbound)
//   PROTON_AUTH_TOKEN   - Proton account API token for authenticated relay
//   PROTON_RELAY_HOST   - Proton relay hostname
//   PROTON_RELAY_PORT   - Proton relay port
//   UPSTREAM_PROXY      - optional upstream HTTP proxy for outbound
// =============================

const PROTON_RELAY_HOST = process.env.PROTON_RELAY_HOST || 'relay.protonvpn.net';
const PROTON_RELAY_PORT = parseInt(process.env.PROTON_RELAY_PORT) || 443;
const PROTON_AUTH_TOKEN = process.env.PROTON_AUTH_TOKEN || '';
const UPSTREAM_PROXY    = process.env.UPSTREAM_PROXY || '';

// Pick agent based on upstream
function getAgent() {
  if (UPSTREAM_PROXY) {
    return new HttpsProxyAgent(UPSTREAM_PROXY);
  }
  return undefined; // direct
}

// ====== Health check ======
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'proton-vpn-proxy',
    relay: PROTON_RELAY_HOST,
    relayPort: PROTON_RELAY_PORT,
    upstreamProxy: UPSTREAM_PROXY || 'direct',
    hasAuthToken: !!PROTON_AUTH_TOKEN,
    uptime: process.uptime(),
  });
});

// ====== Relay endpoint ======
// Forwards a GET/POST request to the Proton relay.
//
//   GET  /relay?path=/api/v1/session
//   POST /relay  body={path:"/api/v1/auth", method:"POST", headers:{}, body:{...}}
app.use('/relay', (req, res) => {
  const targetPath = req.query.path || (req.body && req.body.path) || '/';
  const method = req.method === 'POST'
    ? ((req.body && req.body.method) || 'POST')
    : 'GET';

  const reqHeaders = {
    'Host': PROTON_RELAY_HOST,
    'User-Agent': 'proton-vpn-proxy/1.0',
    'Accept': '*/*',
  };

  if (PROTON_AUTH_TOKEN) {
    reqHeaders['Authorization'] = 'Bearer ' + PROTON_AUTH_TOKEN;
  }

  // Merge client-supplied headers
  if (req.body && req.body.headers) {
    Object.assign(reqHeaders, req.body.headers);
  }

  const reqBody = (req.body && req.body.body) ? JSON.stringify(req.body.body) : null;
  if (reqBody) {
    reqHeaders['Content-Type'] = 'application/json';
    reqHeaders['Content-Length'] = Buffer.byteLength(reqBody);
  }

  const options = {
    hostname: PROTON_RELAY_HOST,
    port: PROTON_RELAY_PORT,
    path: targetPath,
    method: method,
    headers: reqHeaders,
    agent: getAgent(),
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (_) {}

      res.status(proxyRes.statusCode || 200).json({
        relayStatus: proxyRes.statusCode,
        relayHeaders: proxyRes.headers,
        relayBody: parsed,
      });
    });
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({
      ok: false,
      error: 'relay_error',
      detail: err.message,
    });
  });

  if (reqBody) proxyReq.write(reqBody);
  proxyReq.end();
});

// ====== Register endpoint (uses Proton account API) ======
// Wraps account.proton.me/v1/registers
app.post('/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password required' });
  }

  const body = JSON.stringify({ Email: email, Password: password });

  const options = {
    hostname: 'account.proton.me',
    port: 443,
    path: '/v1/registers',
    method: 'POST',
    headers: {
      'Host': 'account.proton.me',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'proton-vpn-proxy/1.0',
      'Accept': 'application/json',
    },
    agent: getAgent(),
  };

  const regReq = https.request(options, (proxyRes) => {
    let chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (_) {}
      res.status(proxyRes.statusCode || 200).json({
        registerStatus: proxyRes.statusCode,
        registerResponse: parsed,
      });
    });
  });

  regReq.on('error', (err) => {
    res.status(502).json({ ok: false, error: 'register_error', detail: err.message });
  });

  regReq.write(body);
  regReq.end();
});

// ====== Root ======
app.get('/', (req, res) => {
  res.json({
    service: 'proton-vpn-proxy',
    endpoints: {
      '/health': 'GET — service status',
      '/relay':  'GET/POST — forward to Proton relay',
      '/register': 'POST — register Proton account',
    },
    version: '1.0.0',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[proton-vpn-proxy] listening on :${PORT}`);
  console.log(`  relay target: ${PROTON_RELAY_HOST}:${PROTON_RELAY_PORT}`);
  console.log(`  upstream proxy: ${UPSTREAM_PROXY || 'direct'}`);
});
