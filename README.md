# nostr-relay-bench

A weekly benchmark of Nostr relay implementations. Each week every actively developed relay is
built from its latest release, loaded with the same million events on the same machine, and
checked against the protocol. Capability is scored from each relay's code and docs, with the
evidence for each score kept beside it. The page reads the raw results and computes every index
in the browser.

**Results:** https://0ceanslim.github.io/nostr-relay-bench/

Your relay is configured unfairly, scored wrong, or missing? Send a PR. Everything that decides
a number is in this repo.

## Layout

| Path | What it is |
|---|---|
| `relays/<id>/` | One benchmarked relay: `relay.toml`, `compose.yaml`, its perf profile, optional `compose.<profile>.yaml` overlays |
| `capability/criteria.toml` | The 18 capability criteria and their weights |
| `capability/relays/<id>.toml` | One relay's capability scores (0–3) with evidence |
| `catalog.toml` | Every relay implementation we know of, benchmarked or not |
| `tools/` | Pinned Dockerfiles for relay-bench, relay-tester and nostr-bench |
| `bench/run.py` | The weekly run |
| `bench/summarize.py` | Raw results → `results/index.json` |
| `bench/build_site.py` | Data files for the page |
| `results/runs/<date>/<id>/` | Raw output of every run: tool JSON, relay logs, `result.json` |
| `site/` | The page |
| `deploy/` | systemd units for the weekly run |

## Running it

Needs Linux, Docker with the compose plugin, git and Python 3.11+.

```sh
python3 bench/run.py --quick grain        # smoke test one relay: 50k events, short tests
python3 bench/run.py                      # everything enabled, full size (several hours)
python3 bench/run.py --publish            # ...then commit and push results/
```

`bench.toml` sets the CPU split: the relay's containers are pinned to `relay_cpus`, the load tools
to `load_cpus`. Keep them disjoint and the same from week to week. `deploy/` has a systemd timer
that runs `--publish` weekly.

## What a run does

For each relay, one at a time, on fresh volumes:

1. Resolve the version: the newest tag matching `tag_pattern` (`track = "tag"`), or a branch head
   (`track = "branch:main"`). Count its commits in the last 90 days.
2. **Perf profile** (limits raised so the load generator is what's measured):
   load the public events → duplicate resends → classic queries → load the gift wraps →
   gift-wrap and COUNT queries → negentropy → memory and disk → live fan-out → 10k idle
   connections → one-event-at-a-time writes.
3. **Default profile** (the relay as shipped): relay-tester.

## Adding a relay

Create `relays/<id>/`, where `<id>` matches `capability/relays/<id>.toml` and the catalog entry.

**relay.toml**

```toml
name = "strfry"
repo = "https://github.com/hoytech/strfry"   # used for versions and activity; add git = "..." if the clone URL differs
track = "tag"                                 # or "branch:main"
tag_pattern = '^\d+\.\d+\.\d+$'
port = 7777
path = "/"                                    # WebSocket and NIP-11 path, default "/"
private_giftwraps = false                     # true if kind 1059 is only ever served to its recipient
heavy = false                                 # true skips it unless --heavy (big memory needs)
disabled = false
notes = ""                                    # anything a reader should know about this setup
```

**compose.yaml** rules:

- The relay service joins the external network `relaybench` (declared `external: true, name: "${RB_NET:-relaybench}"`) with the alias `relay`, so the tools reach it
  at `ws://relay:<port><path>`.
- Every service sets `cpuset: "${RELAY_CPUS}"`, including databases. The whole stack shares the
  relay's cores.
- Build at `${REF}` (the resolved tag or commit). Prefer the project's own release artifact or
  Dockerfile. Write your own only when theirs can't be built at a ref.
- `${MODE}` is `perf` or `default`. Either branch on it in the entrypoint, or put the perf changes in
  `compose.perf.yaml`, which is layered on in perf mode only.
- Data lives in named volumes. The run measures their size and removes them afterwards.
- The relay must answer NIP-11 (`Accept: application/nostr+json`) on `http://relay:<port><path>`.

**Perf profile:** raise per-IP, per-connection and per-pubkey limits. All load comes from one
container IP. Accept every kind, allow filter limits up to 5000, and open gift-wrap reads if the
relay allows that. Change nothing else, and say what you changed in a comment at the top of the
file.

**Default profile:** the shipped config with only what's needed to run in a container
(bind address, data path). Say what you changed.

Check it with `python3 bench/run.py --quick <id>` and look at `results/quick/<date>/<id>/`.

Every key, secret and pubkey under `relays/` is a throwaway value made for this bench, never
used anywhere else.
