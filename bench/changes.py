#!/usr/bin/env python3
"""Run-to-run headlines: what changed between each weekly run and the one before it. The page
shows them and bench/post.py turns the latest into a Nostr note.

The performance index here is the page's (site/app.js): each test against strfry in the same
run, geometric mean per area, overall = geometric mean of the four index areas. Keep the two
in step if the method changes."""
import json, math, sys, tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "strfry"
# area -> [(test, higher_is_better)]; mirrors AREAS in site/app.js
AREAS = {
    "Writing": [("ingest", 1), ("ingest_dup", 1), ("write_roundtrip", 1)],
    "Reading": [(t, 1) for t in ("latest_1", "latest_100", "latest_500", "author", "kind", "author_kind", "tag",
                                 "time_window", "exact_id", "exact_ids_100", "miss", "multi_filter")],
    "Live delivery": [("fanout", 0)],
    "Connections": [("idle", 1)],
}
NAMES = {"ingest": "bulk ingest", "ingest_dup": "duplicate resends", "write_roundtrip": "one-at-a-time writes",
         "latest_1": "newest event", "latest_100": "newest 100", "latest_500": "newest 500", "author": "by-author reads",
         "kind": "by-kind reads", "author_kind": "author+kind reads", "tag": "tag reads", "time_window": "time-window reads",
         "exact_id": "by-id reads", "exact_ids_100": "100-id reads", "miss": "no-match reads", "multi_filter": "multi-filter REQs",
         "fanout": "live fan-out", "idle": "idle connections", "dm_inbox": "gift-wrap inbox", "dm_catchup": "inbox catch-up",
         "dm_ids": "gift wraps by id", "concord_page": "community page", "concord_paging": "community paging", "count": "COUNT",
         "neg_light_90": "negentropy (small)", "neg_heavy_90": "negentropy (large)"}
MOVE = 0.10        # a relay's overall index moving more than this is a headline
TEST_MOVE = 0.50   # so is a single test moving more than this


def value(r, tid):
    m = (r.get("metrics") or {}).get(tid)
    if not m:
        return None, "missing"
    if tid == "fanout":
        return (m.get("p50_us") or 0) / 1000 or None, m.get("status", "missing")
    return m.get("v"), m.get("status", "missing")


def ratio(r, base, tid, up):
    a, sa = value(r, tid)
    b, sb = value(base, tid)
    if sa == "ok" and sb == "ok" and a and b:
        return a / b if up else b / a
    return None


def geo(xs):
    return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else None


def index(r, base):
    if not base or r.get("perf_skipped"):
        return None
    areas = {}
    for name, tests in AREAS.items():
        areas[name] = geo([x for t, up in tests if (x := ratio(r, base, t, up)) is not None])
    parts = [v for v in areas.values() if v]
    return {"overall": 100 * geo(parts) if parts else None, **{k: v and 100 * v for k, v in areas.items()}}


def cap_scores():
    crit = tomllib.loads((ROOT / "capability" / "criteria.toml").read_text(encoding="utf-8"))["criterion"]
    out = {}
    for f in (ROOT / "capability" / "relays").glob("*.toml"):
        s = tomllib.loads(f.read_text(encoding="utf-8")).get("scores", {})
        out[f.stem] = round(100 * sum(c["weight"] * s.get(c["id"], 0) for c in crit) / (3 * sum(c["weight"] for c in crit)))
    return out


def pct(a, b):
    return f"{'+' if b >= a else '−'}{abs(b / a - 1) * 100:.0f}%"


def n(v):
    return f"{v:,.0f}" if v >= 100 else f"{v:.3g}"


def diff(prev, cur, caps_prev, caps_cur):
    """Headlines between two runs. Each item: relay, kind, text, weight (for ordering), good (up/down/None)."""
    items = []
    bp, bc = prev["relays"].get(BASE), cur["relays"].get(BASE)
    idx_p = {k: index(r, bp) for k, r in prev["relays"].items()}
    idx_c = {k: index(r, bc) for k, r in cur["relays"].items()}
    names = {k: r.get("name", k) for k, r in {**prev["relays"], **cur["relays"]}.items()}

    for rid in sorted(set(cur["relays"]) - set(prev["relays"])):
        items.append({"relay": rid, "kind": "new", "good": None, "weight": 50,
                      "text": f"{names[rid]} joins the bench" + (f" at {n(idx_c[rid]['overall'])}" if idx_c[rid] and idx_c[rid]["overall"] else "")})
    for rid in sorted(set(prev["relays"]) - set(cur["relays"])):
        items.append({"relay": rid, "kind": "gone", "good": None, "weight": 20, "text": f"{names[rid]} wasn't in this run"})

    for rid in sorted(set(cur["relays"]) & set(prev["relays"])):
        a, b = prev["relays"][rid], cur["relays"][rid]
        name = names[rid]
        if a.get("version") != b.get("version") and b.get("version"):
            items.append({"relay": rid, "kind": "version", "good": None, "weight": 40,
                          "text": f"{name} {a.get('version') or '?'} → {b['version']}"})
        if b.get("error") and not a.get("error"):
            items.append({"relay": rid, "kind": "broke", "good": False, "weight": 90, "text": f"{name}'s perf run failed: {b['error'][:120]}"})
        elif a.get("error") and not b.get("error"):
            items.append({"relay": rid, "kind": "fixed", "good": True, "weight": 60, "text": f"{name} runs again"})
        ia, ib = idx_p.get(rid), idx_c.get(rid)
        if ia and ib and ia["overall"] and ib["overall"] and abs(ib["overall"] / ia["overall"] - 1) >= MOVE:
            up = ib["overall"] > ia["overall"]
            area = max((k for k in AREAS if ia.get(k) and ib.get(k)), key=lambda k: abs(math.log(ib[k] / ia[k])), default=None)
            items.append({"relay": rid, "kind": "perf", "good": up, "weight": 70 + 20 * abs(math.log(ib["overall"] / ia["overall"])),
                          "text": f"{name} performance {n(ia['overall'])} → {n(ib['overall'])} ({pct(ia['overall'], ib['overall'])})"
                                  + (f", mostly {area.lower()}" if area else "")})
        # single tests that flipped between right and wrong, or moved a lot on their own
        broke, fixed = [], []
        for tid, label in NAMES.items():
            va, sa = value(a, tid)
            vb, sb = value(b, tid)
            if sa == "ok" and sb in ("wrong", "refused"):
                broke.append(label)
            elif sa in ("wrong", "refused") and sb == "ok":
                fixed.append(label)
            elif sa == sb == "ok" and va and vb and tid != "fanout" and abs(vb / va - 1) >= TEST_MOVE and not (ia and ib and ia["overall"] and ib["overall"] and abs(ib["overall"] / ia["overall"] - 1) >= MOVE):
                items.append({"relay": rid, "kind": "test", "good": vb > va, "weight": 30, "text": f"{name}: {label} {n(va)} → {n(vb)} ({pct(va, vb)})"})
        if broke:
            items.append({"relay": rid, "kind": "test", "good": False, "weight": 80,
                          "text": f"{name} now fails or refuses {len(broke)} test{'s' if len(broke) > 1 else ''}: {', '.join(broke)}"})
        if fixed:
            items.append({"relay": rid, "kind": "test", "good": True, "weight": 75,
                          "text": f"{name} fixed {len(fixed)} test{'s' if len(fixed) > 1 else ''}: {', '.join(fixed)}"})
        ta, tb = a.get("tester") or {}, b.get("tester") or {}
        if ta.get("required_total") and tb.get("required_total") and ta["required_pass"] != tb["required_pass"]:
            d = tb["required_pass"] - ta["required_pass"]
            items.append({"relay": rid, "kind": "correct", "good": d > 0, "weight": 85,
                          "text": f"{name} {'passes' if d > 0 else 'fails'} {abs(d)} more required check{'s' if abs(d) > 1 else ''} ({tb['required_pass']}/{tb['required_total']})"})
        if caps_prev and caps_cur and rid in caps_prev and rid in caps_cur and caps_prev[rid] != caps_cur[rid]:
            items.append({"relay": rid, "kind": "capability", "good": caps_cur[rid] > caps_prev[rid], "weight": 45,
                          "text": f"{name} capability {caps_prev[rid]} → {caps_cur[rid]}"})

    # Every index is relative to strfry, so when strfry itself moves, say so before anything else.
    if bp and bc:
        moves = [x for tests in AREAS.values() for t, up in tests if (x := ratio(bc, bp, t, up)) is not None]
        g = geo(moves)
        if g and abs(g - 1) >= MOVE:
            items.append({"relay": BASE, "kind": "baseline", "good": None, "weight": 96,
                          "text": f"strfry itself measured {pct(1, g)} against last run, so every index shifts the other way"})

    lead = lambda idx: max((k for k, v in idx.items() if v and v["overall"]), key=lambda k: idx[k]["overall"], default=None)
    lp, lc = lead(idx_p), lead(idx_c)
    if lc and lp != lc:
        items.append({"relay": lc, "kind": "lead", "good": True, "weight": 95, "text": f"{names[lc]} takes the top performance index from {names.get(lp, lp)}"})
    return sorted(items, key=lambda i: -i["weight"])


def first_run(cur, caps):
    """No previous run: lead with who's on top."""
    base = cur["relays"].get(BASE)
    idx = {k: index(r, base) for k, r in cur["relays"].items()}
    top = sorted((k for k, v in idx.items() if v and v["overall"]), key=lambda k: -idx[k]["overall"])[:3]
    names = {k: r.get("name", k) for k, r in cur["relays"].items()}
    items = [{"relay": k, "kind": "lead", "good": True, "weight": 100 - i,
              "text": f"#{i + 1} on performance: {names[k]} at {n(idx[k]['overall'])} (strfry = 100)"} for i, k in enumerate(top)]
    full = [k for k, r in cur["relays"].items() if (t := r.get("tester") or {}).get("required_total") and t["required_pass"] == t["required_total"]]
    if full:
        items.append({"relay": None, "kind": "correct", "good": True, "weight": 60,
                      "text": f"All required checks pass: {', '.join(sorted(names[k] for k in full))}"})
    return items


def compute(index_json):
    runs = sorted(index_json["runs"], key=lambda r: r["date"])
    caps_now = cap_scores()
    out = []
    for i, cur in enumerate(runs):
        caps_cur = cur.get("capability") or (caps_now if i == len(runs) - 1 else None)
        if i == 0:
            items = first_run(cur, caps_cur)
            prev_date = None
        else:
            prev = runs[i - 1]
            items = diff(prev, cur, prev.get("capability"), caps_cur)
            prev_date = prev["date"]
        out.append({"date": cur["date"], "prev": prev_date, "relays": len(cur["relays"]), "items": items})
    return {"runs": out[::-1]}


def main():
    quick = sys.argv[1:] == ["quick"]
    idx = ROOT / "results" / ("quick/index.json" if quick else "index.json")
    data = compute(json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else {"runs": []})
    print(json.dumps(data, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
