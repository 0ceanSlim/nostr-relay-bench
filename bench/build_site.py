#!/usr/bin/env python3
"""Collect the data the page reads into site/data/: results/index.json plus the capability
scores, catalog and relay definitions converted from TOML. GitHub Pages runs this on every push;
run it locally and serve site/ to preview (python -m http.server -d site)."""
import json, shutil, tomllib
import changes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data"


def load(p):
    return tomllib.loads(p.read_text(encoding="utf-8"))


def main():
    # build_site.py quick: preview with results/quick/index.json instead of the real runs
    import sys
    OUT.mkdir(parents=True, exist_ok=True)
    idx = ROOT / "results" / ("quick/index.json" if sys.argv[1:] == ["quick"] else "index.json")
    if idx.exists():
        shutil.copy(idx, OUT / "results.json")
    else:
        (OUT / "results.json").write_text('{"runs":[]}', encoding="utf-8")
    # Headlines from run to run, for the page's "This week" panel
    (OUT / "changes.json").write_text(json.dumps(changes.compute(json.loads((OUT / "results.json").read_text(encoding="utf-8"))),
                                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    act = ROOT / "results" / "activity.json"
    (OUT / "activity.json").write_text(act.read_text(encoding="utf-8") if act.exists() else '{"relays":{}}', encoding="utf-8")
    cap = {"criteria": load(ROOT / "capability" / "criteria.toml")["criterion"], "relays": {}}
    for f in sorted((ROOT / "capability" / "relays").glob("*.toml")):
        cap["relays"][f.stem] = load(f)
    relays = {}
    for d in sorted((ROOT / "relays").iterdir()):
        if (d / "relay.toml").exists():
            m = load(d / "relay.toml")
            relays[d.name] = {k: m.get(k) for k in ("name", "repo", "track", "heavy", "disabled", "notes", "private_giftwraps", "maintainers")}
    out = {"capability": cap, "catalog": load(ROOT / "catalog.toml")["relay"], "benched": relays}
    (OUT / "meta.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("site/data written")


if __name__ == "__main__":
    main()
