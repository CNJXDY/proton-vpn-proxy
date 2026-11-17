"""交替 A/B：同一时间段内交错测量，抵消网络随时间漂移的影响。"""
import statistics
import time

from relay_client import ProtonRelay, DEFAULT_HOSTS

N = 14

race = ProtonRelay(race=True)
pinned = ProtonRelay(hosts=["proton-api-relay-c.pages.dev"], race=False)
cold = ProtonRelay(hosts=["proton-api-relay-c.pages.dev"], race=False)

print(f"warmup: race={race.warmup()*1000:.0f}ms  pinned={pinned.warmup()*1000:.0f}ms")

res = {"race(4域名竞速)": [], "pinned(c单域名)": [], "cold(每轮重握手)": []}
errs = {k: 0 for k in res}


def one(sess, reset=False):
    if reset:
        sess._reset(sess.hosts[0])
    t0 = time.perf_counter()
    try:
        r = sess.get("/ping")
        if r.status_code >= 500:
            return None
        return (time.perf_counter() - t0) * 1000
    except Exception:
        return None


for _ in range(N):
    for key, sess, rst in (
        ("race(4域名竞速)", race, False),
        ("pinned(c单域名)", pinned, False),
        ("cold(每轮重握手)", cold, True),
    ):
        v = one(sess, rst)
        if v is None:
            errs[key] += 1
        else:
            res[key].append(v)

print(f"\n{'策略':22s} {'ok':>4s} {'err':>4s} {'min':>7s} {'p50':>7s} {'p90':>7s}")
for k, xs in res.items():
    if not xs:
        print(f"{k:22s} {0:4d} {errs[k]:4d}  ——")
        continue
    xs.sort()
    print(f"{k:22s} {len(xs):4d} {errs[k]:4d} {xs[0]:7.0f} {statistics.median(xs):7.0f} "
          f"{xs[min(len(xs)-1, int(len(xs)*0.9))]:7.0f}")

race.close(); pinned.close(); cold.close()