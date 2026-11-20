#!/usr/bin/env python3
"""Turn the latest run's headlines into a Nostr note and, when enabled, post it.

  bench/post.py            post if [bot] post = true in bench.toml and a key is set; else print
  bench/post.py --dry-run  print the note and its tags, never post

The key is the bot's own, never the operator's: NOSTR_SECRET_KEY in the environment, or that
line in ~/.config/nostr-relay-bench/bot.env (mode 600, outside the repo). Signing and sending
go through nak in a container (tools/nak). Maintainers are tagged only when their relay is in
the headlines, from maintainers = ["npub…"] in relays/<id>/relay.toml."""
import json, os, subprocess, sys, tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import changes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PAGE = "https://0ceanslim.github.io/nostr-relay-bench/"
MAX_ITEMS = 8
BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def npub_hex(s):
    """npub1… (or 64-char hex) to hex. Plain bech32: no checksum check beyond the alphabet."""
    s = s.strip().lower()
    if len(s) == 64 and all(c in "0123456789abcdef" for c in s):
        return s
    if not s.startswith("npub1"):
        raise ValueError(f"not an npub: {s}")
    data = [BECH.index(c) for c in s[5:-6]]
    acc, bits, out = 0, 0, bytearray()
    for v in data:
        acc, bits = (acc << 5) | v, bits + 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if len(out) != 32:
        raise ValueError(f"bad npub length: {s}")
    return out.hex()


def maintainers():
    out = {}
    for d in (ROOT / "relays").iterdir():
        f = d / "relay.toml"
        if f.exists():
            m = tomllib.loads(f.read_text(encoding="utf-8"))
            if m.get("maintainers") and not m.get("no_tag"):
                out[d.name] = m["maintainers"]
    return out


def note(cur):
    """Content and p-tags for one run's entry from changes.compute()."""
    tags = maintainers()
    lines = [f"Nostr relay bench · {cur['date']}",
             f"{cur['relays']} relays, the same million events, the same machine."
             + (f" What changed since {cur['prev']}:" if cur["prev"] else " First full run:"), ""]
    items = cur["items"][:MAX_ITEMS]
    if not items:
        lines.append(f"Nothing moved more than 10% since {cur['prev']}.")
    p = []
    for i in items:
        mark = {True: "▲", False: "▼"}.get(i["good"], "•")
        who = tags.get(i["relay"] or "", [])
        lines.append(f"{mark} {i['text']}" + "".join(f" nostr:{n}" for n in who))
        p += [npub_hex(n) for n in who]
    if len(cur["items"]) > MAX_ITEMS:
        lines.append(f"…and {len(cur['items']) - MAX_ITEMS} more.")
    lines += ["", f"Every number, every test, and what each relay could improve: {PAGE}"]
    return "\n".join(lines), sorted(set(p))


def secret():
    if os.environ.get("NOSTR_SECRET_KEY"):
        return os.environ["NOSTR_SECRET_KEY"]
    f = Path.home() / ".config" / "nostr-relay-bench" / "bot.env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.startswith("NOSTR_SECRET_KEY="):
                return line.split("=", 1)[1].strip()
    return None


def main():
    dry = "--dry-run" in sys.argv
    idx = ROOT / "results" / "index.json"
    data = changes.compute(json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else {"runs": []})
    if not data["runs"]:
        print("post: no runs yet", file=sys.stderr)
        return
    content, p = note(data["runs"][0])
    cfg = tomllib.loads((ROOT / "bench.toml").read_text(encoding="utf-8")).get("bot", {})
    key = secret()
    if dry or not cfg.get("post") or not key or not cfg.get("relays"):
        why = "dry run" if dry else "posting is off in bench.toml" if not cfg.get("post") else "no key" if not key else "no relays"
        print(f"post: not posting ({why}). The note would be:\n\n{content}\n\np tags: {p}")
        return
    sh = lambda *c: subprocess.run(list(c), check=True, text=True, capture_output=True)
    sh("docker", "build", "-q", "-t", "rb-nak", str(ROOT / "tools" / "nak"))
    cmd = ["docker", "run", "--rm", "-e", "NOSTR_SECRET_KEY", "rb-nak", "event", "-k", "1", "-c", content,
           *[a for h in p for a in ("-t", f"p={h}")], *cfg["relays"]]
    r = subprocess.run(cmd, text=True, capture_output=True, env={**os.environ, "NOSTR_SECRET_KEY": key})
    print(r.stdout[-2000:], r.stderr[-2000:], sep="\n")
    if r.returncode:
        sys.exit(r.returncode)


if __name__ == "__main__":
    main()
