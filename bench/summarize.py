#!/usr/bin/env python3
"""Rebuild results/index.json from the raw files under results/runs/. Safe to rerun at any time;
the page reads only index.json. Scoring (indexes, ranks) happens in the page, not here, so a
change of method never needs the raw data rewritten."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# relay-bench step -> metric family. "private" covers gift-wrap mailboxes (NIP-17 inboxes and
# Vector's community planes), which a relay may keep to the recipient by design.
FAMILY = {
    "ingest": "write", "ingest_dup": "write",
    "latest_1": "read", "latest_100": "read", "latest_500": "read", "author": "read", "kind": "read",
    "author_kind": "read", "tag": "read", "time_window": "read", "exact_id": "read", "exact_ids_100": "read",
    "miss": "read", "multi_filter": "read",
    "dm_inbox": "private", "dm_catchup": "private", "concord_page": "private", "concord_paging": "private",
    "dm_ids": "private", "count": "private",
    "neg_light_90": "sync", "neg_heavy_90": "sync",
    "fanout": "live", "idle": "connections",
}


def status(r):
    if not r.get("supported", True):
        return "unsupported"
    d = r.get("detail", {})
    if r["command"] == "load":
        # A handful of refusals (an odd reply prefix for a superseded replaceable, say) doesn't
        # make a throughput number meaningless; past 1% the relay isn't storing the load.
        refused = d.get("ok_false_refused", 0)
        if refused > 0.01 * max(1, d.get("sent", 0)) or d.get("unacked"):
            return "refused"
        return "ok"
    if r.get("errors") or r.get("mismatches") or d.get("missed") or d.get("subscribers_failed"):
        return "wrong"
    return "ok" if r.get("ok", True) else "wrong"


def relay_bench(path):
    out = {}
    if not path.exists():
        return out
    loads = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("{"):
            continue
        r = json.loads(line)
        w = r["workload"]
        if r["command"] == "load" and w == "ingest":
            loads.append(r)
            continue
        lat = r.get("lat_us") or {}
        m = {"v": r.get("ops_per_s"), "p50_us": lat.get("p50"), "p99_us": lat.get("p99"),
             "status": status(r), "errors": r.get("errors", 0), "mismatches": r.get("mismatches", 0)}
        d = r.get("detail", {})
        if w == "fanout":
            m.update(missed=d.get("missed"), deliveries=d.get("deliveries"))
        if w == "ingest_dup":
            m.update(refused=d.get("ok_false_refused"))
        out[w] = m
    if loads:
        # Public events then gift wraps, two loads on one database: report both and the total.
        ops = sum(r["ops"] for r in loads)
        secs = sum(r["duration_s"] for r in loads)
        sts = [status(r) for r in loads]
        out["ingest"] = {"v": ops / secs if secs else None, "status": "ok" if all(s == "ok" for s in sts) else
                         next(s for s in sts if s != "ok"),
                         "parts": [{"ops": r["ops"], "v": r["ops_per_s"], "status": status(r),
                                    "refused": r.get("detail", {}).get("ok_false_refused", 0)} for r in loads]}
    for w, m in out.items():
        m["family"] = FAMILY.get(w, "other")
    return out


def tester(path):
    if not path.exists():
        return None
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.startswith("{")]
    if not rows:
        return None
    req = [r for r in rows if r.get("required")]
    opt = [r for r in rows if not r.get("required")]
    return {"required_pass": sum(r["pass"] is True for r in req), "required_total": len(req),
            "optional_pass": sum(r["pass"] is True for r in opt), "optional_total": len(opt),
            "failed": [r["test"] for r in req if r["pass"] is not True]}


def roundtrip(path):
    if not path.exists():
        return None
    r = json.loads(path.read_text(encoding="utf-8"))["results"][0]
    return {"v": r["events_per_second"], "p50_ms": r["p50_latency_ms"], "p99_ms": r["p99_latency_ms"],
            "status": "ok" if r["errors"] == 0 and r["success_rate"] >= 99.9 else "wrong", "family": "write"}


def first_line(s):
    lines = (s or "").strip().splitlines()
    return lines[0][:300] if lines else None


def nip11(d):
    d = d or {}
    return {k: d.get(k) for k in ("software", "version", "supported_nips")}


def main():
    # bench/summarize.py [quick]: the quick runs go to results/quick/index.json instead
    quick = sys.argv[1:] == ["quick"]
    runs = []
    base = ROOT / "results" / ("quick" if quick else "runs")
    for rd in sorted(p for p in base.iterdir() if (p / "run.json").exists()) if base.exists() else []:
        meta = json.loads((rd / "run.json").read_text(encoding="utf-8"))
        relays = {}
        # Read the directories, not run.json's list: runs of single relays on the same day share run.json.
        for rid in sorted(p.name for p in rd.iterdir() if (p / "result.json").exists()):
            f = rd / rid / "result.json"
            if not f.exists():
                continue
            res = json.loads(f.read_text(encoding="utf-8"))
            metrics = relay_bench(rd / rid / "relay-bench.jsonl")
            rt = roundtrip(rd / rid / "nostr-bench-peak.json")
            if rt:
                metrics["write_roundtrip"] = rt
            relays[rid] = {"name": res.get("name", rid), "version": res.get("version"), "commit": res.get("commit"),
                           "activity": res.get("activity"), "nip11": nip11(res.get("nip11_default") or res.get("nip11")),
                           "footprint": res.get("footprint"), "metrics": metrics, "perf_skipped": res.get("perf_skipped", False),
                           "tester": tester(rd / rid / "relay-tester.jsonl"),
                           "error": first_line(res.get("error")), "error_default": first_line(res.get("error_default"))}
        runs.append({"date": meta["date"], "host": meta.get("host"), "tools": meta.get("tools"),
                     "settings": meta.get("settings"), "capability": meta.get("capability"), "relays": relays})
    out = (base if quick else ROOT / "results") / "index.json"
    out.write_text(json.dumps({"runs": runs}, separators=(",", ":")), encoding="utf-8")
    print(f"index.json: {len(runs)} runs", file=sys.stderr)


if __name__ == "__main__":
    main()
