#!/usr/bin/env python3
"""Commits in the last 90 days, and the newest commit date, for every relay in catalog.toml that
has a repo. Writes results/activity.json. The weekly run calls it; the page uses it to show which
relays are active and which active ones aren't benchmarked yet."""
import datetime, json, sys, tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import ROOT, activity  # noqa: E402


def one(r):
    meta = {"repo": r["repo"], **({"git": r["git"]} if r.get("git") else {})}
    key = r.get("id") or r["name"]
    return key, {"name": r["name"], **activity("act-" + "".join(c if c.isalnum() else "-" for c in key), meta)}


def main():
    cat = tomllib.loads((ROOT / "catalog.toml").read_text(encoding="utf-8"))["relay"]
    todo = [r for r in cat if r.get("repo") and not r["repo"].startswith("https://fiatjaf.com")]
    with ThreadPoolExecutor(8) as ex:
        res = dict(ex.map(one, todo))
    out = {"date": datetime.date.today().isoformat(), "relays": res}
    (ROOT / "results" / "activity.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    ok = sum(1 for v in res.values() if v.get("commits_90d") is not None)
    print(f"activity: {ok} of {len(todo)} repos read", file=sys.stderr)


if __name__ == "__main__":
    main()
