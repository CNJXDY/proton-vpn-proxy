# Proton API 中转（Cloudflare Pages）

国内直连 `account.proton.me` / `api.protonvpn.ch` 会超时。本服务部署在 Cloudflare
边缘节点，由它出站访问 Proton，国内只与 `pages.dev` 通信。

## 线上地址

```
https://proton-api-relay.pages.dev
https://proton-api-relay-b.pages.dev
https://proton-api-relay-c.pages.dev
https://proton-api-relay-d.pages.dev
```

四个项目跑同一份 worker、都开了 **Smart Placement**（worker 调度到靠近 Proton 的节点）。
四个域名互为主备，客户端并发竞速或轮询都能用。国内 DNS 干净、可直连。

## 性能优化（实测）

瓶颈不是带宽，是 **TLS 握手**：从国内到 CF 边缘握手要 0.6–4.7s 且偶发挂死到超时，
而连接建好后单请求只要 0.3s。所以所有优化都围绕「绝不重新握手」。

交错 A/B（n=14，同一时间段轮流发，抵消网络漂移）：

| 策略 | min | p50 | p90 |
| --- | --- | --- | --- |
| **四域名并发竞速 + 复用连接** | **314ms** | **349ms** | **1845ms** |
| 单域名固定 + 复用连接 | 322ms | 716ms | 12603ms |
| 每轮强制重新握手（旧做法） | 944ms | 7224ms | 21291ms |

复现：`python bench.py`

四条措施：

1. **常驻 Session + 连接池**，永不 close —— 省掉每次 0.6–4.7s 的握手。
2. **四域名并发竞速**，取最先返回的 —— p90 从 12.6s 压到 1.8s，消灭「某个域名正好挂了」。
3. **超时即丢弃该 host 的连接池重建** —— 半死连接不会污染下一次请求。
4. **短超时快速失败（8s）+ 换 host** —— 比傻等 30s 划算；跨请求保活由
   `ProtonRelay(keepalive=20)` 提供。

配套客户端：[relay_client.py](relay_client.py)

```python
from relay_client import ProtonRelay, vpn_api

with ProtonRelay() as r:                     # 默认四域名竞速
    r.warmup()                               # 可选：提前建链
    resp = r.get(vpn_api("/vpn/logicals"),
                 headers={"Accept": "application/json",
                          "x-pm-appversion": "web-vpn-settings@5.0.999.0"})
    print(resp.status_code, resp.json())
```

进程常驻、调用间隔在几十秒量级的场景，加保活能一直保持 300ms 级别：

```python
r = ProtonRelay(keepalive=20)   # 后台每 20s 打一次 /ping
```

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET /` | 说明页（带探活按钮） |
| `GET /ping` | 极轻量 `pong` 纯文本，用于预热/保活连接（不走 JSON） |
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

# 预热连接（保活用，返回 pong）
curl "https://proton-api-relay.pages.dev/ping"

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

四个项目要一起更新（改 `--project-name` 即可）：

```powershell
foreach ($p in "proton-api-relay","proton-api-relay-b","proton-api-relay-c","proton-api-relay-d") {
  node "$env:APPDATA\npm\node_modules\wrangler\bin\wrangler.js" `
    pages deploy pages --project-name=$p --branch=main --commit-dirty=true
}
```

开 Smart Placement（只对已有部署的项目生效，新建项目后需再执行一次）：

```powershell
$body = '{"deployment_configs":{"production":{"placement":{"mode":"smart"}},"preview":{"placement":{"mode":"smart"}}}}'
Invoke-RestMethod -Method Patch -Headers @{Authorization="Bearer $env:CLOUDFLARE_API_TOKEN";"Content-Type"="application/json"} `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/pages/projects/<项目名>" -Body $body
```

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