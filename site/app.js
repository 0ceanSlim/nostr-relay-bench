"use strict";
// Everything on the page is computed here from data/results.json (the weekly runs) and
// data/meta.json (capability scores, catalog, relay definitions). Nothing is precomputed.

const BASE = "strfry";
// Areas of the performance index. dir: "up" = higher is better. get() pulls the value from a
// relay's result; the default is the test's throughput.
const AREAS = [
  { id: "write", name: "Writing", overall: true, tests: [
    ["ingest", "Bulk ingest, 8 pipelined connections", "up", "/s"],
    ["ingest_dup", "Duplicate resends", "up", "/s"],
    ["write_roundtrip", "One event at a time, waiting for each OK", "up", "/s"] ] },
  { id: "read", name: "Reading", overall: true, tests: [
    ["latest_1", "Newest event", "up", "q/s"], ["latest_100", "Newest 100", "up", "q/s"],
    ["latest_500", "Newest 500", "up", "q/s"], ["author", "By author", "up", "q/s"], ["kind", "By kind", "up", "q/s"],
    ["author_kind", "By author and kind", "up", "q/s"], ["tag", "By tag", "up", "q/s"],
    ["time_window", "Time window", "up", "q/s"], ["exact_id", "By id", "up", "q/s"],
    ["exact_ids_100", "100 ids at once", "up", "q/s"], ["miss", "No match", "up", "q/s"],
    ["multi_filter", "Several filters in one REQ", "up", "q/s"] ] },
  { id: "live", name: "Live delivery", overall: true, tests: [
    ["fanout", "1,000 subscribers, median delivery latency", "down", "ms", m => m.p50_us / 1000] ] },
  { id: "connections", name: "Connections", overall: true, tests: [
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
  footprint: "Not in the overall index: memory and disk trade against speed.",
  private: "Not in the overall index. Relays that keep gift wraps to their recipient (NIP-17) show “private by design”.",
  sync: "Not in the overall index: NIP-77 is a feature, scored under capability.",
};
const WHY = { unsupported: "not supported", refused: "refused by policy", wrong: "wrong answers",
              failed: "failed", missing: "not run", private: "private by design" };
const GROUPS = [["protocol", "Protocol"], ["policy", "Policy & moderation"], ["operations", "Operations"], ["ecosystem", "Ecosystem"]];
const TIERS = [["all", "All"], ["active", "Active"], ["slowing", "Slowing"], ["dormant", "Dormant"], ["missed", "Missed by the survey"], ["gap", "Committing, not benchmarked"]];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const geo = xs => xs.length ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : null;
const fmt = (v, d = 0) => v == null ? "–" : v >= 100 ? Math.round(v).toLocaleString("en") : v.toLocaleString("en", { maximumFractionDigits: d || (v < 10 ? 2 : 1) });
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let RUNS = [], META, CAP, CRIT, LATEST = {}, NAMES = {}, ACT = {};

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

function areaIndex(r, base, area) {
  const ratios = [], why = {};
  for (const t of area.tests) {
    const a = testValue(r, t), b = testValue(base, t);
    if (a.status === "ok" && b.status === "ok" && a.v > 0 && b.v > 0) ratios.push(t[2] === "up" ? a.v / b.v : b.v / a.v);
    else why[a.status] = (why[a.status] || 0) + 1;
  }
  const v = geo(ratios);
  const reason = Object.entries(why).sort((x, y) => y[1] - x[1])[0]?.[0];
  return { v: v == null ? null : 100 * v, n: ratios.length, of: area.tests.length, why: v == null ? reason : null,
           gaps: Object.entries(why).filter(([k]) => k !== "ok") };
}

function perf(r, run) {
  const base = baseline(run);
  if (!base) return null;
  const areas = Object.fromEntries(AREAS.map(a => [a.id, areaIndex(r, base, a)]));
  const parts = AREAS.filter(a => a.overall).map(a => areas[a.id].v).filter(v => v != null);
  return { overall: parts.length ? 100 * geo(parts.map(v => v / 100)) : null, parts: parts.length, areas };
}

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
// Log scale for indexes: 10 at the left edge, 1000 at the right, strfry's 100 in the middle.
const logPos = v => Math.max(0, Math.min(100, 50 + 25 * Math.log10(v / 100)));
function logBar(v) {
  return `<span class="track"><span class="mark" style="left:50%"></span><span class="fill" style="width:${logPos(v)}%"></span></span>`;
}
function linBar(v, max = 100) {
  return `<span class="track"><span class="fill" style="width:${100 * v / max}%"></span></span>`;
}
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

// --- scoreboard ------------------------------------------------------------------------------

let scope = store.get("scope", "bench"), sortK = store.get("sortK", "perf"), sortDir = -1;

function rows() {
  const ids = new Set([...Object.keys(LATEST), ...(scope === "all" ? Object.keys(CAP.relays) : [])]);
  return [...ids].map(id => {
    const L = LATEST[id];
    const p = L ? perf(L.r, L.run) : null;
    const t = L ? tester(L.r) : null;
    return { id, name: NAMES[id] || id, L, perf: p?.overall ?? null, perfParts: p?.parts ?? 0,
             correct: t?.pct ?? null, t, cap: capScore(id), act: L?.r.activity?.commits_90d ?? ACT[id]?.commits_90d ?? null,
             version: L?.r.version, date: L?.run.date };
  });
}

function drawBoard() {
  const cols = [["name", "Relay"], ["perf", "Performance"], ["correct", "Correctness"], ["cap", "Capability"], ["act", "Commits, 90 days"], ["date", "Measured"]];
  const list = rows().sort((a, b) => {
    const x = a[sortK], y = b[sortK];
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * (sortK === "name" ? 1 : sortDir);
  });
  const t = $("#board");
  t.innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" ${k === sortK ? `aria-sort="${sortK === "name" ? "ascending" : sortDir < 0 ? "descending" : "ascending"}"` : ""} ${["perf", "correct", "cap", "act"].includes(k) ? 'class="num"' : ""}>${l}</th>`).join("")}</tr></thead>` +
    `<tbody>${list.map(r => `<tr data-id="${esc(r.id)}" tabindex="0">
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
  t.querySelectorAll("tbody tr").forEach(tr => {
    tr.onclick = () => openDetail(tr.dataset.id);
    tr.onkeydown = e => { if (e.key === "Enter") openDetail(tr.dataset.id); };
  });
  t.querySelectorAll("tbody tr").forEach((tr, i) => {
    const r = list[i], td = tr.children[1];
    if (r.perf != null) bindTip(td, `<b>${esc(r.name)}</b>: ${fmt(r.perf)} (strfry = 100), from ${r.perfParts} of 4 areas`);
  });
}

// --- performance multiples -------------------------------------------------------------------

function drawPerf() {
  const el = $("#perf"); el.innerHTML = "";
  for (const a of AREAS) {
    const list = Object.entries(LATEST).filter(([, L]) => !L.r.perf_skipped).map(([id, L]) => {
      const base = baseline(L.run);
      return { id, idx: base ? areaIndex(L.r, base, a) : { v: null, why: "missing" } };
    }).sort((x, y) => (y.idx.v ?? -1) - (x.idx.v ?? -1));
    const p = document.createElement("div"); p.className = "panel";
    p.innerHTML = `<h3>${a.name}</h3><div class="sub">${a.tests.length} test${a.tests.length > 1 ? "s" : ""}${AREA_NOTE[a.id] ? " · " + AREA_NOTE[a.id] : ""}</div>`;
    for (const { id, idx } of list) {
      const row = document.createElement("div"); row.className = "hrow";
      row.innerHTML = `<span class="l">${esc(NAMES[id] || id)}</span>` +
        (idx.v != null ? `${logBar(idx.v)}<span class="v">${fmt(idx.v)}</span>` : `<span class="why">${WHY[idx.why] || "no data"}</span><span></span>`);
      bindTip(row, () => areaTip(id, a));
      row.onclick = () => openDetail(id);
      p.append(row);
    }
    el.append(p);
  }
}

function areaTip(id, a) {
  const L = LATEST[id], base = baseline(L.run);
  return `<b>${esc(NAMES[id] || id)}</b> · ${a.name}<br>` + a.tests.map(t => {
    const v = testValue(L.r, t), b = base ? testValue(base, t) : {};
    const ratio = v.status === "ok" && b.status === "ok" ? (t[2] === "up" ? v.v / b.v : b.v / v.v) : null;
    return `${esc(t[1])}: ${v.status === "ok" ? `${fmt(v.v)} ${t[3]}${ratio ? ` <span class="muted">(${fmt(100 * ratio)})</span>` : ""}` : `<span class="muted">${WHY[v.status] || v.status}</span>`}`;
  }).join("<br>");
}

// --- capability ------------------------------------------------------------------------------

function capIds() {
  return Object.keys(CAP.relays).sort((a, b) => capScore(b) - capScore(a));
}

function drawCap() {
  const el = $("#cap"); el.innerHTML = "";
  for (const [g, name] of GROUPS) {
    const crits = CRIT.filter(c => c.group === g);
    const list = capIds().map(id => [id, capScore(id, g)]).sort((a, b) => b[1] - a[1]);
    const p = document.createElement("div"); p.className = "panel";
    p.innerHTML = `<h3>${name}</h3><div class="sub">${crits.map(c => esc(c.name)).join(" · ")}</div>`;
    for (const [id, v] of list) {
      const row = document.createElement("div"); row.className = "hrow";
      row.innerHTML = `<span class="l">${esc(CAP.relays[id].name || id)}</span>${linBar(v)}<span class="v">${v}</span>`;
      bindTip(row, `<b>${esc(CAP.relays[id].name || id)}</b> · ${name}<br>` +
        crits.map(c => `${esc(c.name)}: ${CAP.relays[id].scores[c.id] ?? 0}/3`).join("<br>"));
      row.onclick = () => openDetail(id);
      p.append(row);
    }
    el.append(p);
  }
  const ids = capIds(), h = $("#heat");
  h.innerHTML = `<thead><tr><th></th>${ids.map(id => `<th scope="col"><span>${esc(CAP.relays[id].name || id)}</span></th>`).join("")}</tr></thead>` +
    `<tbody>${CRIT.map(c => `<tr><th scope="row">${esc(c.name)}<span class="w">×${c.weight}</span></th>${ids.map(id => {
      const s = CAP.relays[id].scores[c.id] ?? 0;
      return `<td class="s${s}" data-id="${esc(id)}" data-c="${c.id}">${s}</td>`;
    }).join("")}</tr>`).join("")}</tbody>` +
    `<tfoot><tr><th>Score / 100</th>${ids.map(id => `<td>${capScore(id)}</td>`).join("")}</tr></tfoot>`;
  h.querySelectorAll("td[data-c]").forEach(td => {
    const r = CAP.relays[td.dataset.id], c = CRIT.find(x => x.id === td.dataset.c);
    bindTip(td, `<b>${esc(r.name)}</b> · ${esc(c.name)}: ${td.textContent}/3` +
      (r.evidence?.[c.id] ? `<br><span class="muted">${esc(r.evidence[c.id])}</span>` : ""));
  });
}

// --- trend -----------------------------------------------------------------------------------

function drawTrend() {
  const dated = RUNS.map(run => run.date);
  $("#trend-note").textContent = RUNS.length < 2
    ? "One run so far. A line per relay appears here from the second weekly run: performance index (strfry = 100) and correctness."
    : `${RUNS.length} weekly runs, ${dated[0]} to ${dated.at(-1)}. Lines are the performance index (strfry = 100); the number is the latest.`;
  const el = $("#trend"); el.innerHTML = "";
  if (RUNS.length < 2) return;
  for (const id of Object.keys(LATEST).sort()) {
    const pts = RUNS.map((run, i) => run.relays[id] ? [i, perf({ ...run.relays[id], id }, run)?.overall] : null).filter(p => p && p[1] != null);
    if (!pts.length) continue;
    const W = 220, H = 34, ys = pts.map(p => Math.log10(p[1]));
    const lo = Math.min(...ys, 2) - 0.05, hi = Math.max(...ys, 2) + 0.05;
    const X = i => (RUNS.length < 2 ? W : (i / (RUNS.length - 1)) * W), Y = y => H - ((y - lo) / (hi - lo)) * H;
    const d = pts.map((p, k) => `${k ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(Math.log10(p[1])).toFixed(1)}`).join("");
    const card = document.createElement("div"); card.className = "trend";
    card.innerHTML = `<div class="t"><span>${esc(NAMES[id] || id)}</span><span class="num">${fmt(pts.at(-1)[1])}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Performance index over ${pts.length} runs">
        <line x1="0" x2="${W}" y1="${Y(2)}" y2="${Y(2)}" stroke="var(--base)" stroke-dasharray="3 3" stroke-width="1"/>
        <path d="${d}" fill="none" stroke="var(--bar)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      </svg><span class="k">dashed line = strfry</span>`;
    card.onclick = () => openDetail(id);
    el.append(card);
  }
}

// --- catalog ---------------------------------------------------------------------------------

function drawCatalog() {
  const cat = META.catalog;
  const act = c => ACT[c.id || c.name];
  const gap = c => act(c)?.commits_90d > 0 && !(c.id && META.benched[c.id]);
  const counts = { all: cat.length, gap: cat.filter(gap).length };
  for (const c of cat) counts[c.tier] = (counts[c.tier] || 0) + 1;
  $("#cat-count").textContent = `(${cat.length})`;
  let tier = store.get("tier", "all");
  const draw = () => {
    const list = cat.filter(c => tier === "all" || (tier === "gap" ? gap(c) : c.tier === tier));
    $("#cat").innerHTML = `<thead><tr><th>Relay</th><th>Tier</th><th class="num">Commits, 90 days</th><th>Language</th><th>Storage</th><th>What it is</th><th>Notes</th></tr></thead><tbody>` +
      list.map(c => `<tr><td>${c.repo ? `<a href="${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)}
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
  const name = NAMES[id] || cap?.name || id;
  let h = `<h2 id="d-title">${esc(name)}</h2>`;
  if (cap?.summary) h += `<p class="note">${esc(cap.summary)}</p>`;
  h += `<dl class="kv">`;
  if (cat?.repo) h += `<dt>Repository</dt><dd><a href="${esc(cat.repo)}" target="_blank" rel="noopener">${esc(cat.repo)}</a></dd>`;
  if (L) {
    const r = L.r, act = r.activity?.commits_90d != null ? r.activity : ACT[id];
    h += `<dt>Version</dt><dd>${esc(r.version)} <span class="muted">${esc((r.commit || "").slice(0, 12))}</span></dd>
      <dt>Measured</dt><dd>${esc(L.run.date)}</dd>
      <dt>Activity</dt><dd>${act?.commits_90d ?? "–"} commits in 90 days, last ${esc(act?.last_commit || "–")}</dd>
      <dt>NIP-11</dt><dd>${esc(r.nip11?.software || "")} ${esc(r.nip11?.version || "")}<br>supported_nips: ${esc(JSON.stringify(r.nip11?.supported_nips ?? null))}</dd>`;
    if (META.benched[id]?.notes) h += `<dt>Setup</dt><dd>${esc(META.benched[id].notes)} <a href="https://github.com/0ceanSlim/nostr-relay-bench/tree/main/relays/${esc(id)}" target="_blank" rel="noopener">config</a></dd>`;
    if (r.footprint) h += `<dt>Footprint</dt><dd>${fmt(r.footprint.rss_mb)} MB memory, ${fmt(r.footprint.disk_mb)} MB disk after the load</dd>`;
    if (r.error) h += `<dt>Perf run</dt><dd><span class="badge bad">failed</span> ${esc(r.error)}</dd>`;
    if (r.error_default) h += `<dt>Default run</dt><dd><span class="badge bad">failed</span> ${esc(r.error_default)}</dd>`;
  } else {
    h += `<dt>Benchmark</dt><dd>Not benchmarked (capability only)</dd>`;
    if (ACT[id]) h += `<dt>Activity</dt><dd>${ACT[id].commits_90d ?? "–"} commits in 90 days, last ${esc(ACT[id].last_commit || "–")}</dd>`;
  }
  h += `</dl>`;
  if (L && L.r.perf_skipped) h += `<p class="note">Not load-tested: its throughput is capped in code, so a load test would only measure the cap. Correctness is still checked weekly.</p>`;
  if (L && !L.r.perf_skipped) {
    const base = baseline(L.run);
    h += `<h3>Performance</h3><div class="scroll"><table><thead><tr><th>Test</th><th class="num">Result</th><th class="num">strfry</th><th class="num">Index</th></tr></thead><tbody>`;
    for (const a of AREAS) {
      h += `<tr><td colspan="4"><b>${a.name}</b></td></tr>`;
      for (const t of a.tests) {
        const v = testValue(L.r, t), b = base ? testValue(base, t) : {};
        const ratio = v.status === "ok" && b.status === "ok" ? (t[2] === "up" ? v.v / b.v : b.v / v.v) : null;
        const badge = v.status === "ok" ? "" : `<span class="badge ${v.status === "private" ? "good" : v.status === "unsupported" || v.status === "missing" ? "dim" : "bad"}">${WHY[v.status] || v.status}</span>`;
        h += `<tr><td>${esc(t[1])}</td><td class="num">${v.status === "ok" ? `${fmt(v.v)} ${t[3]}` : badge}</td>
          <td class="num muted">${b.status === "ok" ? `${fmt(b.v)} ${t[3]}` : "–"}</td><td class="num">${ratio ? fmt(100 * ratio) : "–"}</td></tr>`;
      }
    }
    h += `</tbody></table></div>`;
  }
  const t = L && tester(L.r);
  if (t) h += `<h3 style="margin-top:16px">Correctness</h3><p class="note">${t.required_pass} of ${t.required_total} required relay-tester checks and ${t.optional_pass} of ${t.optional_total} optional ones pass with the relay as shipped.` +
    (t.failed.length ? ` Failed: ${t.failed.map(esc).join("; ")}.` : "") + `</p>`;
  if (cap) {
    h += `<h3 style="margin-top:16px">Capability: ${capScore(id)} / 100</h3><div class="scroll"><table><thead><tr><th>Criterion</th><th class="num">Score</th><th>Evidence</th></tr></thead><tbody>` +
      CRIT.map(c => `<tr><td>${esc(c.name)} <span class="muted">×${c.weight}</span></td><td class="num">${cap.scores[c.id] ?? 0}/3</td><td>${esc(cap.evidence?.[c.id] || "")}</td></tr>`).join("") +
      `</tbody></table></div><p class="note">Scored ${esc(cap.scored)}. Disagree? Edit <code>capability/relays/${esc(id)}.toml</code> and send a PR.</p>`;
  }
  $("#d-body").innerHTML = h;
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
    <h3>Known limits</h3>
    <p>The dataset follows relay-bench's mix, which leans on gift wraps. That is why private messaging and negentropy sit outside the overall index. A relay that sends live events before they are fsynced will show lower fan-out latency than one that waits for the commit. relay-bench never AUTHs, so AUTH-gated reads show as private or refused.</p>`;
}

// --- boot ------------------------------------------------------------------------------------

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
  const last = RUNS.at(-1);
  $("#runline").textContent = last
    ? `Latest run ${last.date} · ${Object.keys(last.relays).length} relays benchmarked · ${Object.keys(CAP.relays).length} scored · ${META.catalog.length} cataloged`
    : `No runs yet · ${Object.keys(CAP.relays).length} relays scored · ${META.catalog.length} cataloged`;
  seg($("#scope"), [["bench", "Benchmarked"], ["all", "All scored"]], scope, k => { scope = k; store.set("scope", k); drawBoard(); });
  drawBoard(); drawPerf(); drawCap(); drawTrend(); drawCatalog(); drawMethod();
}
main().catch(e => { $("#runline").textContent = "Could not load the data: " + e.message; });
