"use strict";
// Everything on the page is computed here from data/results.json (the weekly runs) and
// data/meta.json (capability scores, catalog, relay definitions). Nothing is precomputed.

const BASE = "strfry";
// Areas of the performance index. dir: "up" = higher is better. get() pulls the value from a
// relay's result; the default is the test's throughput. c: the area's colour token; areas without
// one are reported but left out of the overall index.
const AREAS = [
  { id: "write", name: "Writing", overall: true, c: "--a-write", tests: [
    ["ingest", "Bulk ingest, 8 pipelined connections", "up", "/s"],
    ["ingest_dup", "Duplicate resends", "up", "/s"],
    ["write_roundtrip", "One event at a time, waiting for each OK", "up", "/s"] ] },
  { id: "read", name: "Reading", overall: true, c: "--a-read", tests: [
    ["latest_1", "Newest event", "up", "q/s"], ["latest_100", "Newest 100", "up", "q/s"],
    ["latest_500", "Newest 500", "up", "q/s"], ["author", "By author", "up", "q/s"], ["kind", "By kind", "up", "q/s"],
    ["author_kind", "By author and kind", "up", "q/s"], ["tag", "By tag", "up", "q/s"],
    ["time_window", "Time window", "up", "q/s"], ["exact_id", "By id", "up", "q/s"],
    ["exact_ids_100", "100 ids at once", "up", "q/s"], ["miss", "No match", "up", "q/s"],
    ["multi_filter", "Several filters in one REQ", "up", "q/s"] ] },
  { id: "live", name: "Live delivery", overall: true, c: "--a-live", tests: [
    ["fanout", "1,000 subscribers, median delivery latency", "down", "ms", m => m.p50_us / 1000] ] },
  { id: "connections", name: "Connections", overall: true, c: "--a-connections", tests: [
    ["idle", "Opening 10,000 idle connections", "up", "/s"] ] },
  { id: "footprint", name: "Footprint", overall: false, tests: [
    ["rss", "Memory after the load", "down", "MB", (m, r) => r.footprint?.rss_mb],
    ["disk", "Disk after the load", "down", "MB", (m, r) => r.footprint?.disk_mb] ] },
  { id: "private", name: "Private messaging", overall: false, tests: [
    ["dm_inbox", "Gift-wrap inbox (#p)", "up", "q/s"], ["dm_catchup", "Inbox catch-up", "up", "q/s"],
    ["dm_ids", "Gift wraps by id", "up", "q/s"], ["concord_page", "Community page", "up", "q/s"],
    ["concord_paging", "Community paging", "up", "q/s"], ["count", "COUNT", "up", "q/s"] ] },
  { id: "sync", name: "Negentropy sync", overall: false, tests: [
    ["neg_light_90", "Small mailboxes", "up", "/s"], ["neg_heavy_90", "Large mailboxes", "up", "/s"] ] },
];
const AREA_NOTE = {
  live: "A relay that delivers before the event is fsynced shows far lower latency than one that waits for the commit.",
  footprint: "Memory and disk trade against speed.",
  private: "Relays that keep gift wraps to their recipient (NIP-17) show “private by design”.",
  sync: "NIP-77 is a feature, scored under capability.",
};
const WHY = { unsupported: "not supported", refused: "refused by policy", wrong: "wrong answers",
              failed: "failed", missing: "not run", private: "private by design" };
const GROUPS = [["protocol", "Protocol"], ["policy", "Policy & moderation"], ["operations", "Operations"], ["ecosystem", "Ecosystem"]];
const TIERS = [["all", "All"], ["active", "Active"], ["slowing", "Slowing"], ["dormant", "Dormant"], ["missed", "Missed by the survey"], ["gap", "Committing, not benchmarked"]];
const REPO = "https://github.com/0ceanSlim/nostr-relay-bench";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const geo = xs => xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : null;
const median = xs => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length ? (s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2) : null; };
const fmt = (v, d = 0) => v == null ? "–" : v >= 100 ? Math.round(v).toLocaleString("en") : v.toLocaleString("en", { maximumFractionDigits: d || (v < 10 ? 2 : 1) });
const ord = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let RUNS = [], META, CAP, CRIT, LATEST = {}, NAMES = {}, ACT = {}, FIELD = {}, ME = null;
const nm = id => NAMES[id] || id;

// --- data ------------------------------------------------------------------------------------

function testValue(r, t) {
  const [id, , , , get] = t;
  const m = r.metrics?.[id];
  if (get) {
    const v = get(m || {}, r);
    return { v, status: v == null ? "missing" : (id === "fanout" ? m?.status : "ok") ?? "missing" };
  }
  if (!m) return { v: null, status: "missing" };
  if (m.status !== "ok" && privateByDesign(r, id)) return { v: null, status: "private" };
  return { v: m.v, status: m.status };
}

// A relay that keeps kind 1059 to its recipient fails every gift-wrap read the bench (which
// never AUTHs) makes; that's the relay doing what NIP-17 asks, not a wrong answer.
// relays/<id>/relay.toml says so with private_giftwraps = true.
// Negentropy isn't in the list: a relay without NIP-77 is "not supported" whatever its policy.
const PRIVATE_TESTS = new Set(["dm_inbox", "dm_catchup", "dm_ids", "concord_page", "concord_paging", "count"]);
function privateByDesign(r, id) {
  return PRIVATE_TESTS.has(id) && !!META.benched[r.id]?.private_giftwraps;
}

function baseline(run) {
  if (run.relays[BASE]) return { ...run.relays[BASE], id: BASE };
  for (let i = RUNS.length - 1; i >= 0; i--) if (RUNS[i].relays[BASE]) return { ...RUNS[i].relays[BASE], id: BASE };
  return null;
}

// A test's result against strfry's in the same run, flipped where lower is better: >1 is faster.
function ratio(r, base, t) {
  const a = testValue(r, t), b = testValue(base, t);
  return a.status === "ok" && b.status === "ok" && a.v > 0 && b.v > 0 ? (t[2] === "up" ? a.v / b.v : b.v / a.v) : null;
}

function areaIndex(r, base, area) {
  const ratios = [], why = {};
  for (const t of area.tests) {
    const x = ratio(r, base, t);
    if (x != null) ratios.push(x);
    else { const s = testValue(r, t).status; why[s] = (why[s] || 0) + 1; }
  }
  const v = geo(ratios);
  const reason = Object.entries(why).sort((x, y) => y[1] - x[1])[0]?.[0];
  return { v: v == null ? null : 100 * v, n: ratios.length, of: area.tests.length, why: v == null ? reason : null };
}

function perf(r, run) {
  const base = baseline(run);
  if (!base || r.perf_skipped) return null;
  const areas = Object.fromEntries(AREAS.map(a => [a.id, areaIndex(r, base, a)]));
  const parts = AREAS.filter(a => a.overall).map(a => areas[a.id].v).filter(v => v != null);
  return { overall: parts.length ? 100 * geo(parts.map(v => v / 100)) : null, parts: parts.length, areas };
}

const PERF = {};
const perfOf = id => id in PERF ? PERF[id] : (PERF[id] = LATEST[id] ? perf(LATEST[id].r, LATEST[id].run) : null);

function capScore(id, group) {
  const s = CAP.relays[id]?.scores;
  if (!s) return null;
  let got = 0, max = 0;
  for (const c of CRIT) if (!group || c.group === group) { got += c.weight * (s[c.id] ?? 0); max += c.weight * 3; }
  return Math.round(100 * got / max);
}

function tester(r) {
  const t = r?.tester;
  return t && t.required_total ? { pct: 100 * t.required_pass / t.required_total, ...t } : null;
}

// Per test, every load-tested relay's result: the field the "what would help" list measures against.
function buildField() {
  for (const a of AREAS) for (const t of a.tests) {
    const rows = [];
    for (const [id, L] of Object.entries(LATEST)) {
      if (L.r.perf_skipped) continue;
      const base = baseline(L.run), x = base && ratio(L.r, base, t);
      if (x != null) rows.push({ id, x, raw: testValue(L.r, t).v });
    }
    const best = rows.reduce((b, r) => !b || r.x > b.x ? r : b, null);
    FIELD[t[0]] = { rows, medX: median(rows.map(r => r.x)), medRaw: median(rows.map(r => r.raw)), best };
  }
}

function rankOf(id, score) {
  const list = Object.keys(score.ids()).map(k => [k, score.v(k)]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  const k = list.findIndex(([x]) => x === id);
  return k < 0 ? null : { k: k + 1, n: list.length };
}
const PERF_RANK = { ids: () => LATEST, v: id => perfOf(id)?.overall ?? null };
const CAP_RANK = { ids: () => CAP.relays, v: id => capScore(id) };

// --- shared bits -----------------------------------------------------------------------------

const tip = $("#tip");
function bindTip(el, html) {
  el.addEventListener("mouseenter", () => { tip.innerHTML = typeof html === "function" ? html() : html; tip.hidden = false; });
  el.addEventListener("mousemove", e => {
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 18 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 12 : e.clientY + 18;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  });
  el.addEventListener("mouseleave", () => { tip.hidden = true; });
}
// One log scale for every index on the page, whole decades wide enough for the field.
let LO = 10, HI = 1000;
function setScale() {
  const vs = [100];
  for (const id of Object.keys(LATEST)) { const p = perfOf(id); if (p) for (const a of Object.values(p.areas)) if (a.v) vs.push(a.v); }
  LO = 10 ** Math.min(1, Math.floor(Math.log10(Math.min(...vs))));
  HI = 10 ** Math.max(3, Math.ceil(Math.log10(Math.max(...vs))));
}
const logPos = v => Math.max(0, Math.min(100, 100 * (Math.log10(v) - Math.log10(LO)) / (Math.log10(HI) - Math.log10(LO))));
const logBar = v => `<span class="track"><span class="mark" style="left:${logPos(100)}%"></span><span class="fill" style="width:${logPos(v)}%"></span></span>`;
const linBar = (v, max = 100) => `<span class="track"><span class="fill" style="width:${100 * v / max}%"></span></span>`;
function seg(el, opts, cur, onPick, counts) {
  el.innerHTML = "";
  for (const [k, label] of opts) {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("aria-pressed", k === cur);
    b.innerHTML = esc(label) + (counts ? `<span class="n">${counts[k] ?? 0}</span>` : "");
    b.onclick = () => { el.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); onPick(k); };
    el.append(b);
  }
}

// --- the relay being compared ----------------------------------------------------------------

function known(id) { return !!(id && (LATEST[id] || CAP.relays[id])); }
const inRun = id => !!(META.benched[id] && !META.benched[id].disabled);
function setMe(id, fromHash) {
  ME = known(id) ? id : null;
  if (!fromHash) history.replaceState(null, "", ME ? "#" + encodeURIComponent(ME) : location.pathname + location.search);
  $("#pick").value = ME || "";
  $("#pick").classList.toggle("on", !!ME);
  $("#unpick").hidden = !ME;
  draw();
}
function drawPicker() {
  const bench = Object.keys(LATEST).sort((a, b) => nm(a).localeCompare(nm(b)));
  const only = Object.keys(CAP.relays).filter(id => !LATEST[id]).sort((a, b) => nm(a).localeCompare(nm(b)));
  const opt = id => `<option value="${esc(id)}">${esc(nm(id))}</option>`;
  $("#pick").innerHTML = `<option value="">Nobody (whole field)</option>` +
    (bench.length ? `<optgroup label="Benchmarked weekly">${bench.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Scored, not benchmarked">${only.map(opt).join("")}</optgroup>`;
  $("#pick").onchange = e => setMe(e.target.value);
  $("#unpick").onclick = () => setMe(null);
  addEventListener("hashchange", () => setMe(decodeURIComponent(location.hash.slice(1)), true));
}

// --- hero ------------------------------------------------------------------------------------

function drawStats() {
  const last = RUNS.at(-1), benched = Object.values(META.benched).filter(b => !b.disabled).length;
  const active = META.catalog.filter(c => ACT[c.id || c.name]?.commits_90d > 0).length;
  const tile = (n, l, cls = "") => `<div class="stat"><span class="n mono ${cls}">${n}</span><span class="l">${l}</span></div>`;
  $("#stats").innerHTML =
    tile(last ? Object.keys(last.relays).length : benched, last ? `relays in the latest weekly run, ${esc(last.date)}` : "relays set up for the weekly run; the first full run is pending", "accent") +
    tile(Object.keys(CAP.relays).length, `scored on ${CRIT.length} weighted capability criteria`) +
    tile(META.catalog.length, "relay implementations cataloged") +
    tile(active, "of them with commits in the last 90 days");
}

// --- your relay ------------------------------------------------------------------------------

function strip(label, color, pts, me, pos, val, unitTip) {
  return `<div class="strip" style="--c:var(${color})"><span class="l"><i style="background:var(${color})"></i>${esc(label)}</span>
    <span class="lane">${pos.base != null ? `<span class="base" style="left:${pos.base}%"></span>` : ""}${pts.map(p =>
      `<span class="d${p.id === me ? " me" : ""}" style="left:${pos(p.v)}%" data-tip="${esc(`<b>${esc(nm(p.id))}</b> · ${esc(label)}: ${fmt(p.v)}${unitTip}`)}"></span>`).join("")}</span>
    <span class="v${val == null || val.na ? " na" : ""}">${val?.na ?? val ?? "–"}</span></div>`;
}
function ticks(pos, list) {
  return `<div class="scale"><span></span><span class="ticks">${list.map(([v, l, minor]) => `<span class="${minor ? "minor" : ""}" style="left:${pos(v)}%">${l}</span>`).join("")}</span><span></span></div>`;
}

function drawYou() {
  const body = $("#you-body");
  if (!ME) {
    $("#you-title").textContent = "Pick a relay to compare";
    $("#you-lede").hidden = false;
    const ids = Object.keys(LATEST).length ? Object.keys(LATEST) : Object.keys(CAP.relays);
    body.innerHTML = `<div class="chips">${ids.sort((a, b) => nm(a).localeCompare(nm(b))).map(id => `<button type="button" data-id="${esc(id)}">${esc(nm(id))}</button>`).join("")}</div>`;
    body.querySelectorAll("button").forEach(b => b.onclick = () => { setMe(b.dataset.id); $("#you").scrollIntoView({ behavior: "smooth" }); });
    return;
  }
  $("#you-lede").hidden = true;
  const L = LATEST[ME], p = perfOf(ME), t = L && tester(L.r), cap = capScore(ME);
  const pr = p?.overall != null ? rankOf(ME, PERF_RANK) : null, cr = cap != null ? rankOf(ME, CAP_RANK) : null;
  const act = L?.r.activity?.commits_90d != null ? L.r.activity : ACT[ME];
  const bits = [];
  if (pr) bits.push(`${ord(pr.k)} of ${pr.n} on performance`);
  if (cr) bits.push(`${ord(cr.k)} of ${cr.n} on capability`);
  if (t) bits.push(`${t.required_pass} of ${t.required_total} required checks`);
  $("#you-title").textContent = `${nm(ME)}: ${bits.join(", ") || "not measured yet"}`;

  const tile = (n, l, cls = "") => `<div class="stat"><span class="n mono ${cls}">${n}</span><span class="l">${l}</span></div>`;
  let h = `<div class="stats">` +
    (p?.overall != null ? tile(`${fmt(p.overall)}<small>${ord(pr.k)}/${pr.n}</small>`, "performance index, strfry = 100", "accent")
      : tile("–", L ? (L.r.perf_skipped ? "not load-tested: throughput is capped in code" : "no performance result this run") : inRun(ME) ? "performance: waiting for its first weekly run" : "not benchmarked yet")) +
    (t ? tile(`${t.required_pass}<small>/${t.required_total}</small>`, "required relay-tester checks pass with the relay as shipped", t.required_pass === t.required_total ? "" : "")
      : tile("–", "correctness not checked")) +
    (cap != null ? tile(`${cap}<small>${ord(cr.k)}/${cr.n}</small>`, "capability out of 100") : tile("–", "capability not scored")) +
    tile(act?.commits_90d ?? "–", `commits in the last 90 days${act?.last_commit ? `, last ${esc(act.last_commit)}` : ""}`) + `</div>`;

  // Where it stands: every relay as a dot, this one large.
  const lpos = v => logPos(v); lpos.base = logPos(100);
  const decades = []; for (let v = LO; v <= HI; v *= 10) decades.push([v, fmt(v), v !== LO && v !== 100 && v !== HI]);
  let perfCard;
  if (p) {
    const ids = Object.keys(LATEST).filter(id => perfOf(id));
    const rowsFor = get => ids.map(id => ({ id, v: get(perfOf(id)) })).filter(x => x.v != null);
    perfCard = strip("Overall", "--accent", rowsFor(q => q.overall), ME, lpos, p.overall != null ? fmt(p.overall) : null, " (strfry = 100)") +
      AREAS.filter(a => a.overall).map(a => strip(a.name, a.c, rowsFor(q => q.areas[a.id].v), ME, lpos,
        p.areas[a.id].v != null ? fmt(p.areas[a.id].v) : { na: WHY[p.areas[a.id].why] || "–" }, " (strfry = 100)")).join("") + ticks(lpos, decades);
  } else {
    perfCard = `<p class="muted">${L?.r.perf_skipped ? "Its throughput is capped in code, so a load test would only measure the cap. Correctness is still checked every week."
      : L ? "No performance result in its latest run." : inRun(ME) ? "In the weekly run; its numbers appear here after the next one."
      : `Not in the weekly run yet. A relay joins with a Docker definition in <code>relays/&lt;id&gt;/</code>; see <a href="${REPO}#adding-a-relay">adding a relay</a>.`}</p>`;
  }
  const cpos = v => v; cpos.base = null;
  const capIdsAll = Object.keys(CAP.relays);
  const capCard = cap == null ? `<p class="muted">Not scored yet. Add <code>capability/relays/${esc(ME)}.toml</code> in a PR.</p>` :
    strip("Overall", "--accent", capIdsAll.map(id => ({ id, v: capScore(id) })), ME, cpos, cap, " / 100") +
    GROUPS.map(([g, name]) => strip(name, "--accent", capIdsAll.map(id => ({ id, v: capScore(id, g) })), ME, cpos, capScore(ME, g), " / 100")).join("") +
    ticks(cpos, [[0, "0"], [25, "25"], [50, "50"], [75, "75"], [100, "100"]]);

  h += `<div class="two">
    <div class="card"><h3>Performance against the field</h3><div class="sub">Each dot is a relay, strfry = 100, log scale.</div><div class="strips">${perfCard}</div></div>
    <div class="card"><h3>Capability against the field</h3><div class="sub">Each dot is a scored relay, out of 100.</div><div class="strips">${capCard}</div></div></div>`;
  h += `<div class="three">${fixPerf(L)}${fixCap()}${fixCorrect(L, t)}</div>`;
  body.innerHTML = h;
  body.querySelectorAll(".d[data-tip]").forEach(d => bindTip(d, d.dataset.tip));
}

function fixList(title, key, items, none) {
  return `<div class="card fix"><h3>${title}<span class="k">${key}</span></h3>${items.length
    ? `<ol>${items.map(i => `<li><span class="t">${i.t}</span><span class="g ${i.cls || ""}">${i.g}</span><span class="why">${i.why}</span></li>`).join("")}</ol>`
    : `<div class="none">${none}</div>`}</div>`;
}

function fixPerf(L) {
  if (!L || L.r.perf_skipped) return fixList("Speed", "vs field median", [], L ? "Not load-tested." : inRun(ME) ? "Waiting for its first weekly run." : "Not benchmarked yet.");
  if (L.r.error) return fixList("Speed", "", [{ t: "The perf run failed", g: "failed", cls: "bad", why: esc(L.r.error) }], "");
  const issues = [], slow = [];
  for (const a of AREAS) {
    if (a.id === "sync") continue;
    for (const t of a.tests) {
      const v = testValue(L.r, t), F = FIELD[t[0]];
      if (v.status === "wrong" || v.status === "refused")
        issues.push({ t: esc(t[1]), g: WHY[v.status], cls: "bad", why: `${a.name}. ${v.status === "wrong" ? "Answers didn't match the dataset, so this test isn't counted." : "The relay refused part of the load in the perf profile."}` });
      const me = F?.rows.find(r => r.id === ME);
      if (me && F.rows.length > 2 && me.x / F.medX < 0.8) {
        const rel = me.x / F.medX;
        slow.push({ rel, t: esc(t[1]), g: `${fmt(rel, 2)}×`, cls: rel < 0.4 ? "bad" : "warn",
          why: `${a.name}. ${fmt(me.raw)} ${t[3]} against a field median of ${fmt(F.medRaw)}${F.best.id !== ME ? `; ${esc(nm(F.best.id))} leads with ${fmt(F.best.raw)} ${t[3]}` : ""}.` });
      }
    }
  }
  slow.sort((a, b) => a.rel - b.rel);
  return fixList("Speed", "vs field median", [...issues, ...slow].slice(0, 6), "At or above the field median on every test.");
}

function fixCap() {
  const s = CAP.relays[ME]?.scores;
  if (!s) return fixList("Capability", "points per step", [], "Not scored yet.");
  const W = CRIT.reduce((a, c) => a + c.weight, 0);
  const items = CRIT.filter(c => (s[c.id] ?? 0) < 3)
    .sort((a, b) => b.weight - a.weight || (s[a.id] ?? 0) - (s[b.id] ?? 0))
    .slice(0, 6).map(c => {
      const cur = s[c.id] ?? 0;
      const best = Object.keys(CAP.relays).filter(id => id !== ME && CAP.relays[id].scores?.[c.id] === 3).map(nm).slice(0, 3);
      return { t: `${esc(c.name)} <span class="muted mono">${cur}→${cur + 1}</span>`, g: `+${fmt(100 * c.weight / (3 * W), 1)}`,
        why: (best.length ? `Best in class: ${best.map(esc).join(", ")}. ` : "") + esc(CAP.relays[ME].evidence?.[c.id] || c.why) };
    });
  return fixList("Capability", "points per step", items, "Best in class on every criterion.");
}

function fixCorrect(L, t) {
  if (!t) return fixList("Correctness", "relay-tester", [], L ? "relay-tester didn't produce a result this run." : inRun(ME) ? "Waiting for its first weekly run." : "Not benchmarked yet.");
  return fixList("Correctness", "required checks", t.failed.map(f => ({ t: esc(f), g: "fails", cls: "bad", why: "Required by relay-tester, run against the relay as shipped." })),
    `All ${t.required_total} required checks pass. ${t.optional_pass} of ${t.optional_total} optional ones do too.`);
}

// --- scoreboard ------------------------------------------------------------------------------

let scope = store.get("scope", "bench"), sortK = store.get("sortK", "perf"), sortDir = -1;

function rows() {
  const ids = new Set([...Object.keys(LATEST), ...(scope === "all" || !Object.keys(LATEST).length ? Object.keys(CAP.relays) : []), ...(ME ? [ME] : [])]);
  return [...ids].map(id => {
    const L = LATEST[id], p = perfOf(id), t = L ? tester(L.r) : null;
    return { id, name: nm(id), L, perf: p?.overall ?? null, perfParts: p?.parts ?? 0,
             correct: t?.pct ?? null, t, cap: capScore(id), act: L?.r.activity?.commits_90d ?? ACT[id]?.commits_90d ?? null,
             version: L?.r.version, date: L?.run.date };
  });
}

function drawBoard() {
  const tops = r => r.sort((a, b) => b[1] - a[1])[0]?.[0];
  const tp = tops(Object.keys(LATEST).map(id => [id, perfOf(id)?.overall ?? -1]).filter(x => x[1] >= 0));
  const tc = tops(Object.keys(CAP.relays).map(id => [id, capScore(id)]));
  $("#board-title").textContent = tp ? `${nm(tp)} leads on performance, ${nm(tc)} on capability` : `${nm(tc)} leads on capability; performance arrives with the first weekly run`;
  const cols = [["name", "Relay"], ["perf", "Performance"], ["correct", "Correctness"], ["cap", "Capability"], ["act", "Commits, 90 days"], ["date", "Measured"]];
  const list = rows().sort((a, b) => {
    const x = a[sortK], y = b[sortK];
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * (sortK === "name" ? 1 : sortDir);
  });
  const t = $("#board");
  t.innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" ${k === sortK ? `aria-sort="${sortK === "name" ? "ascending" : sortDir < 0 ? "descending" : "ascending"}"` : ""} ${["correct", "act", "date"].includes(k) ? 'class="num"' : ""}>${l}</th>`).join("")}</tr></thead>` +
    `<tbody>${list.map(r => `<tr data-id="${esc(r.id)}" tabindex="0" class="${r.id === ME ? "me" : ""}">
      <td><span class="rname">${esc(r.name)}</span><span class="rver">${esc(r.version || (r.L ? "" : "scored only, not benchmarked"))}</span></td>
      <td>${r.perf != null ? `<span class="cell-bar"><span class="v">${fmt(r.perf)}</span>${logBar(r.perf)}</span>` : `<span class="na">${r.L ? (r.L.r.perf_skipped ? "correctness only" : r.L.r.error ? "did not run" : "no data") : "–"}</span>`}</td>
      <td class="num">${r.correct != null ? `${Math.round(r.correct)}% <span class="muted">${r.t.required_pass}/${r.t.required_total}</span>` : `<span class="na">–</span>`}</td>
      <td>${r.cap != null ? `<span class="cell-bar"><span class="v">${r.cap}</span>${linBar(r.cap)}</span>` : `<span class="na">not scored</span>`}</td>
      <td class="num">${r.act ?? "–"}</td>
      <td class="num muted">${esc(r.date || "")}</td></tr>`).join("")}</tbody>`;
  t.querySelectorAll("th[data-k]").forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    sortDir = k === sortK ? -sortDir : -1; sortK = k; store.set("sortK", k); drawBoard();
  });
  t.querySelectorAll("tbody tr").forEach((tr, i) => {
    tr.onclick = () => openDetail(tr.dataset.id);
    tr.onkeydown = e => { if (e.key === "Enter") openDetail(tr.dataset.id); };
    const r = list[i];
    if (r.perf != null) bindTip(tr.children[1], `<b>${esc(r.name)}</b>: ${fmt(r.perf)} (strfry = 100), from ${r.perfParts} of 4 areas`);
  });
}

// --- performance multiples -------------------------------------------------------------------

function drawPerf() {
  $("#perf-legend").innerHTML = AREAS.filter(a => a.overall).map(a => `<span><span class="sw" style="background:var(${a.c})"></span>${a.name}</span>`).join("") +
    `<span><span class="sw" style="background:var(--neutral)"></span>outside the index</span><span><span class="dash"></span>strfry = 100</span>`;
  const el = $("#perf"); el.innerHTML = "";
  $("#perf-legend").hidden = !Object.keys(LATEST).length;
  if (!Object.keys(LATEST).length) { el.innerHTML = `<div class="card"><p class="muted">The first weekly run hasn't been published yet. Results land here every Sunday.</p></div>`; return; }
  for (const a of AREAS) {
    const list = Object.keys(LATEST).filter(id => perfOf(id)).map(id => ({ id, idx: perfOf(id).areas[a.id] }))
      .sort((x, y) => (y.idx.v ?? -1) - (x.idx.v ?? -1));
    const p = document.createElement("div");
    p.className = "card panel" + (a.overall ? "" : " side");
    if (a.c) p.style.setProperty("--c", `var(${a.c})`);
    p.innerHTML = `<div><h3><i></i>${a.name}</h3><div class="sub">${a.tests.length} test${a.tests.length > 1 ? "s" : ""}${AREA_NOTE[a.id] ? " · " + AREA_NOTE[a.id] : ""}</div></div>`;
    const bars = document.createElement("div"); bars.className = "bars" + (ME && list.some(x => x.id === ME) ? " picked" : "");
    if (!list.length) bars.innerHTML = `<span class="na">No results yet.</span>`;
    for (const { id, idx } of list) {
      const row = document.createElement("div"); row.className = "hrow" + (id === ME ? " me" : "");
      row.innerHTML = `<span class="l">${esc(nm(id))}</span>` +
        (idx.v != null ? `${logBar(idx.v)}<span class="v">${fmt(idx.v)}</span>` : `<span class="why">${WHY[idx.why] || "no data"}</span>`);
      bindTip(row, () => areaTip(id, a));
      row.onclick = () => openDetail(id);
      bars.append(row);
    }
    p.append(bars);
    el.append(p);
  }
}

function areaTip(id, a) {
  const L = LATEST[id], base = baseline(L.run);
  return `<b>${esc(nm(id))}</b> · ${a.name}<br>` + a.tests.map(t => {
    const v = testValue(L.r, t), x = base ? ratio(L.r, base, t) : null;
    return `${esc(t[1])}: ${v.status === "ok" ? `${fmt(v.v)} ${t[3]}${x ? ` <span class="muted">(${fmt(100 * x)})</span>` : ""}` : `<span class="muted">${WHY[v.status] || v.status}</span>`}`;
  }).join("<br>");
}

// --- capability ------------------------------------------------------------------------------

function drawCap() {
  const ids = Object.keys(CAP.relays).sort((a, b) => capScore(b) - capScore(a)), h = $("#heat");
  const me = id => id === ME ? "me" : "";
  h.innerHTML = `<thead><tr><th></th>${ids.map(id => `<th scope="col" class="${me(id)}" data-id="${esc(id)}"><span>${esc(nm(id))}</span></th>`).join("")}</tr></thead>` +
    GROUPS.map(([g, name]) => `<tbody><tr class="grp"><th colspan="${ids.length + 1}">${name}</th></tr>${CRIT.filter(c => c.group === g).map(c =>
      `<tr><th scope="row">${esc(c.name)}<span class="w">×${c.weight}</span></th>${ids.map(id => {
        const s = CAP.relays[id].scores[c.id] ?? 0;
        return `<td class="s${s} ${me(id)}" data-id="${esc(id)}" data-c="${c.id}">${s}</td>`;
      }).join("")}</tr>`).join("")}</tbody>`).join("") +
    `<tfoot><tr><th>Score / 100</th>${ids.map(id => `<td class="${me(id)}">${capScore(id)}</td>`).join("")}</tr></tfoot>`;
  h.querySelectorAll("thead th[data-id]").forEach(th => th.onclick = () => setMe(th.dataset.id === ME ? null : th.dataset.id));
  h.querySelectorAll("td[data-c]").forEach(td => {
    const r = CAP.relays[td.dataset.id], c = CRIT.find(x => x.id === td.dataset.c);
    bindTip(td, `<b>${esc(r.name)}</b> · ${esc(c.name)}: ${td.textContent}/3` +
      (r.evidence?.[c.id] ? `<br><span class="muted">${esc(r.evidence[c.id])}</span>` : ""));
  });
}

// --- trend -----------------------------------------------------------------------------------

function drawTrend() {
  $("#trend-sec").hidden = RUNS.length < 2;
  if (RUNS.length < 2) return;
  $("#trend-note").textContent = `${RUNS.length} weekly runs, ${RUNS[0].date} to ${RUNS.at(-1).date}. Each line is a relay's performance index; the dashed line is strfry.`;
  const el = $("#trend"); el.innerHTML = "";
  for (const id of Object.keys(LATEST).sort((a, b) => (b === ME) - (a === ME) || nm(a).localeCompare(nm(b)))) {
    const pts = RUNS.map((run, i) => run.relays[id] ? [i, perf({ ...run.relays[id], id }, run)?.overall] : null).filter(p => p && p[1] != null);
    if (!pts.length) continue;
    const W = 220, H = 34, ys = pts.map(p => Math.log10(p[1]));
    const lo = Math.min(...ys, 2) - 0.05, hi = Math.max(...ys, 2) + 0.05;
    const X = i => (i / (RUNS.length - 1)) * W, Y = y => H - ((y - lo) / (hi - lo)) * H;
    const d = pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(Math.log10(p[1])).toFixed(1)}`).join("");
    const card = document.createElement("div"); card.className = "trend" + (id === ME ? " me" : "");
    card.innerHTML = `<div class="t"><span>${esc(nm(id))}</span><span class="num">${fmt(pts.at(-1)[1])}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Performance index over ${pts.length} runs">
        <line x1="0" x2="${W}" y1="${Y(2)}" y2="${Y(2)}" stroke="var(--base)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <path d="${d}" fill="none" stroke="var(${id === ME ? "--accent" : "--dot"})" stroke-width="2" vector-effect="non-scaling-stroke"/>
      </svg>`;
    card.onclick = () => openDetail(id);
    el.append(card);
  }
}

// --- catalog ---------------------------------------------------------------------------------

let tier = store.get("tier", "all");
function drawCatalog() {
  const cat = META.catalog;
  const act = c => ACT[c.id || c.name];
  const gap = c => act(c)?.commits_90d > 0 && !(c.id && META.benched[c.id]);
  const counts = { all: cat.length, gap: cat.filter(gap).length };
  for (const c of cat) counts[c.tier] = (counts[c.tier] || 0) + 1;
  $("#cat-title").textContent = `${cat.length} relay implementations, ${cat.filter(c => act(c)?.commits_90d > 0).length} of them still committing`;
  const draw = () => {
    const list = cat.filter(c => tier === "all" || (tier === "gap" ? gap(c) : c.tier === tier));
    $("#cat").innerHTML = `<thead><tr><th>Relay</th><th>Tier</th><th class="num">Commits, 90 days</th><th>Language</th><th>Storage</th><th>What it is</th><th>Notes</th></tr></thead><tbody>` +
      list.map(c => `<tr class="${c.id && c.id === ME ? "me" : ""}"><td>${c.repo ? `<a href="${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}
        ${c.id && LATEST[c.id] ? ' <span class="badge good">benchmarked</span>' : c.id && CAP.relays[c.id] ? ' <span class="badge dim">scored</span>' : ""}</td>
        <td>${esc(c.tier)}${c.archived ? ' <span class="badge bad">archived</span>' : ""}</td>
        <td class="num">${act(c)?.commits_90d ?? "–"}${act(c)?.last_commit ? `<span class="rver">${esc(act(c).last_commit)}</span>` : ""}</td><td>${esc(c.language)}</td><td>${esc(c.storage)}</td>
        <td>${esc(c.about)}</td><td>${esc(c.notes)}</td></tr>`).join("") + "</tbody>";
  };
  seg($("#cat-f"), TIERS, tier, k => { tier = k; store.set("tier", k); draw(); }, counts);
  draw();
}

// --- detail ----------------------------------------------------------------------------------

function openDetail(id) {
  const L = LATEST[id], cap = CAP.relays[id], cat = META.catalog.find(c => c.id === id);
  let h = `<h2 id="d-title">${esc(nm(id))}</h2>`;
  if (cap?.summary) h += `<p>${esc(cap.summary)}</p>`;
  if (id !== ME) h += `<div class="acts"><button type="button" id="d-pick">Compare as ${esc(nm(id))}</button></div>`;
  h += `<dl class="kv">`;
  if (cat?.repo) h += `<dt>Repository</dt><dd><a href="${esc(cat.repo)}" target="_blank" rel="noopener">${esc(cat.repo)}</a></dd>`;
  if (L) {
    const r = L.r, act = r.activity?.commits_90d != null ? r.activity : ACT[id];
    h += `<dt>Version</dt><dd>${esc(r.version)} <span class="muted">${esc((r.commit || "").slice(0, 12))}</span></dd>
      <dt>Measured</dt><dd>${esc(L.run.date)}</dd>
      <dt>Activity</dt><dd>${act?.commits_90d ?? "–"} commits in 90 days, last ${esc(act?.last_commit || "–")}</dd>
      <dt>NIP-11</dt><dd>${esc(r.nip11?.software || "")} ${esc(r.nip11?.version || "")}<br>supported_nips: ${esc(JSON.stringify(r.nip11?.supported_nips ?? null))}</dd>`;
    if (META.benched[id]?.notes) h += `<dt>Setup</dt><dd>${esc(META.benched[id].notes)} <a href="${REPO}/tree/main/relays/${esc(id)}" target="_blank" rel="noopener">config</a></dd>`;
    if (r.footprint) h += `<dt>Footprint</dt><dd>${fmt(r.footprint.rss_mb)} MB memory, ${fmt(r.footprint.disk_mb)} MB disk after the load</dd>`;
    if (r.error) h += `<dt>Perf run</dt><dd><span class="badge bad">failed</span> ${esc(r.error)}</dd>`;
    if (r.error_default) h += `<dt>Default run</dt><dd><span class="badge bad">failed</span> ${esc(r.error_default)}</dd>`;
  } else {
    h += `<dt>Benchmark</dt><dd>Not benchmarked (capability only)</dd>`;
    if (ACT[id]) h += `<dt>Activity</dt><dd>${ACT[id].commits_90d ?? "–"} commits in 90 days, last ${esc(ACT[id].last_commit || "–")}</dd>`;
  }
  h += `</dl>`;
  if (L && L.r.perf_skipped) h += `<p>Not load-tested: its throughput is capped in code, so a load test would only measure the cap. Correctness is still checked weekly.</p>`;
  if (L && !L.r.perf_skipped) {
    const base = baseline(L.run);
    h += `<h3>Performance</h3><div class="scroll"><table><thead><tr><th>Test</th><th class="num">Result</th><th class="num">strfry</th><th class="num">Index</th></tr></thead><tbody>`;
    for (const a of AREAS) {
      h += `<tr><td colspan="4"><b style="color:var(--fg)">${a.name}</b></td></tr>`;
      for (const t of a.tests) {
        const v = testValue(L.r, t), b = base ? testValue(base, t) : {}, x = base ? ratio(L.r, base, t) : null;
        const badge = v.status === "ok" ? "" : `<span class="badge ${v.status === "private" ? "good" : v.status === "unsupported" || v.status === "missing" ? "dim" : "bad"}">${WHY[v.status] || v.status}</span>`;
        h += `<tr><td>${esc(t[1])}</td><td class="num">${v.status === "ok" ? `${fmt(v.v)} ${t[3]}` : badge}</td>
          <td class="num muted">${b.status === "ok" ? `${fmt(b.v)} ${t[3]}` : "–"}</td><td class="num">${x ? fmt(100 * x) : "–"}</td></tr>`;
      }
    }
    h += `</tbody></table></div>`;
  }
  const t = L && tester(L.r);
  if (t) h += `<h3>Correctness</h3><p>${t.required_pass} of ${t.required_total} required relay-tester checks and ${t.optional_pass} of ${t.optional_total} optional ones pass with the relay as shipped.` +
    (t.failed.length ? ` Failed: ${t.failed.map(esc).join("; ")}.` : "") + `</p>`;
  if (cap) {
    h += `<h3>Capability: ${capScore(id)} / 100</h3><div class="scroll"><table><thead><tr><th>Criterion</th><th class="num">Score</th><th>Evidence</th></tr></thead><tbody>` +
      CRIT.map(c => `<tr><td>${esc(c.name)} <span class="muted">×${c.weight}</span></td><td class="num">${cap.scores[c.id] ?? 0}/3</td><td>${esc(cap.evidence?.[c.id] || "")}</td></tr>`).join("") +
      `</tbody></table></div><p>Scored ${esc(cap.scored)}. Disagree? Edit <code>capability/relays/${esc(id)}.toml</code> and send a PR.</p>`;
  }
  $("#d-body").innerHTML = h;
  const b = $("#d-pick");
  if (b) b.onclick = () => { $("#detail").close(); setMe(id); $("#you").scrollIntoView({ behavior: "smooth" }); };
  $("#detail").showModal();
}

// --- method ----------------------------------------------------------------------------------

function drawMethod() {
  const run = RUNS.at(-1), s = run?.settings || {}, host = run?.host || {};
  $("#method-body").innerHTML = `
    <h3>What runs</h3>
    <p>Each relay is built from its newest release tag, or from the head of its main branch when it doesn't tag releases, with the Docker definition in <code>relays/&lt;id&gt;/</code>. It runs twice on fresh volumes. The <b>perf profile</b> raises every per-client limit so the load generator, not a rate limiter, is what gets measured, and opens gift-wrap reads where the relay allows it. The <b>default profile</b> is the relay as shipped, and that is what relay-tester checks.</p>
    <h3>Load</h3>
    <p>${fmt(s.events)} events from relay-bench's generator (seed ${s.seed ?? 1}): about 30% public events (kinds 1, 7, 30023, replaceables, community traffic) and 70% NIP-17 gift wraps. Public events go in first and every public query runs before any gift wrap is loaded, so a relay that keeps gift wraps private is judged on everything else as normal. Tools: relay-bench (VectorPrivacy/magnitude-relay) for load, queries, COUNT, negentropy, live fan-out and idle connections; nostr-bench (privkeyio) for one-event-at-a-time writes; relay-tester (mikedilger) for protocol conformance. Each is pinned to a commit in <code>tools/</code>.</p>
    <h3>Machine</h3>
    <p>${esc(host.cpu || "–")}, ${host.threads ?? "–"} threads, kernel ${esc(host.kernel || "–")}, Docker ${esc(host.docker || "–")}. Every container of a relay's stack (its database too) is pinned to CPUs ${esc(host.relay_cpus || "–")}; the load tools run on ${esc(host.load_cpus || "–")}. One relay runs at a time.</p>
    <h3>Indexes</h3>
    <p>Each test's result is divided by strfry's on the same run (inverted where lower is better). An area is the geometric mean of its tests, and the performance index is the geometric mean of Writing, Reading, Live delivery and Connections. A test with wrong answers, refused events or no support is left out instead of counted, and the area says so. Capability is Σ weight × score over 3 × Σ weight, from <code>capability/</code>. Scores are judgement calls made from code and docs, with the evidence beside each one.</p>
    <h3>What would help most</h3>
    <p>Speed lists the tests where a relay is furthest below the median of every load-tested relay (each measured against strfry in its own run), after any test it answered wrongly or refused. Capability lists the criteria not yet at 3, heaviest first, with the points one step up is worth out of 100. Correctness lists the required relay-tester checks that fail.</p>
    <h3>Known limits</h3>
    <p>The dataset follows relay-bench's mix, which leans on gift wraps. That is why private messaging and negentropy sit outside the overall index. A relay that sends live events before they are fsynced will show lower fan-out latency than one that waits for the commit. relay-bench never AUTHs, so AUTH-gated reads show as private or refused.</p>`;
}

// --- boot ------------------------------------------------------------------------------------

function draw() { drawYou(); drawBoard(); drawPerf(); drawCap(); drawTrend(); drawCatalog(); }

async function main() {
  const [res, meta, act] = await Promise.all([fetch("data/results.json").then(r => r.json()), fetch("data/meta.json").then(r => r.json()),
    fetch("data/activity.json").then(r => r.json()).catch(() => ({ relays: {} }))]);
  ACT = act.relays || {};
  RUNS = res.runs.sort((a, b) => a.date.localeCompare(b.date));
  META = meta; CAP = meta.capability; CRIT = CAP.criteria;
  for (const [id, c] of Object.entries(CAP.relays)) NAMES[id] = c.name;
  for (const run of RUNS) for (const [id, r] of Object.entries(run.relays)) {
    r.id = id; NAMES[id] = NAMES[id] || r.name;
    if (r.metrics && Object.keys(r.metrics).length || !LATEST[id]) LATEST[id] = { r, run };
  }
  buildField(); setScale();
  drawStats(); drawPicker(); drawMethod();
  seg($("#scope"), [["bench", "Benchmarked"], ["all", "All scored"]], scope, k => { scope = k; store.set("scope", k); drawBoard(); });
  setMe(decodeURIComponent(location.hash.slice(1)), true);
}
main().catch(e => { $("#you-title").textContent = "Could not load the data: " + e.message; console.error(e); });
