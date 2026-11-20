#!/usr/bin/env python3
"""Weekly relay benchmark. Runs every relay in relays/ one at a time on a fresh volume.

  bench/run.py                    every enabled relay, full size
  bench/run.py strfry grain       just these
  bench/run.py --quick grain      small dataset and short tests, results to results/quick/
  bench/run.py --publish          commit and push results/ when done

Per relay: a perf instance (limits raised, see each relay's perf profile) takes the load and
query tests, then a fresh default instance (the relay as shipped) takes relay-tester.
Needs Python 3.11+, git and Docker with the compose plugin. Settings come from bench.toml,
and RELAY_CPUS / LOAD_CPUS in the environment override it.
"""
import argparse, datetime, json, os, platform, re, shutil, subprocess, sys, time, tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import changes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RELAYS = ROOT / "relays"
DATA = ROOT / "data"
CACHE = ROOT / ".cache"
NET = os.environ.get("RB_NET", "relaybench")  # a separate network per parallel tester
TOOLS = ("relay-bench", "relay-tester", "nostr-bench")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sh(cmd, timeout=None, check=True, capture=False, env=None):
    r = subprocess.run(cmd, timeout=timeout, text=True, encoding="utf-8", errors="replace", env=env,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.STDOUT if capture else None)
    if check and r.returncode != 0:
        raise RuntimeError(f"exit {r.returncode}: {' '.join(cmd)}\n{r.stdout or ''}")
    return r


def settings(quick):
    s = tomllib.loads((ROOT / "bench.toml").read_text(encoding="utf-8"))
    s = {**s["full"], **(s["quick"] if quick else {}), **s["host"]}
    for k in ("RELAY_CPUS", "LOAD_CPUS"):
        if os.environ.get(k):
            s[k.lower()] = os.environ[k]
    return s


# --- versions and activity -------------------------------------------------------------------

def _vkey(tag):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", tag)]


def resolve(meta):
    """Pick the ref to build. Returns (ref, version, commit)."""
    repo = meta.get("git", meta["repo"])
    track = meta["track"]
    if track == "tag":
        out = sh(["git", "ls-remote", "--tags", repo], capture=True, timeout=60).stdout
        pat = re.compile(meta.get("tag_pattern", r"^v?\d+\.\d+\.\d+$"))
        tags = {}
        # An annotated tag is listed twice: the tag object, then "<tag>^{}" with the commit it
        # points at. Keep the commit.
        for line in sorted(out.splitlines(), key=lambda l: l.endswith("^{}")):
            sha, ref = line.split("\t")
            name = ref.removeprefix("refs/tags/").removesuffix("^{}")
            if pat.match(name):
                tags[name] = sha
        if not tags:
            raise RuntimeError(f"no tag matches {pat.pattern} in {repo}")
        tag = max(tags, key=_vkey)
        return tag, tag, tags[tag]
    # "branch" alone is the default branch; "branch:<name>" a named one
    branch = track.removeprefix("branch").removeprefix(":")
    if branch:
        out = sh(["git", "ls-remote", repo, f"refs/heads/{branch}"], capture=True, timeout=60).stdout
    else:
        out = sh(["git", "ls-remote", "--symref", repo, "HEAD"], capture=True, timeout=60).stdout
        m = re.search(r"refs/heads/(\S+)\s+HEAD", out)
        branch = m.group(1) if m else "HEAD"
        out = "".join(l for l in out.splitlines(keepends=True) if not l.startswith("ref:"))
    if not out.strip():
        raise RuntimeError(f"no branch {branch or 'HEAD'} in {repo}")
    sha = out.split()[0]
    return sha, f"{branch}@{sha[:8]}", sha


def activity(rid, meta):
    """Commits on the default branch in the last 90 days, and the date of the newest one."""
    repo = meta.get("git", meta["repo"])
    d = CACHE / "git" / rid
    since = (datetime.date.today() - datetime.timedelta(days=90)).isoformat()

    def clone(*how):
        shutil.rmtree(d, ignore_errors=True)
        sh(["git", "clone", "-q", "--bare", "--filter=blob:none", *how, repo, str(d)], timeout=300, capture=True)
        return sh(["git", "-C", str(d), "log", "-1", "--format=%cs"], capture=True).stdout.strip()

    err = None
    try:
        for _ in range(2):
            try:
                last = clone(f"--shallow-since={since}")
                n = int(sh(["git", "-C", str(d), "rev-list", "--count", "HEAD"], capture=True).stdout)
                return {"commits_90d": n, "last_commit": last}
            except Exception as e:
                err = e
            # --shallow-since fails when the newest commit is older than the window. Check with
            # one commit; if that one is inside the window, the failure was something else: retry.
            try:
                last = clone("--depth=1")
                if last < since:
                    return {"commits_90d": 0, "last_commit": last}
            except Exception as e:
                err = e
        return {"commits_90d": None, "last_commit": None, "error": str(err)[:200]}
    finally:
        shutil.rmtree(d, ignore_errors=True)


# --- dataset ------------------------------------------------------------------------------------

def dataset(s):
    """full.jsonl from relay-bench gen, split into public events and gift wraps (kind 1059).
    Public events are loaded and queried first, so a relay that keeps gift wraps private
    still gets judged fairly on everything else."""
    # The generator's image id is part of the name, so a change to the tool makes a fresh dataset.
    gen_id = sh(["docker", "image", "inspect", "-f", "{{.Id}}", "rb-relay-bench"], capture=True).stdout.strip()[7:15]
    tag = f"{s['events']}-seed{s['seed']}-{gen_id}"
    full, pub, wraps = (DATA / f"{n}-{tag}.jsonl" for n in ("full", "public", "wraps"))
    if not full.exists():
        DATA.mkdir(exist_ok=True)
        log("generating dataset", full.name)
        sh(["docker", "run", "--rm", "-v", f"{DATA}:/data", "rb-relay-bench", "gen", "--events", str(s["events"]),
            "--seed", str(s["seed"]), "--nip44", "--out", f"/data/{full.name}"])
    if not pub.exists():
        with full.open(encoding="utf-8") as f, pub.open("w", encoding="utf-8") as p, wraps.open("w", encoding="utf-8") as w:
            for line in f:
                (w if json.loads(line)["kind"] == 1059 else p).write(line)
    return full.name, pub.name, wraps.name


# --- one relay ----------------------------------------------------------------------------------

class SkipPerf(Exception):
    """relay.toml perf = false: a relay whose throughput is capped in code gets only relay-tester."""


class Relay:
    def __init__(self, rid, s, out):
        self.id, self.s, self.out = rid, s, out
        self.dir = RELAYS / rid
        self.meta = tomllib.loads((self.dir / "relay.toml").read_text(encoding="utf-8"))
        self.port = self.meta["port"]
        self.path = self.meta.get("path", "/")
        self.url = f"ws://relay:{self.port}{self.path}"
        self.project = "rb-" + re.sub(r"[^a-z0-9-]", "-", rid.lower())

    def compose(self, mode, *args, timeout=None, check=True):
        files = ["-f", str(self.dir / "compose.yaml")]
        if (self.dir / f"compose.{mode}.yaml").exists():
            files += ["-f", str(self.dir / f"compose.{mode}.yaml")]
        env = {**os.environ, "REF": self.ref, "MODE": mode, "RELAY_CPUS": self.s["relay_cpus"], "RB_NET": NET}
        return sh(["docker", "compose", "-p", self.project, "--project-directory", str(self.dir), *files, *args],
                  timeout=timeout, check=check, env=env, capture=True)

    def up(self, mode):
        self.down(mode)
        self.compose(mode, "build", timeout=self.s["build_timeout"])
        self.compose(mode, "up", "-d", timeout=600)
        script = ("for i in $(seq 1 10); do "
                  f"curl -sf -H 'Accept: application/nostr+json' http://relay:{self.port}{self.path} && exit 0; sleep 1; done; exit 1")
        deadline = time.time() + self.s["start_timeout"]
        while time.time() < deadline:
            r = sh(["docker", "run", "--rm", "--network", NET, "curlimages/curl:8.10.1", "sh", "-c", script],
                   check=False, capture=True, timeout=120)
            if r.returncode == 0:
                try:
                    return json.loads(r.stdout)
                except ValueError:
                    return {}
            if self.compose(mode, "ps", "-a", "--status", "exited", "-q", check=False).stdout.strip():
                break
        logs = self.compose(mode, "logs", "--tail", "40", check=False).stdout
        raise RuntimeError(f"{self.id} ({mode}) never answered NIP-11\n{logs}")

    def down(self, mode="perf"):
        self.compose(mode, "down", "-v", "--remove-orphans", timeout=300, check=False)

    def tool(self, image, args, timeout, name=None):
        name = name or f"{self.project}-load"
        sh(["docker", "rm", "-f", name], check=False, capture=True)
        cmd = ["docker", "run", "--rm", "--name", name, "--network", NET, "--cpuset-cpus", self.s["load_cpus"],
               "--ulimit", "nofile=1048576:1048576", "-v", f"{DATA}:/data", "-v", f"{self.out}:/out", image, *args]
        try:
            r = sh(cmd, timeout=timeout, check=False, capture=True)
            return r.returncode, r.stdout
        except subprocess.TimeoutExpired:
            sh(["docker", "rm", "-f", name], check=False, capture=True)
            return None, "timeout"
        finally:
            sh(["docker", "rm", "-f", name], check=False, capture=True)

    def rb(self, step, *args, timeout):
        rc, txt = self.tool("rb-relay-bench", [*args, "--url", self.url, "--label", self.id,
                                               "--json", "/out/relay-bench.jsonl", "--threads", str(self.s["load_threads"])],
                            timeout)
        self.steps[step] = {"rc": rc, "tail": txt[-600:] if rc not in (0, 2) else ""}
        log(f"  {step}: rc={rc}")

    def footprint(self):
        ids = self.compose("perf", "ps", "-q", check=False).stdout.split()
        mem = 0.0
        for cid in ids:
            u = sh(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", cid], capture=True, check=False).stdout
            m = re.match(r"\s*([\d.]+)\s*([KMG]i?B)", u or "")
            if m:
                mem += float(m.group(1)) * {"K": 1 / 1024, "M": 1, "G": 1024}[m.group(2)[0]]
        vols = sh(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={self.project}"],
                  capture=True, check=False).stdout.split()
        disk = 0
        for v in vols:
            o = sh(["docker", "run", "--rm", "-v", f"{v}:/v:ro", "alpine:3.20", "du", "-sk", "/v"],
                   capture=True, check=False).stdout.split()
            disk += int(o[0]) if o and o[0].isdigit() else 0
        return {"rss_mb": round(mem, 1), "disk_mb": round(disk / 1024, 1)}

    def run(self, files):
        s, full, pub, wraps = self.s, *files
        try:
            self.ref, version, commit = resolve(self.meta)
        except Exception as e:
            log(f"{self.id}: can't resolve a version: {e}")
            return {"relay": self.id, "name": self.meta.get("name", self.id), "error": f"version: {e}", "minutes": 0}
        res = {"relay": self.id, "name": self.meta.get("name", self.id), "version": version, "commit": commit,
               "started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        log(f"{self.id}: {version}")
        res["activity"] = activity(self.id, self.meta)
        self.steps = res["steps"] = {}
        t0 = time.time()
        try:
            if not self.meta.get("perf", True):
                raise SkipPerf
            res["nip11"] = self.up("perf")
            q = ["--conns", "8", "--queries", str(s["queries"])]
            self.rb("ingest_public", "load", "--file", f"/data/{pub}", "--conns", "8", timeout=s["load_timeout"])
            self.rb("ingest_dup", "load", "--file", f"/data/{pub}", "--conns", "8", "--duplicates", "--count", str(s["dup_count"]),
                    timeout=s["load_timeout"])
            self.rb("query_classic", "query", "--file", f"/data/{pub}", "--workload", "classic", *q, timeout=s["query_timeout"])
            self.rb("ingest_wraps", "load", "--file", f"/data/{wraps}", "--conns", "8", timeout=s["load_timeout"])
            self.rb("query_vector", "query", "--file", f"/data/{full}", "--workload", "vector", *q, timeout=s["query_timeout"])
            self.rb("query_count", "query", "--file", f"/data/{full}", "--workload", "count", *q, timeout=s["query_timeout"])
            self.rb("neg_light", "neg", "--file", f"/data/{full}", "--recipient-mode", "light", "--have", "90",
                    "--sessions", str(s["neg_sessions"]), "--conns", "8", timeout=s["query_timeout"])
            self.rb("neg_heavy", "neg", "--file", f"/data/{full}", "--recipient-mode", "heavy", "--have", "90",
                    "--sessions", str(max(1, s["neg_sessions"] // 10)), "--conns", "4", timeout=s["query_timeout"])
            time.sleep(5)
            res["footprint"] = self.footprint()
            self.rb("fanout", "fanout", "--subscribers", "1000", "--publishers", "4", "--rate", "2000",
                    "--duration", str(s["fanout_seconds"]), timeout=s["fanout_seconds"] + 180)
            self.rb("idle", "idle", "--conns", str(s["idle_conns"]), "--hold", "20", timeout=300)
            rc, txt = self.tool("rb-nostr-bench", ["-r", self.url, "-w", "8", "--rate", "0", "-e", str(s["roundtrip_events"]),
                                                    "--only-peak", "--relay-name", self.id,
                                                    "--report-file", "/out/nostr-bench-peak.json"], s["load_timeout"])
            self.steps["write_roundtrip"] = {"rc": rc, "tail": txt[-600:] if rc != 0 else ""}
            log(f"  write_roundtrip: rc={rc}")
        except SkipPerf:
            res["perf_skipped"] = True
            log("  perf skipped (perf = false): correctness only")
        except Exception as e:
            res["error"] = str(e)[-2000:]
            log(f"  failed: {str(e).splitlines()[0]}")
        finally:
            (self.out / "relay-perf.log").write_text(self.compose("perf", "logs", "--tail", "200", check=False).stdout or "", encoding="utf-8")
            self.down("perf")
        try:
            res["nip11_default"] = self.up("default")
            keys = [sh(["docker", "run", "--rm", "rb-relay-tester", "generate-keypair"], capture=True).stdout for _ in (1, 2)]
            nsecs = [re.search(r"nsec1[a-z0-9]+", k).group(0) for k in keys]
            rc, txt = self.tool("rb-relay-tester", ["relay-tester", "--script", self.url, *nsecs], s["tester_timeout"])
            (self.out / "relay-tester.jsonl").write_text("\n".join(l for l in txt.splitlines() if l.startswith("{")) + "\n", encoding="utf-8")
            self.steps["relay_tester"] = {"rc": rc}
            log(f"  relay_tester: rc={rc}")
        except Exception as e:
            res["error_default"] = str(e)[-2000:]
            log(f"  default profile failed: {str(e).splitlines()[0]}")
        finally:
            self.down("default")
        res["minutes"] = round((time.time() - t0) / 60, 1)
        return res


def host_info(s):
    def cmd(c):
        try:
            return sh(c, capture=True, check=False).stdout.strip()
        except Exception:
            return ""
    cpu = ""
    if Path("/proc/cpuinfo").exists():
        m = re.search(r"model name\s*:\s*(.+)", Path("/proc/cpuinfo").read_text(encoding="utf-8"))
        cpu = m.group(1) if m else ""
    return {"cpu": cpu or platform.processor(), "threads": os.cpu_count(), "kernel": platform.release(),
            "docker": cmd(["docker", "version", "--format", "{{.Server.Version}}"]),
            "relay_cpus": s["relay_cpus"], "load_cpus": s["load_cpus"], "label": s.get("label", "")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("relays", nargs="*")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--heavy", action="store_true", help="include relays marked heavy (big memory)")
    a = ap.parse_args()
    s = settings(a.quick)

    ids = a.relays or sorted(p.name for p in RELAYS.iterdir() if (p / "relay.toml").exists())
    todo = []
    for rid in ids:
        m = tomllib.loads((RELAYS / rid / "relay.toml").read_text(encoding="utf-8"))
        if a.relays or (not m.get("disabled") and (a.heavy or not m.get("heavy"))):
            todo.append(rid)

    for t in TOOLS:
        log("building", t)
        sh(["docker", "build", "-q", "-t", f"rb-{t}", str(ROOT / "tools" / t)], capture=True)
    sh(["docker", "network", "create", NET], check=False, capture=True)
    files = dataset(s)

    date = datetime.date.today().isoformat()
    base = ROOT / "results" / ("quick" if a.quick else "runs") / date
    run_meta = base / "run.json"
    base.mkdir(parents=True, exist_ok=True)
    meta = json.loads(run_meta.read_text(encoding="utf-8")) if run_meta.exists() else {"date": date, "relays": []}
    meta.update({"host": host_info(s), "settings": {k: v for k, v in s.items() if k not in ("label",)},
                 "tools": {t: sh(["docker", "image", "inspect", "-f", "{{.Id}}", f"rb-{t}"], capture=True).stdout.strip()[7:19]
                           for t in TOOLS},
                 # capability scores as they stood for this run, so the next run can report re-scores
                 "capability": changes.cap_scores()})
    for rid in todo:
        out = base / rid
        if out.exists():
            shutil.rmtree(out)
        out.mkdir()
        res = Relay(rid, s, out).run(files)
        (out / "result.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
        if rid not in meta["relays"]:
            meta["relays"].append(rid)
        run_meta.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        log(f"{rid}: done in {res['minutes']} min")

    if not a.quick and not a.relays:
        log("catalog activity")
        sh([sys.executable, str(ROOT / "bench" / "activity.py")], check=False)
    sh([sys.executable, str(ROOT / "bench" / "summarize.py"), *(["quick"] if a.quick else [])])
    if a.publish and not a.quick:
        sh(["git", "-C", str(ROOT), "add", "results"])
        sh(["git", "-C", str(ROOT), "commit", "-q", "-m", f"results: {date}"], check=False)
        # Config and page changes may have landed during a run that takes most of a day.
        sh(["git", "-C", str(ROOT), "pull", "-q", "--rebase"])
        sh(["git", "-C", str(ROOT), "push", "-q"])
        log("pushed")
        sh([sys.executable, str(ROOT / "bench" / "post.py")], check=False)


if __name__ == "__main__":
    main()
