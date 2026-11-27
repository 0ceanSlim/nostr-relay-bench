"use strict";
// Everything on the page is computed here from data/results.json (the weekly runs),
// data/meta.json (capability scores, catalog, relay definitions) and data/changes.json (the
// run-to-run headlines bench/changes.py writes). Indexes are computed here, not stored.

const BASE = "strfry";
const REPO = "https://github.com/0ceanSlim/nostr-relay-bench";
// Areas of the performance index. Each test: [id, label, "up"|"down", unit, get?]. get() pulls
// the value from a relay's result; the default is the test's throughput. c: the area's colour;
// areas without one are reported but left out of the overall index.
const AREAS = [
  { id: "write", name: "Writing", overall: true, c: "--a-write", tests: [
    ["ingest", "Bulk ingest", "up", "ev/s"],
    ["ingest_dup", "Duplicate resends", "up", "ev/s"],
    ["write_roundtrip", "One event at a time", "up", "ev/s"] ] },
  { id: "read", name: "Reading", overall: true, c: "--a-read", tests: [
    ["latest_1", "Newest event", "up", "q/s"], ["latest_100", "Newest 100", "up", "q/s"],
    ["latest_500", "Newest 500", "up", "q/s"], ["author", "By author", "up", "q/s"], ["kind", "By kind", "up", "q/s"],
    ["author_kind", "By author and kind", "up", "q/s"], ["tag", "By hashtag", "up", "q/s"],
    ["time_window", "Time window", "up", "q/s"], ["exact_id", "By id", "up", "q/s"],
    ["exact_ids_100", "100 ids at once", "up", "q/s"], ["miss", "No match", "up", "q/s"],
    ["multi_filter", "Three filters in one REQ", "up", "q/s"] ] },
  { id: "live", name: "Live delivery", overall: true, c: "--a-live", tests: [
    ["fanout", "Fan-out to subscribers", "down", "ms", m => m.p50_us / 1000] ] },
  { id: "connections", name: "Connections", overall: true, c: "--a-connections", tests: [
    ["idle", "Idle connections", "up", "conn/s"] ] },
  { id: "footprint", name: "Footprint", overall: false, tests: [
    ["rss", "Memory after the load", "down", "MB", (m, r) => r.footprint?.rss_mb],
    ["disk", "Disk after the load", "down", "MB", (m, r) => r.footprint?.disk_mb] ] },
  { id: "private", name: "Private messaging", overall: false, tests: [
    ["dm_inbox", "Gift-wrap inbox", "up", "q/s"], ["dm_catchup", "Inbox catch-up", "up", "q/s"],
    ["dm_ids", "Gift wraps by id", "up", "q/s"], ["concord_page", "Community page", "up", "q/s"],
    ["concord_paging", "Community paging", "up", "walks/s"], ["count", "COUNT", "up", "q/s"] ] },
  { id: "sync", name: "Negentropy sync", overall: false, tests: [
    ["neg_light_90", "Small mailboxes", "up", "sessions/s"], ["neg_heavy_90", "Large mailboxes", "up", "sessions/s"] ] },
];
// What each test asks and which client behaviour it stands for. The filters are relay-bench's
// (tools/relay-bench pins the commit); every query carries an explicit limit.
const TEST_INFO = {
  ingest: ["A busy relay taking in a backlog: the whole dataset over 8 connections, public events first, then gift wraps. Counted from the OKs.", "EVENT × every event, 8 connections"],
  ingest_dup: ["Events the relay already has, the normal case for a relay that many clients publish the same note to.", "EVENT (already stored)"],
  write_roundtrip: ["Someone posting: publish one event, wait for its OK, publish the next.", "EVENT → OK, one at a time (nostr-bench)"],
  latest_1: ["A client checking whether anything new arrived.", '{"kinds":[notes, reactions, articles],"limit":1}'],
  latest_100: ["Opening a global feed.", '{"kinds":[…],"limit":100}'],
  latest_500: ["Scrolling a global feed a long way.", '{"kinds":[…],"limit":500}'],
  author: ["Opening someone's profile.", '{"authors":[pk],"limit":100}'],
  kind: ["A kind-wide scan: profiles, notes, reactions, relay lists, articles, app data.", '{"kinds":[k],"limit":100}'],
  author_kind: ["A profile's notes tab, or fetching someone's relay list.", '{"authors":[pk],"kinds":[k],"limit":100}'],
  tag: ["A hashtag feed.", '{"#t":[word],"limit":100}'],
  time_window: ["Catching up on one hour of activity.", '{"kinds":[…],"since":t,"until":t+1h,"limit":500}'],
  exact_id: ["Opening a link to one note.", '{"ids":[id],"limit":1}'],
  exact_ids_100: ["Loading the notes a thread quotes or replies to, in one request.", '{"ids":[100 ids],"limit":100}'],
  miss: ["Asking for something the relay doesn't have; the answer is a quick EOSE.", '{"ids":[unknown id],"limit":1}'],
  multi_filter: ["A client batching three questions into one REQ.", "[{authors},{#t},{kinds}], limit 50 each"],
  fanout: ["A live feed: 1,000 open subscriptions while 4 publishers send 2,000 events a second; the median time from publish to each delivery. Lower is better.", "REQ held × 1,000 · EVENT at 2,000/s"],
  idle: ["Clients that connect and sit there: how fast the relay accepts 10,000 connections and holds them for 20 seconds.", "WebSocket open × 10,000"],
  rss: ["Memory of all the relay's containers after the load. Lower is better.", "docker stats"],
  disk: ["Size of the relay's volumes after the load. Lower is better.", "du on its Docker volumes"],
  dm_inbox: ["Opening a NIP-17 inbox: the gift wraps addressed to one key. The bench AUTHs as the recipient first (NIP-42), so a relay that keeps these to their recipient is measured too.", '{"kinds":[1059],"#p":[pk],"limit":500}'],
  dm_catchup: ["The same inbox, only the last two days.", '{"kinds":[1059],"#p":[pk],"since":now-2d,"limit":500}'],
  dm_ids: ["Re-fetching known gift wraps by id.", '{"ids":[≤500],"kinds":[1059],"#p":[pk]}'],
  concord_page: ["The newest page of a Vector community, whose messages are gift wraps from one plane key.", '{"kinds":[1059],"authors":[plane],"limit":500}'],
  concord_paging: ["Scrolling back through a busy community page by page.", "until = last page's oldest, repeated"],
  count: ["An unread badge: how many gift wraps an inbox holds (NIP-45).", 'COUNT {"kinds":[1059],"#p":[pk]}'],
  neg_light_90: ["Syncing a small mailbox the client already has 90% of (NIP-77).", "NEG-OPEN, small sets"],
  neg_heavy_90: ["The same for large mailboxes.", "NEG-OPEN, large sets"],
};
const AREA_NOTE = {
  live: "Relays that deliver before the event is fsynced show far lower latency than ones that wait for the commit.",
  footprint: "Memory and disk trade against speed.",
  private: "Inbox reads and COUNT AUTH as the recipient (NIP-42). Community reads can't: those gift wraps p-tag random keys, so a relay that keeps gift wraps to their recipient shows “private by design” there.",
  sync: "NIP-77 is a feature; it's scored under capability.",
};
const WHY = { unsupported: "not supported", refused: "refused by policy", wrong: "wrong answers",
              failed: "failed", missing: "not run", private: "private by design" };
const GROUPS = [["protocol", "Protocol"], ["policy", "Policy & moderation"], ["operations", "Operations"], ["ecosystem", "Ecosystem"]];
const TIERS = [["all", "All"], ["active", "Active"], ["slowing", "Slowing"], ["dormant", "Dormant"], ["missed", "Missed by the survey"], ["gap", "Committing, not benchmarked"]];
// Language families on the field chart and scoreboard, in the validated palette order.
const LANGS = [["go", "Go", ["Go"]], ["rust", "Rust", ["Rust"]], ["cpp", "C / C++", ["C", "C++"]], ["zig", "Zig", ["Zig"]],
  ["ts", "TypeScript / JS", ["TypeScript", "JavaScript", "Deno", "Node"]], ["py", "Python", ["Python"]],
  ["jvm", "Kotlin / Java", ["Kotlin", "Java", "Scala"]], ["php", "PHP", ["PHP"]], ["other", "Other", []]];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const geo = xs => xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : null;
const median = xs => { const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length ? (s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2) : null; };
const fmt = (v, d = 0) => v == null ? "–" : v >= 100 ? Math.round(v).toLocaleString("en") : v.toLocaleString("en", { maximumFractionDigits: d || (v < 10 ? 2 : 1) });
const ord = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let RUNS = [], META, CAP, CRIT, LATEST = {}, NAMES = {}, ACT = {}, FIELD = {}, NEWS = { runs: [] }, ME = null, TAB = "board";
const nm = id => NAMES[id] || id;
const TESTS = AREAS.flatMap(a => a.tests.map(t => ({ t, a })));

// --- data ------------------------------------------------------------------------------------

function testValue(r, t) {
  const [id, , , , get] = t;
  const m = r.metrics?.[id];
  if (get) {
    const v = get(m || {}, r);
    return { v, status: v == null ? "missing" : (id === "fanout" ? m?.status : "ok") ?? "missing" };
  }
  if (!m) return { v: null, status: "missing" };
  // "private": the relay keeps gift wraps to their recipient and the bench couldn't AUTH for this read.
  // bench/summarize.py decides that from relays/<id>/relay.toml.
  if (m.status === "private") return { v: null, status: "private" };
  return { v: m.v, status: m.status };
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

function capScore(id, group, scores) {
  const s = scores || CAP.relays[id]?.scores;
  if (!s) return null;
  let got = 0, max = 0;
  for (const c of CRIT) if (!group || c.group === group) { got += c.weight * (s[c.id] ?? 0); max += c.weight * 3; }
  return Math.round(100 * got / max);
}

function tester(r) {
  const t = r?.tester;
  return t && t.required_total ? { pct: 100 * t.required_pass / t.required_total, ...t } : null;
}

function langOf(id) {
  const l = (META.catalog.find(c => c.id === id)?.language || "").split(/[ /,]/)[0];
  return (LANGS.find(([, , ls]) => ls.includes(l)) || LANGS.at(-1))[0];
}

// Per test, every load-tested relay's result: the field "what would help most" measures against.
function buildField() {
  for (const { t } of TESTS) {
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

function rankOf(id, ids, v) {
  const list = ids.map(k => [k, v(k)]).filter(([, x]) => x != null).sort((a, b) => b[1] - a[1]);
  const k = list.findIndex(([x]) => x === id);
  return k < 0 ? null : { k: k + 1, n: list.length };
}

// --- shared bits -----------------------------------------------------------------------------

const tip = $("#tip");
function showTip(e, html) {
  tip.innerHTML = html; tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 18 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 12 : e.clientY + 18;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function bindTip(el, html) {
  el.addEventListener("mousemove", e => showTip(e, typeof html === "function" ? html() : html));
  el.addEventListener("mouseleave", () => { tip.hidden = true; });
}
// One log scale for the index bars, whole decades wide enough for the field.
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

// --- state in the link: #r=<relay>&t=<tab> ---------------------------------------------------

function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h.includes("=")) return { r: h || null, t: null };
  const p = new URLSearchParams(h);
  return { r: p.get("r"), t: p.get("t") };
}
function writeHash() {
  const p = new URLSearchParams();
  if (ME) p.set("r", ME);
  if (TAB !== "board") p.set("t", TAB);
  const s = p.toString();
  history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
}
const known = id => !!(id && (LATEST[id] || CAP.relays[id]));
const inRun = id => !!(META.benched[id] && !META.benched[id].disabled);
function setMe(id) {
  ME = known(id) ? id : null;
  $("#pick").value = ME || "";
  $("#pick").classList.toggle("on", !!ME);
  $("#unpick").hidden = !ME;
  writeHash();
  draw();
}
function drawPicker() {
  const bench = Object.keys(LATEST).sort((a, b) => nm(a).localeCompare(nm(b)));
  const only = Object.keys(CAP.relays).filter(id => !LATEST[id]).sort((a, b) => nm(a).localeCompare(nm(b)));
  const opt = id => `<option value="${esc(id)}">${esc(nm(id))}</option>`;
  $("#pick").innerHTML = `<option value="">nobody (whole field)</option>` +
    (bench.length ? `<optgroup label="Benchmarked weekly">${bench.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Scored, not benchmarked">${only.map(opt).join("")}</optgroup>`;
  $("#pick").onchange = e => setMe(e.target.value);
  $("#unpick").onclick = () => setMe(null);
}

// --- tabs ------------------------------------------------------------------------------------

function tabList() {
  return [["board", "Scoreboard"], ["relay", ME ? nm(ME) : "Your relay"], ["perf", "Performance"], ["tests", "Tests", TESTS.length],
    ["cap", "Capability", CRIT.length], ...(RUNS.length > 1 ? [["trend", "Over time", RUNS.length]] : []),
    ["catalog", "Catalog", META.catalog.length], ["method", "Method"]];
}
function drawTabs() {
  const list = tabList();
  if (!list.some(([k]) => k === TAB)) TAB = "board";
  $("#tabs").innerHTML = list.map(([k, l, n]) => `<button type="button" role="tab" data-t="${k}" aria-selected="${k === TAB}">${esc(l)}${n ? `<span class="n">${n}</span>` : ""}</button>`).join("");
  $("#tabs").querySelectorAll("button").forEach(b => b.onclick = () => setTab(b.dataset.t));
  document.querySelectorAll(".panel-tab").forEach(p => p.hidden = p.dataset.tab !== TAB);
}
function setTab(t, scroll) {
  TAB = t; writeHash(); drawTabs();
  if (scroll) $("#tabs").scrollIntoView({ behavior: "smooth" });
}

// --- header ----------------------------------------------------------------------------------

function drawHead() {
  const last = RUNS.at(-1), s = last?.settings || {}, host = last?.host || {};
  const active = META.catalog.filter(c => ACT[c.id || c.name]?.commits_90d > 0).length;
  const benched = Object.values(META.benched).filter(b => !b.disabled && !b.heavy).length;
  $("#statline").innerHTML = [
    last ? `run <b>${esc(last.date)}</b>` : `<b>first run in progress</b>`,
    `<b>${last ? Object.keys(last.relays).length : benched}</b> benchmarked`,
    `<b>${Object.keys(CAP.relays).length}</b> scored`,
    `<b>${META.catalog.length}</b> cataloged, <b>${active}</b> committing`,
    host.cpu ? `${esc(host.cpu)}` : ""].filter(Boolean).map(x => `<span>${x}</span>`).join("");
  const ev = s.events || 1000000;
  const steps = [
    ["Build", `Each relay from its newest release (or main), in Docker, pinned to ${esc(host.relay_cpus ? "CPUs " + host.relay_cpus : "its own CPUs")}.`],
    ["Load", `${fmt(ev)} generated events: 30% public notes, reactions and articles, 70% NIP-17 gift wraps.`],
    ["Measure", `${TESTS.length} tests in ${AREAS.length} areas, each against strfry in the same run.`, "tests"],
    ["Check", "relay-tester's protocol checks on the relay as shipped, plus 18 scored capabilities.", "method"]];
  $("#steps").innerHTML = steps.map(([t, d, tab], i) => `<div class="step"><span class="n">${i + 1} /</span><b>${t}</b><span>${d}${tab ? ` <a href="#" data-tab="${tab}">more</a>` : ""}</span></div>`).join("");
  $("#steps").querySelectorAll("a[data-tab]").forEach(a => a.onclick = e => { e.preventDefault(); setTab(a.dataset.tab, true); });
}

// --- the field chart -------------------------------------------------------------------------
// Any two measures against each other, every relay a dot. Previous-run positions trail behind.

const METRICS = [
  ["perf", "Performance index", "log", id => perfOf(id)?.overall, (id, run) => perfAt(id, run)?.overall],
  ...AREAS.map(a => [`area:${a.id}`, `${a.name} index`, "log", id => perfOf(id)?.areas[a.id].v, (id, run) => perfAt(id, run)?.areas[a.id].v]),
  ["cap", "Capability", "lin", id => capScore(id), (id, run) => run.capability?.[id] ?? capScore(id)],
  ...GROUPS.map(([g, n]) => [`cap:${g}`, `Capability: ${n}`, "lin", id => capScore(id, g), () => null]),
  ["correct", "Correctness, % required checks", "lin", id => LATEST[id] && tester(LATEST[id].r)?.pct, (id, run) => run.relays[id] && tester(run.relays[id])?.pct],
  ["commits", "Commits, last 90 days", "log1", id => LATEST[id]?.r.activity?.commits_90d ?? ACT[id]?.commits_90d, () => null],
  ["rss", "Memory after the load, MB", "log", id => LATEST[id]?.r.footprint?.rss_mb, (id, run) => run.relays[id]?.footprint?.rss_mb],
];
const metric = k => METRICS.find(m => m[0] === k) || METRICS[0];
function perfAt(id, run) { const r = run.relays[id]; return r ? perf({ ...r, id }, run) : null; }
let AX = { x: store.get("fx", "cap"), y: store.get("fy", "perf") };
// Before the first run there's no performance, so the default plots commits instead.
const axDefault = () => ({ x: "cap", y: Object.keys(LATEST).length ? "perf" : "commits" });

function drawAxes() {
  const opts = sel => METRICS.map(([k, l]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  $("#axes").innerHTML = `<label>y <select id="ax-y">${opts(AX.y)}</select></label><label>x <select id="ax-x">${opts(AX.x)}</select></label>` +
    (AX.x !== axDefault().x || AX.y !== axDefault().y ? `<button type="button" class="btn" id="ax-reset">reset</button>` : "");
  const rs = $("#ax-reset");
  if (rs) rs.onclick = () => { AX = axDefault(); store.set("fx", AX.x); store.set("fy", AX.y); drawField(); };
  $("#ax-x").onchange = e => { AX.x = e.target.value; store.set("fx", AX.x); drawField(); };
  $("#ax-y").onchange = e => { AX.y = e.target.value; store.set("fy", AX.y); drawField(); };
}

function scaleFor(kind, vals) {
  if (kind === "lin") return { lo: 0, hi: 100, f: v => v, ticks: [0, 25, 50, 75, 100], fmt: v => v };
  const off = kind === "log1" ? 1 : 0, f = v => Math.log10(v + off);
  const lo = Math.floor(Math.min(...vals.map(f), kind === "log1" ? 0 : 2)), hi = Math.ceil(Math.max(...vals.map(f), 2));
  const ticks = kind === "log1" ? [0] : []; for (let e = lo; e <= hi; e++) if (kind !== "log1" || e > 0) ticks.push(10 ** e);
  return { lo, hi: hi === lo ? lo + 1 : hi, f, ticks, fmt: v => fmt(v) };
}

function drawField() {
  // Before the first run there's no performance yet, so fall back to what does exist.
  if (!Object.keys(LATEST).length && /^(perf|area|correct|rss)/.test(AX.y)) AX.y = "commits";
  if (!Object.keys(LATEST).length && /^(perf|area|correct|rss)/.test(AX.x)) AX.x = "cap";
  drawAxes();
  const mx = metric(AX.x), my = metric(AX.y);
  const ids = [...new Set([...Object.keys(LATEST), ...Object.keys(CAP.relays)])];
  const pts = ids.map(id => ({ id, x: mx[3](id), y: my[3](id) })).filter(p => p.x != null && p.y != null && (mx[2] === "lin" || p.x > 0 || mx[2] === "log1") && (my[2] === "lin" || p.y > 0 || my[2] === "log1"));
  $("#field-title").textContent = `${my[1].replace(/,.*/, "")} against ${mx[1].replace(/,.*/, "").toLowerCase()}`;
  const W = 760, H = 470, L = 56, R = 16, T = 14, B = 40;
  if (!pts.length) { $("#field").innerHTML = `<p class="muted">No relay has both of these yet.</p>`; return; }
  const sx = scaleFor(mx[2], pts.map(p => p.x)), sy = scaleFor(my[2], pts.map(p => p.y));
  const X = v => L + (sx.f(v) - sx.lo) / (sx.hi - sx.lo) * (W - L - R), Y = v => T + (1 - (sy.f(v) - sy.lo) / (sy.hi - sy.lo)) * (H - T - B);
  let g = `<g class="grid">`;
  for (const t of sx.ticks) g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${H - B}"/><text x="${X(t)}" y="${H - B + 16}" text-anchor="middle">${sx.fmt(t)}</text>`;
  for (const t of sy.ticks) g += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end">${sy.fmt(t)}</text>`;
  g += `</g><text class="axis-t" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(mx[1])} →</text><text class="axis-t" x="0" y="0" text-anchor="end" transform="translate(12 ${T}) rotate(-90)">${esc(my[1])} →</text>`;
  // strfry's 100 on index axes
  const isIdx = m => m[0] === "perf" || m[0].startsWith("area:");
  if (isIdx(mx)) g += `<line class="ref" x1="${X(100)}" x2="${X(100)}" y1="${T}" y2="${H - B}"/>`;
  if (isIdx(my)) g += `<line class="ref" x1="${L}" x2="${W - R}" y1="${Y(100)}" y2="${Y(100)}"/><text class="ref-t" x="${W - R - 2}" y="${Y(100) - 5}" text-anchor="end">strfry = 100</text>`;
  if (mx[0] === "cap" && isIdx(my)) g += `<text class="zone" x="${W - R - 4}" y="${T + 14}" text-anchor="end">FAST AND CAPABLE</text>`;
  // trails from the previous run
  const prev = RUNS.length > 1 ? RUNS.at(-2) : null;
  let trails = "";
  if (prev) for (const p of pts) {
    const px = mx[4](p.id, prev), py = my[4](p.id, prev);
    if (px == null || py == null || px <= 0 && mx[2] === "log" || py <= 0 && my[2] === "log") continue;
    const dx = X(px) - X(p.x), dy = Y(py) - Y(p.y);
    if (Math.hypot(dx, dy) < 4) continue;
    const c = `var(--l-${langOf(p.id)})`;
    trails += `<line class="trail" x1="${X(px)}" y1="${Y(py)}" x2="${X(p.x)}" y2="${Y(p.y)}" stroke="${c}"/><circle class="ghost" cx="${X(px)}" cy="${Y(py)}" r="3.5" stroke="${c}"/>`;
  }
  // dots, then labels where they fit (the chosen relay always gets one)
  const order = [...pts].sort((a, b) => (a.id === ME) - (b.id === ME));
  let dots = "";
  for (const p of order) {
    const me = p.id === ME;
    dots += `<g data-id="${esc(p.id)}"><circle class="hit" cx="${X(p.x)}" cy="${Y(p.y)}" r="13"/><circle class="pt${me ? " me" : ""}" cx="${X(p.x)}" cy="${Y(p.y)}" r="${me ? 8 : 5.5}" fill="var(--l-${langOf(p.id)})"/></g>`;
  }
  const boxes = [], lab = [];
  for (const p of [...pts].sort((a, b) => (b.id === ME) - (a.id === ME) || Y(a.y) - Y(b.y))) {
    const me = p.id === ME, w = nm(p.id).length * (me ? 7.4 : 6.4) + 4, h = me ? 14 : 12, gap = me ? 12 : 9;
    const cx = X(p.x), cy = Y(p.y);
    // right, left, above, below: the first spot that clears every other label and dot
    const spots = [[cx + gap, cy + 4, "start"], [cx - gap, cy + 4, "end"], [cx, cy - gap, "middle"], [cx, cy + gap + 9, "middle"]];
    const boxOf = ([x, y, a]) => { const bx = a === "start" ? x : a === "end" ? x - w : x - w / 2; return [bx, y - h + 2, bx + w, y + 2]; };
    const clear = box => box[0] >= L && box[2] <= W - R + 2 && box[1] >= T - 4 &&
      !boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) &&
      !pts.some(q => q !== p && X(q.x) > box[0] - 4 && X(q.x) < box[2] + 4 && Y(q.y) > box[1] - 4 && Y(q.y) < box[3] + 4);
    let spot = spots.find(sp => clear(boxOf(sp)));
    if (!spot) { if (!me) continue; spot = spots[0]; }
    boxes.push(boxOf(spot));
    lab.push(`<text class="nm${me ? " me" : ""}" x="${spot[0]}" y="${spot[1]}" text-anchor="${spot[2]}">${esc(nm(p.id))}</text>`);
  }
  $("#field").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(my[1])} against ${esc(mx[1])}, one dot per relay">${g}${trails}${dots}${lab.join("")}</svg>`;
  $("#field").querySelectorAll("g[data-id]").forEach(el => {
    const id = el.dataset.id, p = pts.find(q => q.id === id);
    el.addEventListener("mousemove", e => showTip(e, `<b>${esc(nm(id))}</b><br>${esc(my[1])}: ${fmt(p.y)}<br>${esc(mx[1])}: ${fmt(p.x)}<br><span class="muted">click to compare as it</span>`));
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
    el.onclick = () => setMe(id === ME ? null : id);
  });
  const counts = Object.fromEntries(LANGS.map(([k]) => [k, pts.filter(p => langOf(p.id) === k).length]));
  $("#field-legend").innerHTML = LANGS.filter(([k]) => counts[k]).map(([k, l]) => `<span><span class="sw" style="background:var(--l-${k})"></span>${l}</span>`).join("") +
    (prev ? `<span class="muted">lines trail from ${esc(prev.date)}</span>` : "") + `<span class="muted">${pts.length} relays · click a dot to compare</span>`;
}

// --- headlines -------------------------------------------------------------------------------

let newsIdx = 0, newsAll = false;
function drawNews() {
  const runs = NEWS.runs || [], sel = $("#news-run");
  sel.hidden = runs.length < 2;
  sel.innerHTML = runs.map((r, i) => `<option value="${i}" ${i === newsIdx ? "selected" : ""}>${esc(r.date)}</option>`).join("");
  sel.onchange = e => { newsIdx = +e.target.value; newsAll = false; drawNews(); };
  const run = runs[newsIdx];
  if (!run) {
    $("#news-title").textContent = "This week";
    $("#news").innerHTML = `<p class="muted" style="font-size:.82rem">The first full run is in progress. Each run after it lists what changed since the one before: new releases, speed moves, tests that broke or got fixed, checks gained or lost, re-scored capabilities.</p>`;
    return;
  }
  $("#news-title").textContent = run.prev ? `Since ${run.prev}` : "First run";
  const items = newsAll ? run.items : run.items.slice(0, 12);
  const mk = i => i.good === true ? `<span class="mk up">▲</span>` : i.good === false ? `<span class="mk down">▼</span>` : `<span class="mk flat">●</span>`;
  $("#news").innerHTML = (items.length ? `<ol>${items.map(i => `<li ${i.relay && known(i.relay) ? `data-id="${esc(i.relay)}"` : ""} class="${i.relay && i.relay === ME ? "me" : ""}">${mk(i)}<span>${esc(i.text)}</span></li>`).join("")}</ol>`
    : `<p class="muted">Nothing moved more than 10% since ${esc(run.prev)}.</p>`) +
    (run.items.length > items.length ? `<button type="button" class="more" id="news-more">${run.items.length - items.length} more</button>` : "");
  $("#news").querySelectorAll("li[data-id]").forEach(li => li.onclick = () => setMe(li.dataset.id));
  const more = $("#news-more"); if (more) more.onclick = () => { newsAll = true; drawNews(); };
}

// --- your relay ------------------------------------------------------------------------------

function strip(label, color, pts, pos, val, unitTip) {
  return `<div class="strip" style="--c:var(${color})"><span class="l"><i style="background:var(${color})"></i>${esc(label)}</span>
    <span class="lane">${pos.base != null ? `<span class="base" style="left:${pos.base}%"></span>` : ""}${pts.map(p =>
      `<span class="d${p.id === ME ? " me" : ""}" style="left:${pos(p.v)}%" data-tip="${esc(`<b>${esc(nm(p.id))}</b> · ${esc(label)}: ${fmt(p.v)}${unitTip}`)}"></span>`).join("")}</span>
    <span class="v${val == null || val.na ? " na" : ""}">${val?.na ?? val ?? "–"}</span></div>`;
}
function ticks(pos, list) {
  return `<div class="scale"><span></span><span class="ticks">${list.map(([v, l, minor]) => `<span class="${minor ? "minor" : ""}" style="left:${pos(v)}%">${l}</span>`).join("")}</span><span></span></div>`;
}

function drawYou() {
  const body = $("#you-body");
  $("#you-lede").hidden = !!ME;
  if (!ME) {
    const ids = Object.keys(LATEST).length ? Object.keys(LATEST) : Object.keys(CAP.relays);
    body.innerHTML = `<div class="chips">${ids.sort((a, b) => nm(a).localeCompare(nm(b))).map(id => `<button type="button" data-id="${esc(id)}">${esc(nm(id))}</button>`).join("")}</div>`;
    body.querySelectorAll("button").forEach(b => b.onclick = () => setMe(b.dataset.id));
    return;
  }
  const L = LATEST[ME], p = perfOf(ME), t = L && tester(L.r), cap = capScore(ME);
  const pr = p?.overall != null ? rankOf(ME, Object.keys(LATEST), id => perfOf(id)?.overall) : null;
  const cr = cap != null ? rankOf(ME, Object.keys(CAP.relays), id => capScore(id)) : null;
  const act = L?.r.activity?.commits_90d != null ? L.r.activity : ACT[ME];
  const tile = (n, l) => `<div class="stat"><span class="n">${n}</span><span class="l">${l}</span></div>`;
  let h = `<div class="stats">` +
    (p?.overall != null ? tile(`${fmt(p.overall)}<small>${ord(pr.k)} of ${pr.n}</small>`, "performance index, strfry = 100")
      : tile("–", L ? (L.r.perf_skipped ? "not load-tested: throughput is capped in code" : "no performance result this run") : inRun(ME) ? "performance: waiting for its first weekly run" : "not benchmarked yet")) +
    (t ? tile(`${t.required_pass}<small>of ${t.required_total}</small>`, "required relay-tester checks pass with the relay as shipped") : tile("–", "correctness not checked")) +
    (cap != null ? tile(`${cap}<small>${ord(cr.k)} of ${cr.n}</small>`, "capability out of 100") : tile("–", "capability not scored")) +
    tile(act?.commits_90d ?? "–", `commits in the last 90 days${act?.last_commit ? `, last ${esc(act.last_commit)}` : ""}`) + `</div>`;

  const lpos = v => logPos(v); lpos.base = logPos(100);
  const decades = []; for (let v = LO; v <= HI; v *= 10) decades.push([v, fmt(v), v !== LO && v !== 100 && v !== HI]);
  let perfCard;
  if (p) {
    const ids = Object.keys(LATEST).filter(id => perfOf(id));
    const rowsFor = get => ids.map(id => ({ id, v: get(perfOf(id)) })).filter(x => x.v != null);
    perfCard = strip("Overall", "--sel", rowsFor(q => q.overall), lpos, p.overall != null ? fmt(p.overall) : null, " (strfry = 100)") +
      AREAS.filter(a => a.overall).map(a => strip(a.name, a.c, rowsFor(q => q.areas[a.id].v), lpos,
        p.areas[a.id].v != null ? fmt(p.areas[a.id].v) : { na: WHY[p.areas[a.id].why] || "–" }, " (strfry = 100)")).join("") + ticks(lpos, decades);
  } else {
    perfCard = `<p class="muted">${L?.r.perf_skipped ? "Its throughput is capped in code, so a load test would only measure the cap. Correctness is still checked every week."
      : L ? "No performance result in its latest run." : inRun(ME) ? "In the weekly run; its numbers appear here after the next one."
      : `Not in the weekly run yet. A relay joins with a Docker definition in <code>relays/&lt;id&gt;/</code>; see <a href="${REPO}#adding-a-relay">adding a relay</a>.`}</p>`;
  }
  const cpos = v => v; cpos.base = null;
  const capIds = Object.keys(CAP.relays);
  const capCard = cap == null ? `<p class="muted">Not scored yet. Add <code>capability/relays/${esc(ME)}.toml</code> in a PR.</p>` :
    strip("Overall", "--sel", capIds.map(id => ({ id, v: capScore(id) })), cpos, cap, " / 100") +
    GROUPS.map(([g, name]) => strip(name, "--h3", capIds.map(id => ({ id, v: capScore(id, g) })), cpos, capScore(ME, g), " / 100")).join("") +
    ticks(cpos, [[0, "0"], [25, "25"], [50, "50"], [75, "75"], [100, "100"]]);
  h += `<div class="two">
    <div class="card"><h3>Performance against the field</h3><div class="sub">each dot a relay · strfry = 100 · log scale</div><div class="strips">${perfCard}</div></div>
    <div class="card"><h3>Capability against the field</h3><div class="sub">each dot a scored relay · out of 100</div><div class="strips">${capCard}</div></div></div>`;
  const W = CRIT.reduce((a, c) => a + c.weight, 0);
  h += `<div class="two">${rivals("Closest on performance", Object.keys(LATEST), id => perfOf(id)?.overall, logBar, v => fmt(v), (above, mine) => {
      const r = above[1] / mine, n = p?.parts || 4;
      return `To pass ${esc(nm(above[0]))}: ×${fmt(r, 2)} on the overall index, which is every area ${Math.max(1, Math.round(100 * (r - 1)))}% faster, or one area alone ×${fmt(r ** n, 2)}.`;
    })}${rivals("Closest on capability", Object.keys(CAP.relays), id => capScore(id), linBar, v => v, (above, mine) => {
      const s = CAP.relays[ME].scores, need = above[1] - mine;
      if (need <= 0) return `Level with ${esc(nm(above[0]))}.`;
      const steps = CRIT.filter(c => (s[c.id] ?? 0) < 3).sort((a, b) => b.weight - a.weight), pick = [];
      let got = 0;
      for (const c of steps) { if (got >= need) break; pick.push(c); got += 100 * c.weight / (3 * W); }
      return `To pass ${esc(nm(above[0]))}: +${need} points, for example ${pick.map(c => `${esc(c.name)} ${s[c.id] ?? 0}→${(s[c.id] ?? 0) + 1} (+${fmt(100 * c.weight / (3 * W), 1)})`).join(", ")}.`;
    })}</div>`;
  h += `<h2>What would help most</h2><div class="three">${fixPerf(L)}${fixCap()}${fixCorrect(L, t)}</div>`;
  body.innerHTML = h;
  body.querySelectorAll(".d[data-tip]").forEach(d => bindTip(d, d.dataset.tip));
  body.querySelectorAll(".hrow[data-id]").forEach(r => r.onclick = () => r.dataset.id !== ME && setMe(r.dataset.id));
}

// The chosen relay with the two ranked just above and below it, and what it takes to pass the next.
function rivals(title, ids, v, bar, show, toPass) {
  const list = ids.map(id => [id, v(id)]).filter(([, x]) => x != null).sort((a, b) => b[1] - a[1]);
  const k = list.findIndex(([id]) => id === ME);
  if (k < 0) return "";
  const win = list.slice(Math.max(0, k - 2), k + 3);
  const foot = k > 0 ? toPass(list[k - 1], list[k][1]) : list[1] ? `Top of the field. ${esc(nm(list[1][0]))} is next at ${show(list[1][1])}.` : "";
  return `<div class="card"><h3>${title}</h3><div class="sub">${ord(k + 1)} of ${list.length} · the nearest either side</div><div class="bars">` +
    win.map(([id, x]) => `<div class="hrow${id === ME ? " me" : ""}" data-id="${esc(id)}" style="--c:var(--l-${langOf(id)})"><span class="l">${esc(nm(id))}</span>${bar(x)}<span class="v">${show(x)}</span></div>`).join("") +
    `</div><p class="sub" style="color:var(--fg-2)">${foot}</p></div>`;
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
  for (const { t, a } of TESTS) {
    if (a.id === "sync") continue;
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
      return { t: `${esc(c.name)} <span class="muted">${cur}→${cur + 1}</span>`, g: `+${fmt(100 * c.weight / (3 * W), 1)}`,
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
  const cols = [["name", "Relay"], ["perf", "Performance"], ["correct", "Correctness"], ["cap", "Capability"], ["act", "Commits, 90d"], ["date", "Measured"]];
  const list = rows().sort((a, b) => {
    const x = a[sortK], y = b[sortK];
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * (sortK === "name" ? 1 : sortDir);
  });
  const t = $("#board");
  t.innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" ${k === sortK ? `aria-sort="${sortK === "name" ? "ascending" : sortDir < 0 ? "descending" : "ascending"}"` : ""} ${["correct", "act", "date"].includes(k) ? 'class="num"' : ""}>${l}</th>`).join("")}</tr></thead>` +
    `<tbody>${list.map(r => `<tr data-id="${esc(r.id)}" tabindex="0" class="${r.id === ME ? "me" : ""}" style="--c:var(--l-${langOf(r.id)})">
      <td><span class="rname"><span class="lang" style="background:var(--l-${langOf(r.id)})"></span>${esc(r.name)}</span><span class="rver">${esc(r.version || (r.L ? "" : inRun(r.id) ? "waiting for its first run" : "scored only, not benchmarked"))}</span></td>
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
  $("#perf-legend").innerHTML = AREAS.filter(a => a.overall).map(a => `<span><span class="sw sq" style="background:var(${a.c})"></span>${a.name}</span>`).join("") +
    `<span><span class="sw sq" style="background:var(--dot)"></span>outside the index</span><span><span class="dash"></span>strfry = 100</span>`;
  const el = $("#perf"); el.innerHTML = "";
  $("#perf-legend").hidden = !Object.keys(LATEST).length;
  if (!Object.keys(LATEST).length) { el.innerHTML = `<div class="card"><p class="muted">The first weekly run hasn't been published yet.</p></div>`; return; }
  for (const a of AREAS) {
    const list = Object.keys(LATEST).filter(id => perfOf(id)).map(id => ({ id, idx: perfOf(id).areas[a.id] }))
      .sort((x, y) => (y.idx.v ?? -1) - (x.idx.v ?? -1));
    const p = document.createElement("div");
    p.className = "card panel";
    if (a.c) p.style.setProperty("--c", `var(${a.c})`);
    p.innerHTML = `<div><h3><i></i>${a.name}</h3><div class="sub">${a.tests.length} test${a.tests.length > 1 ? "s" : ""}${AREA_NOTE[a.id] ? " · " + AREA_NOTE[a.id] : ""}</div></div>`;
    const bars = document.createElement("div"); bars.className = "bars" + (ME && list.some(x => x.id === ME) ? " picked" : "");
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

// --- tests -----------------------------------------------------------------------------------

let testSel = store.get("test", "latest_100");
function drawTests() {
  $("#tlist").innerHTML = AREAS.map(a => `<div class="grp" style="--c:var(${a.c || "--dot"})"><span class="label"><i></i>${a.name}${a.overall ? "" : " · outside the index"}</span>` +
    a.tests.map(t => `<button type="button" data-t="${t[0]}" aria-pressed="${t[0] === testSel}"><b>${esc(t[1])}</b><span>${esc(TEST_INFO[t[0]][0])}</span></button>`).join("") + `</div>`).join("");
  $("#tlist").querySelectorAll("button").forEach(b => b.onclick = () => { testSel = b.dataset.t; store.set("test", testSel); drawTests(); });
  const { t, a } = TESTS.find(x => x.t[0] === testSel) || TESTS[0];
  const [what, shape] = TEST_INFO[t[0]];
  const list = Object.keys(LATEST).filter(id => !LATEST[id].r.perf_skipped).map(id => ({ id, ...testValue(LATEST[id].r, t) }));
  const ok = list.filter(x => x.status === "ok" && x.v > 0).sort((x, y) => t[2] === "up" ? y.v - x.v : x.v - y.v);
  const rest = list.filter(x => !(x.status === "ok" && x.v > 0)).sort((x, y) => nm(x.id).localeCompare(nm(y.id)));
  const lo = Math.log10(Math.min(...ok.map(x => x.v))), hi = Math.log10(Math.max(...ok.map(x => x.v)));
  const span = Math.max(hi - lo, 0.5), from = lo - span * 0.15;
  const w = v => 100 * (Math.log10(v) - from) / (hi - from);
  const base = ok.find(x => x.id === BASE);
  let h = `<header><h2>${esc(t[1])}</h2><span class="sub">${a.name}</span></header>
    <p class="dim" style="font-size:.84rem">${esc(what)}</p>
    <dl class="kv"><dt>sends</dt><dd><code>${esc(shape)}</code></dd><dt>unit</dt><dd>${esc(t[3])}, ${t[2] === "up" ? "higher is better" : "lower is better"}</dd>
    ${FIELD[t[0]]?.medRaw ? `<dt>median</dt><dd>${fmt(FIELD[t[0]].medRaw)} ${esc(t[3])} across ${FIELD[t[0]].rows.length} relays</dd>` : ""}</dl>`;
  if (!list.length) h += `<p class="muted">No results yet.</p>`;
  else h += `<div class="bars${ME && ok.some(x => x.id === ME) ? " picked" : ""}" style="--c:var(${a.c || "--dot"})">` +
    ok.map(x => `<div class="hrow${x.id === ME ? " me" : ""}" data-id="${esc(x.id)}"><span class="l">${esc(nm(x.id))}</span><span class="track">${base ? `<span class="mark" style="left:${w(base.v)}%"></span>` : ""}<span class="fill" style="width:${w(x.v)}%"></span></span><span class="v">${fmt(x.v)}</span></div>`).join("") +
    rest.map(x => `<div class="hrow${x.id === ME ? " me" : ""}" data-id="${esc(x.id)}"><span class="l">${esc(nm(x.id))}</span><span class="why">${WHY[x.status] || x.status}</span></div>`).join("") + `</div>
    <div class="sub">log scale${base ? " · dashed line is strfry" : ""} · ${esc(t[3])}</div>`;
  $("#tcard").innerHTML = h;
  $("#tcard").querySelectorAll(".hrow[data-id]").forEach(r => r.onclick = () => openDetail(r.dataset.id));
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
      (r.evidence?.[c.id] ? `<br><span class="muted">${esc(r.evidence[c.id])}</span>` : `<br><span class="muted">${esc(c.why)}</span>`));
  });
}

// --- trend -----------------------------------------------------------------------------------

function drawTrend() {
  if (RUNS.length < 2) return;
  $("#trend-note").textContent = `${RUNS.length} weekly runs, ${RUNS[0].date} to ${RUNS.at(-1).date}. Each line is a relay's performance index; the dashed line is strfry.`;
  const el = $("#trend"); el.innerHTML = "";
  for (const id of Object.keys(LATEST).sort((a, b) => (b === ME) - (a === ME) || nm(a).localeCompare(nm(b)))) {
    const pts = RUNS.map((run, i) => run.relays[id] ? [i, perfAt(id, run)?.overall] : null).filter(p => p && p[1] != null);
    if (!pts.length) continue;
    const W = 220, H = 32, ys = pts.map(p => Math.log10(p[1]));
    const lo = Math.min(...ys, 2) - 0.05, hi = Math.max(...ys, 2) + 0.05;
    const X = i => (i / (RUNS.length - 1)) * W, Y = y => H - ((y - lo) / (hi - lo)) * H;
    const d = pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(Math.log10(p[1])).toFixed(1)}`).join("");
    const card = document.createElement("div"); card.className = "trend" + (id === ME ? " me" : "");
    card.innerHTML = `<div class="t"><span>${esc(nm(id))}</span><span>${fmt(pts.at(-1)[1])}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Performance index over ${pts.length} runs">
        <line x1="0" x2="${W}" y1="${Y(2)}" y2="${Y(2)}" stroke="var(--base)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <path d="${d}" fill="none" stroke="var(${id === ME ? "--sel" : `--l-${langOf(id)}`})" stroke-width="2" vector-effect="non-scaling-stroke"/>
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
  const draw = () => {
    const list = cat.filter(c => tier === "all" || (tier === "gap" ? gap(c) : c.tier === tier));
    $("#cat").innerHTML = `<thead><tr><th>Relay</th><th>Tier</th><th class="num">Commits, 90d</th><th>Language</th><th>Storage</th><th>What it is</th><th>Notes</th></tr></thead><tbody>` +
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
  if (id !== ME) h += `<p><button type="button" class="btn" id="d-pick">compare as ${esc(nm(id))}</button></p>`;
  h += `<dl class="kv">`;
  if (cat?.repo) h += `<dt>repository</dt><dd><a href="${esc(cat.repo)}" target="_blank" rel="noopener">${esc(cat.repo)}</a></dd>`;
  if (cat?.language) h += `<dt>language</dt><dd>${esc(cat.language)}${cat.storage ? ` · ${esc(cat.storage)}` : ""}</dd>`;
  if (L) {
    const r = L.r, act = r.activity?.commits_90d != null ? r.activity : ACT[id];
    h += `<dt>version</dt><dd>${esc(r.version)} <span class="muted">${esc((r.commit || "").slice(0, 12))}</span></dd>
      <dt>measured</dt><dd>${esc(L.run.date)}</dd>
      <dt>activity</dt><dd>${act?.commits_90d ?? "–"} commits in 90 days, last ${esc(act?.last_commit || "–")}</dd>
      <dt>NIP-11</dt><dd>${esc(r.nip11?.software || "")} ${esc(r.nip11?.version || "")}<br>supported_nips: ${esc(JSON.stringify(r.nip11?.supported_nips ?? null))}</dd>`;
    if (META.benched[id]?.notes) h += `<dt>setup</dt><dd>${esc(META.benched[id].notes)} <a href="${REPO}/tree/main/relays/${esc(id)}" target="_blank" rel="noopener">config</a></dd>`;
    if (r.footprint) h += `<dt>footprint</dt><dd>${fmt(r.footprint.rss_mb)} MB memory, ${fmt(r.footprint.disk_mb)} MB disk after the load</dd>`;
    if (r.error) h += `<dt>perf run</dt><dd><span class="badge bad">failed</span> ${esc(r.error)}</dd>`;
    if (r.error_default) h += `<dt>default run</dt><dd><span class="badge bad">failed</span> ${esc(r.error_default)}</dd>`;
  } else {
    h += `<dt>benchmark</dt><dd>${inRun(id) ? "In the weekly run; waiting for its first result" : "Not benchmarked (capability only)"}</dd>`;
    if (ACT[id]) h += `<dt>activity</dt><dd>${ACT[id].commits_90d ?? "–"} commits in 90 days, last ${esc(ACT[id].last_commit || "–")}</dd>`;
  }
  h += `</dl>`;
  if (L && L.r.perf_skipped) h += `<p>Not load-tested: its throughput is capped in code, so a load test would only measure the cap. Correctness is still checked weekly.</p>`;
  if (L && !L.r.perf_skipped) {
    const base = baseline(L.run);
    h += `<h3>Performance</h3><div class="scroll"><table><thead><tr><th>Test</th><th class="num">Result</th><th class="num">strfry</th><th class="num">Index</th></tr></thead><tbody>`;
    for (const a of AREAS) {
      h += `<tr><td colspan="4" style="color:var(--fg)">${a.name}</td></tr>`;
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
  if (b) b.onclick = () => { $("#detail").close(); setMe(id); setTab("relay", true); };
  $("#detail").showModal();
}

// --- method ----------------------------------------------------------------------------------

function drawMethod() {
  const run = RUNS.at(-1), s = run?.settings || {}, host = run?.host || {}, tools = run?.tools || {};
  $("#method-body").innerHTML = `
    <h3>What runs</h3>
    <p>Each relay is built from its newest release tag, or from the head of its default branch when it doesn't tag releases, with the Docker definition in <code>relays/&lt;id&gt;/</code>. It runs twice, each time on a fresh volume. The <b>perf profile</b> raises every per-client limit so the load generator, not a rate limiter, is what gets measured, and opens gift-wrap reads where the relay allows it. The <b>default profile</b> is the relay as shipped, and that is what relay-tester checks. Where a relay needs a change to accept load at all (a membership gate, say), its notes say so.</p>
    <h3>Load</h3>
    <p>${fmt(s.events || 1000000)} events from relay-bench's generator (seed ${s.seed ?? 1}): about 30% public events (kinds 0, 1, 7, 10050, 30023, 30078, replaceables, community traffic) and 70% NIP-17 gift wraps. Public events go in first and every public query runs before any gift wrap is loaded, so a relay that keeps gift wraps private is judged on everything else as normal. Each query workload is a pool of distinct queries drawn from the dataset with a fixed seed, so every relay faces the identical request stream and every answer is checked against what the dataset says it must be. The Tests tab lists each one.</p>
    <h3>Tools</h3>
    <p>relay-bench (VectorPrivacy/magnitude-relay) for load, queries, COUNT, negentropy, live fan-out and idle connections; nostr-bench (privkeyio) for one-event-at-a-time writes; relay-tester (mikedilger) for protocol conformance. Each is pinned to a commit in <code>tools/</code>${Object.keys(tools).length ? ` (images ${Object.entries(tools).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(", ")})` : ""}. relay-bench's live tests are patched to subscribe to public kinds instead of gift wraps, so a relay that keeps gift wraps private isn't marked as failing delivery; its Dockerfile says exactly what changed.</p>
    <h3>Machine</h3>
    <p>${esc(host.cpu || "–")}, ${host.threads ?? "–"} threads, kernel ${esc(host.kernel || "–")}, Docker ${esc(host.docker || "–")}. Every container of a relay's stack (its database too) is pinned to CPUs ${esc(host.relay_cpus || "–")}; the load tools run on ${esc(host.load_cpus || "–")}. One relay runs at a time. The machine is shared with other light work, so expect a few percent of noise from week to week; headlines only report moves over 10%.</p>
    <h3>Indexes</h3>
    <p>Each test's result is divided by strfry's on the same run (inverted where lower is better). An area is the geometric mean of its tests, and the performance index is the geometric mean of Writing, Reading, Live delivery and Connections. A test with wrong answers, refused events or no support is left out instead of counted, and the area says so. Capability is Σ weight × score over 3 × Σ weight, from <code>capability/</code>. Correctness is relay-tester's required checks passed.</p>
    <h3>Headlines</h3>
    <p>After each run, <code>bench/changes.py</code> compares it with the one before: new versions, relays added or missing, performance index moves over 10%, single tests moving over 50%, tests that flipped between right and wrong, required checks gained or lost, capability re-scores, and a change at the top. When strfry itself moves more than 10%, that comes first, since every index is relative to it. The same list goes out as a Nostr note, tagging the maintainers of the relays it names.</p>
    <h3>What would help most</h3>
    <p>Speed lists the tests where a relay is furthest below the median of every load-tested relay (each measured against strfry in its own run), after any test it answered wrongly or refused. Capability lists the criteria not yet at 3, heaviest first, with the points one step up is worth out of 100. Correctness lists the required relay-tester checks that fail.</p>
    <h3>Known limits</h3>
    <p>The dataset follows relay-bench's mix, which leans on gift wraps; that's why private messaging and negentropy sit outside the overall index. A relay that sends live events before they are fsynced will show lower fan-out latency than one that waits for the commit. For inbox reads and COUNT the bench AUTHs as the mailbox's recipient (NIP-42), with one connection per mailbox opened before the clock starts; other reads go out without AUTH, so AUTH-gated ones show as private or refused. Capability scores are judgement calls made from code and docs, with the evidence beside each one.</p>`;
}

// --- boot ------------------------------------------------------------------------------------

function draw() { drawTabs(); drawField(); drawNews(); drawYou(); drawBoard(); drawPerf(); drawTests(); drawCap(); drawTrend(); drawCatalog(); }

async function main() {
  const get = (u, d) => fetch(u).then(r => r.ok ? r.json() : d).catch(() => d);
  const [res, meta, act, news] = await Promise.all([get("data/results.json", { runs: [] }), fetch("data/meta.json").then(r => r.json()),
    get("data/activity.json", { relays: {} }), get("data/changes.json", { runs: [] })]);
  ACT = act.relays || {}; NEWS = news;
  RUNS = res.runs.sort((a, b) => a.date.localeCompare(b.date));
  META = meta; CAP = meta.capability; CRIT = CAP.criteria;
  for (const [id, c] of Object.entries(CAP.relays)) NAMES[id] = c.name;
  for (const run of RUNS) for (const [id, r] of Object.entries(run.relays)) {
    r.id = id; NAMES[id] = NAMES[id] || r.name;
    if (r.metrics && Object.keys(r.metrics).length || !LATEST[id]) LATEST[id] = { r, run };
  }
  buildField(); setScale();
  drawHead(); drawPicker(); drawMethod();
  seg($("#scope"), [["bench", "Benchmarked"], ["all", "All scored"]], scope, k => { scope = k; store.set("scope", k); drawBoard(); });
  const h = readHash();
  if (h.t) TAB = h.t;
  addEventListener("hashchange", () => { const x = readHash(); if (x.t) TAB = x.t; setMe(x.r); });
  setMe(h.r);
}
main().catch(e => { $("#statline").textContent = "Could not load the data: " + e.message; console.error(e); });
