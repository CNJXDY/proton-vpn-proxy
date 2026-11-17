#!/usr/bin/env python3
"""
Proton 中转客户端 — 为国内网络优化。

实测结论（本机国内网络，2026-11）：
  TLS 握手      0.6s ~ 4.7s，偶发直接挂死到超时   ← 真正的瓶颈
  TCP 建连      0.22 ~ 0.30s
  复用连接请求   0.27s                            ← 优化目标

所以优化策略是「绝不重新握手」：
  1. 常驻 Session + 连接池，永不 close
  2. 后台保活线程定时打 /ping，防止 NAT/CF 回收空闲连接
  3. 双域名并发竞速，取最先返回的
  4. 任一 host 超时 → 立刻丢弃该 host 的连接池重建（坏连接不传染下一次请求）
  5. 短超时快速失败 + 换 host 重试，比等 30s 划算

用法：
    from relay_client import ProtonRelay, vpn_api

    with ProtonRelay() as r:
        r.warmup()                     # 建好链路（可选，第一次请求会自动建）
        resp = r.get(vpn_api("/vpn/logicals"),
                     headers={"Accept": "application/json",
                              "x-pm-appversion": "web-vpn-settings@5.0.999.0"})

命令行：
    python relay_client.py bench        # 延迟基准
    python relay_client.py bench --cold # 对照：每次强制重新握手
    python relay_client.py warm 300     # 保活 300 秒
    python relay_client.py get /p/vpn/vpn/logicals
"""
from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterable

import requests
from requests.adapters import HTTPAdapter

DEFAULT_HOSTS = (
    "proton-api-relay.pages.dev",
    "proton-api-relay-b.pages.dev",
    "proton-api-relay-c.pages.dev",
    "proton-api-relay-d.pages.dev",
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 单次尝试的上限。握手挂死时 8s 就够判定死亡，等 30s 纯浪费。
ATTEMPT_TIMEOUT = 8.0


class ProtonRelay:
    def __init__(
        self,
        hosts: Iterable[str] = DEFAULT_HOSTS,
        timeout: float = ATTEMPT_TIMEOUT,
        max_retries: int = 3,
        race: bool = True,
        keepalive: float = 0.0,
    ) -> None:
        self.hosts = [h if h.startswith("http") else f"https://{h}" for h in hosts]
        self.timeout = timeout
        self.max_retries = max_retries
        self.race = race and len(self.hosts) > 1
        self._sessions: dict[str, requests.Session] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=max(2, len(self.hosts)), thread_name_prefix="relay")
        self._stop = threading.Event()
        self._ka: threading.Thread | None = None
        if keepalive > 0:
            self.start_keepalive(keepalive)

    # ---------- session 管理 ----------
    def _make_session(self) -> requests.Session:
        s = requests.Session()
        # pool_maxsize 要 >= 并发数；block=False 让超出的请求自己新建连接而不是排队
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16, pool_block=False, max_retries=0)
        s.mount("https://", adapter)
        s.headers.update({"User-Agent": UA, "Accept-Encoding": "gzip, deflate, br"})
        return s

    def _session(self, base: str) -> requests.Session:
        s = self._sessions.get(base)
        if s is None:
            with self._lock:
                s = self._sessions.get(base)
                if s is None:
                    s = self._make_session()
                    self._sessions[base] = s
        return s

    def _reset(self, base: str) -> None:
        """丢弃某 host 的整个连接池：握手挂死后残留的半死连接会拖累后续请求。"""
        with self._lock:
            old = self._sessions.pop(base, None)
        if old is not None:
            try:
                old.close()
            except Exception:
                pass

    # ---------- 传输 ----------
    def _once(self, base: str, method: str, path: str, **kw) -> requests.Response:
        return self._session(base).request(method, base + path, timeout=self.timeout, **kw)

    def _try_hosts(self, method: str, path: str, **kw) -> requests.Response:
        last: Exception | None = None
        for attempt in range(self.max_retries):
            for base in self.hosts:
                try:
                    r = self._once(base, method, path, **kw)
                    if r.status_code < 500:
                        return r
                    last = requests.HTTPError(f"{base} -> {r.status_code}")
                except requests.Timeout as e:
                    self._reset(base)          # 坏连接立刻扔
                    last = e
                except requests.RequestException as e:
                    self._reset(base)
                    last = e
            if attempt < self.max_retries - 1:
                time.sleep(min(0.6 * (attempt + 1), 2.0))
        raise last if last else RuntimeError("relay: no host succeeded")

    def _race_hosts(self, method: str, path: str, **kw) -> requests.Response:
        futs = {self._pool.submit(self._once, b, method, path, **kw): b for b in self.hosts}
        errors: list[Exception] = []
        try:
            for fut in as_completed(futs):
                try:
                    r = fut.result()
                except requests.RequestException as e:
                    self._reset(futs[fut])
                    errors.append(e)
                    continue
                if r.status_code < 500:
                    return r
                errors.append(requests.HTTPError(f"{futs[fut]} -> {r.status_code}"))
        finally:
            for f in futs:
                f.cancel()
        raise errors[-1] if errors else RuntimeError("relay: all hosts failed")

    # ---------- 对外 ----------
    def request(self, method: str, path: str, **kw) -> requests.Response:
        if not path.startswith("/"):
            path = "/" + path
        racer = self._race_hosts if self.race else self._try_hosts
        try:
            return racer(method, path, **kw)
        except Exception:
            return self._try_hosts(method, path, **kw)

    def get(self, path: str, **kw) -> requests.Response:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw) -> requests.Response:
        return self.request("POST", path, **kw)

    def warmup(self, timeout: float | None = None) -> float:
        """并行建好所有 host 的 TLS 链路。返回最慢一条耗时(秒)，不抛异常。"""
        tmo = timeout or self.timeout
        worst = 0.0

        def one(base: str) -> float:
            t0 = time.perf_counter()
            try:
                self._session(base).get(base + "/ping", timeout=tmo)
            except requests.RequestException:
                self._reset(base)
            return time.perf_counter() - t0

        futs = [self._pool.submit(one, b) for b in self.hosts]
        for f in as_completed(futs):
            worst = max(worst, f.result())
        return worst

    def start_keepalive(self, interval: float = 20.0) -> None:
        """后台定时打 /ping，把 TLS 链路钉住，避免下次请求重新握手。"""
        if self._ka is not None:
            return
        self._ka = threading.Thread(target=self._keepalive_loop, args=(interval,), daemon=True, name="relay-keepalive")
        self._ka.start()

    def _keepalive_loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            for base in self.hosts:
                try:
                    self._session(base).get(base + "/ping", timeout=min(6.0, self.timeout))
                except requests.RequestException:
                    self._reset(base)

    def stop_keepalive(self) -> None:
        self._stop.set()
        if self._ka is not None:
            self._ka.join(timeout=2)
            self._ka = None

    def close(self) -> None:
        self.stop_keepalive()
        for s in list(self._sessions.values()):
            try:
                s.close()
            except Exception:
                pass
        self._sessions.clear()
        self._pool.shutdown(wait=False, cancel_futures=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ---------- 便捷路径 ----------
def proton_api(path: str) -> str:
    """account.proton.me 路径 -> 中转路径。账户 API 真实前缀是 /api/core/v4/。"""
    return "/p/proton" + ("" if path.startswith("/") else "/") + path


def vpn_api(path: str) -> str:
    return "/p/vpn" + ("" if path.startswith("/") else "/") + path


# ---------- CLI ----------
def _bench(cold: bool = False) -> None:
    r = ProtonRelay(keepalive=0)
    print(f"hosts = {r.hosts}")
    t = r.warmup()
    print(f"warmup(并行建链) 最慢 : {t*1000:6.0f} ms")

    def timed(label: str, path: str, headers: dict | None = None, n: int = 6) -> None:
        xs, code = [], "-"
        for _ in range(n):
            if cold:
                r._reset(r.hosts[0])          # 强制重新握手作对照
            t0 = time.perf_counter()
            try:
                resp = r.get(path, headers=headers or {})
                xs.append((time.perf_counter() - t0) * 1000)
                code = resp.status_code
            except Exception as e:
                xs.append(float("nan"))
                code = type(e).__name__
        ok = [x for x in xs if x == x]
        if ok:
            ok.sort()
            print(f"{label:26s} n={n} min={ok[0]:6.0f} p50={ok[len(ok)//2]:6.0f} max={ok[-1]:6.0f} ms  last={code}")
        else:
            print(f"{label:26s} 全部失败 ({code})")

    timed("复用连接 /ping", "/ping")
    timed("复用连接 /health", "/health")
    timed("Proton VPN /logicals", vpn_api("/vpn/logicals"),
          headers={"Accept": "application/json",
                   "x-pm-appversion": "web-vpn-settings@5.0.999.0"})
    r.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args else "ping"

    if cmd == "bench":
        _bench(cold="--cold" in args)
    elif cmd == "warm":
        secs = float(args[1]) if len(args) > 1 else 120.0
        with ProtonRelay(keepalive=20) as r:
            print(f"warmup {r.warmup()*1000:.0f} ms, 保活中 {secs:.0f}s (每 20s 一次)")
            time.sleep(secs)
            t0 = time.perf_counter()
            print("保活后 /ping ->", r.get("/ping").status_code, f"{(time.perf_counter()-t0)*1000:.0f} ms")
    elif cmd == "ping":
        with ProtonRelay() as r:
            print("warmup:", f"{r.warmup()*1000:.0f} ms")
            for _ in range(3):
                t0 = time.perf_counter()
                resp = r.get("/ping")
                print(f"  /ping -> {resp.status_code} {resp.text} {(time.perf_counter()-t0)*1000:.0f} ms")
    elif cmd in ("get", "post") and len(args) > 1:
        with ProtonRelay() as r:
            resp = r.request(cmd.upper(), args[1])
            print(resp.status_code)
            print(resp.text[:2000])
    else:
        print(__doc__)