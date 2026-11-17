# Proton API 中转（Cloudflare Pages）

国内直连 `account.proton.me` / `api.protonvpn.ch` 会超时。本服务部署在 Cloudflare
边缘节点，由它出站访问 Proton，国内只与 `pages.dev` 通信。

## 线上地址

```
https://proton-api-relay.pages.dev
```

`pages.dev` 在国内 DNS 干净、可直连（实测 TCP+TLS 通，`/health` 约 2–5s）。

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET /` | 说明页（带探活按钮） |
| `GET /health` | 健康检查 |
| `GET /health?probe=1` | 额外做一次 CF 边缘 → Proton 的出站探测 |
| `ANY /proxy/<完整URL>` | 透明转发到白名单内的 Proton 主机 |
| `ANY /p/<别名>/<path>` | 同上，别名写法更短 |

### 别名 → 主机

| 别名 | 目标主机 |
| --- | --- |
| `proton` / `account` | `account.proton.me` |
| `vpn` | `api.protonvpn.ch` |
| `vpn2` | `api.protonvpn.net` |
| `mail` | `mail.proton.me` |
| `api` | `api.protonmail.ch` |
| `drive` | `drive.proton.me` |
| `pass` | `pass.proton.me` |

白名单外的 host 直接 400，避免被当成开放代理。

## 用法

```bash
# 健康检查 + 出站探测
curl "https://proton-api-relay.pages.dev/health?probe=1"

# 账户 API（注意前缀是 /api/core/v4/，少 /api 会命中前端 SPA 页面）
curl "https://proton-api-relay.pages.dev/p/proton/api/core/v4/auth/modulus" \
  -H "Accept: application/json" \
  -H "x-pm-appversion: web-account@5.0.999.0"

# VPN API
curl "https://proton-api-relay.pages.dev/p/vpn/vpn/logicals" \
  -H "Accept: application/json" \
  -H "x-pm-appversion: web-vpn-settings@5.0.999.0"
```

实测返回（说明转发链路是通的）：

```json
{"Code":5002,"Error":"Missing x-pm-appversion header","Details":{}}
{"Code":401,"Error":"Invalid access token","Details":{}}
```

这两个都是 **Proton 自己返回的 JSON 错误**，代表请求已经完整抵达 Proton。

## 部署 / 更新

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<account_id>"
node "$env:APPDATA\npm\node_modules\wrangler\bin\wrangler.js" `
  pages deploy pages --project-name=proton-api-relay --branch=main --commit-dirty=true
```

`pages/` 目录里只需要 `_worker.js`（Pages Advanced Mode）。
`wrangler` 必须用官方 CLI 上传，手工调直传 API 会出现
`uses_functions: false` + 全路径 500（worker 没被识别）。

## 免费额度

Cloudflare Pages 免费版：不限带宽、每日 10 万次函数调用、单次请求 CPU 10ms。
对本用途足够。

## 已知限制

- 只转发白名单 host，不做通用 HTTP 代理。
- Proton 部分接口（如带 `x-pm-uid` 的 `auth/modulus`）会被上游 tarpit，响应很慢甚至超时；
  这是 Proton 侧的反滥用行为，不是中转的问题。
- 不缓存、不改写 `Set-Cookie`，会话相关行为原样透传。
- `*.workers.dev` 在国内被 DNS 污染（解析到 `157.240.9.36`，Meta 的 IP），
  所以走 Pages 的 `pages.dev` 而不是 Workers。