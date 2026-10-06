// The usage dashboard (decisions 0020 and 0021): the numbers and the page, from the usage events
// Studio sends. Shared by the live page (analytics.csharness.com, this folder) and the command-line
// report (scripts/usage-report.mjs). Pure: no network, no files. Every value shown is escaped.
// The steps of a diagnosis, in order: a run counts at a step when it did any of its names.
export const FUNNEL = [
  ['Opened Diagnoses', ['manual']],
  ['Started a new diagnosis', ['manual-new']],
  ['Worked in the diagnosis editor', ['manual/editor']],
  ['Saved a diagnosis', ['manual-save', 'form:manual-save']],
  ['Finalized a diagnosis', ['manual-finalize']],
  ['Saved the customer PDF', ['manual-pdf', 'manual-save-pdf']]
];

const sum = values => values.reduce((a, b) => a + b, 0);
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const group = (items, key) => { const map = new Map(); for (const item of items) { const k = key(item); if (!map.has(k)) map.set(k, []); map.get(k).push(item); } return map; };

// The numbers behind the dashboard. `events` are rows of usage_events; `emails` maps account ids to
// emails; `labels` maps location account ids to names (for example Escondido).
export function buildUsageReport(events, {emails = {}, labels = {}, catalog = {screens: [], actions: []}, tz = 'America/Los_Angeles', now = Date.now(), days = 30} = {}) {
  const who = id => emails[id] || (id ? `${String(id).slice(0, 8)}…` : '—');
  const place = e => e.location_id || e.account_id;
  const placeName = id => labels[id] || who(id);
  const screens = events.filter(e => e.kind === 'screen');
  const actions = events.filter(e => e.kind === 'action');
  const errors = events.filter(e => e.kind === 'error');
  const hours = list => sum(list.map(e => e.duration_ms || 0)) / 3600000;
  const last = list => list.reduce((m, e) => (e.at > m ? e.at : m), '');
  const local = iso => new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short'})
    .formatToParts(new Date(iso)).reduce((o, p) => ({...o, [p.type]: p.value}), {});

  const sessions = group(events, e => e.session);
  const runLength = [...sessions.values()].map(list => sum(list.filter(e => e.kind === 'screen').map(e => e.duration_ms || 0)));

  const perPlace = [...group(events, place)].map(([id, list]) => {
    const top = [...group(list.filter(e => e.kind === 'screen'), e => e.name)].map(([name, l]) => [name, hours(l)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return {id, name: placeName(id), runs: new Set(list.map(e => e.session)).size, hours: hours(list.filter(e => e.kind === 'screen')),
      days: new Set(list.map(e => `${local(e.at).year}-${local(e.at).month}-${local(e.at).day}`)).size, logins: [...new Set(list.map(e => who(e.account_id)))],
      finalized: list.filter(e => e.name === 'manual-finalize').length, pdfs: list.filter(e => ['manual-pdf', 'manual-save-pdf', 'manual-internal-pdf'].includes(e.name)).length,
      errors: list.filter(e => e.kind === 'error').length, last: last(list), top};
  }).sort((a, b) => b.hours - a.hours);

  const perLogin = [...group(events, e => e.account_id)].map(([id, list]) => {
    const newest = list.reduce((m, e) => (e.at > m.at ? e : m), list[0]);
    return {email: who(id), runs: new Set(list.map(e => e.session)).size, hours: hours(list.filter(e => e.kind === 'screen')), last: newest.at,
      version: newest.app_version || '—', platform: newest.platform || '—', edition: newest.edition || '—',
      locations: [...new Set(list.map(e => placeName(place(e))))]};
  }).sort((a, b) => b.hours - a.hours);

  const totalScreenHours = hours(screens) || 1;
  const screenRows = [...group(screens, e => e.name)].map(([name, list]) => ({name, visits: list.length, hours: hours(list),
    share: hours(list) / totalScreenHours, avg: median(list.map(e => e.duration_ms || 0)) / 1000,
    places: new Set(list.map(place)).size, logins: new Set(list.map(e => e.account_id)).size, last: last(list)})).sort((a, b) => b.hours - a.hours);
  const actionRows = [...group(actions, e => e.name)].map(([name, list]) => ({name, uses: list.length, runs: new Set(list.map(e => e.session)).size,
    places: new Set(list.map(place)).size, logins: new Set(list.map(e => e.account_id)).size, last: last(list)})).sort((a, b) => b.uses - a.uses);

  const usedScreens = new Set(screenRows.map(r => r.name)), usedActions = new Set(actionRows.map(r => r.name));
  const unused = {screens: catalog.screens.filter(n => !usedScreens.has(n)), actions: catalog.actions.filter(n => !usedActions.has(n))};
  const rare = actionRows.filter(r => r.uses < 3 || r.places === 1).map(r => r.name);
  const uncatalogued = [...usedActions].filter(n => catalog.actions.length && !catalog.actions.includes(n) && !n.startsWith('nav:')).sort();

  const daily = [];
  for (let d = days - 1; d >= 0; d--) {
    const parts = local(new Date(now - d * 86400000).toISOString());
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    const list = events.filter(e => { const p = local(e.at); return `${p.year}-${p.month}-${p.day}` === key; });
    daily.push({day: key, runs: new Set(list.map(e => e.session)).size, hours: hours(list.filter(e => e.kind === 'screen')),
      actions: list.filter(e => e.kind === 'action').length, errors: list.filter(e => e.kind === 'error').length});
  }
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const heat = WEEK.map(() => Array(24).fill(0));
  for (const e of actions.concat(screens)) { const p = local(e.at); const w = WEEK.indexOf(p.weekday); if (w >= 0) heat[w][Number(p.hour) % 24]++; }

  const funnel = FUNNEL.map(([label, names]) => ({label, runs: [...sessions.values()].filter(list => list.some(e => names.includes(e.name))).length}));
  // Where errors happened: the screen open in the same run at that moment.
  const errorScreens = [...group(errors, e => {
    const open = (sessions.get(e.session) ?? []).find(s => s.kind === 'screen' && s.at <= e.at && Date.parse(s.at) + (s.duration_ms || 0) >= Date.parse(e.at));
    return open?.name ?? 'unknown';
  })].map(([name, list]) => ({name, errors: list.length})).sort((a, b) => b.errors - a.errors);
  const versions = [...group(perLogin, l => `${l.version} · ${l.platform}`)].map(([name, list]) => ({name, logins: list.length})).sort((a, b) => b.logins - a.logins);

  return {
    period: {days, tz, from: daily[0]?.day, to: daily.at(-1)?.day, generated: new Date(now).toISOString()},
    totals: {events: events.length, runs: sessions.size, places: perPlace.length, logins: perLogin.length, hours: hours(screens),
      finalized: actions.filter(e => e.name === 'manual-finalize').length, pdfs: actions.filter(e => ['manual-pdf', 'manual-save-pdf'].includes(e.name)).length,
      errors: errors.length, medianRunMinutes: median(runLength) / 60000, first: events.reduce((m, e) => (!m || e.at < m ? e.at : m), ''), last: last(events)},
    places: perPlace, logins: perLogin, screens: screenRows, actions: actionRows, unused, rare, uncatalogued, daily, heat, week: WEEK, funnel, errorScreens, versions
  };
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const n = (value, digits = 0) => Number(value || 0).toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits});
const when = iso => (iso ? new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '—');
const bar = share => `<span class="bar"><i style="width:${Math.min(100, Math.max(1, Math.round(share * 100)))}%"></i></span>`;
const table = (head, rows, empty = 'Nothing yet in this period.') => rows.length
  ? `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<p class="muted">${empty}</p>`;

export const REPORT_CSS = `:root{--bg:#f6f7f9;--panel:#fff;--ink:#16202a;--muted:#5d6b78;--line:#e1e6eb;--accent:#0a7cc1;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#151b23;--ink:#e6edf3;--muted:#8b98a5;--line:#26303b;--accent:#3fa7ff;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 60px}h1{margin:0 0 4px;font-size:24px}h2{margin:0 0 10px;font-size:16px}
.muted{color:var(--muted)}section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:0 14px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600}td:first-child{white-space:normal}code{font:12px Consolas,monospace}
.bar{display:inline-block;width:90px;height:8px;background:var(--line);border-radius:4px;vertical-align:middle}.bar i{display:block;height:100%;background:var(--accent);border-radius:4px}
svg{width:100%;height:auto}svg rect{fill:var(--accent)}svg text{fill:var(--muted);font-size:10px}
.heat{display:grid;grid-template-columns:30px repeat(24,minmax(0,1fr));gap:1px;font-size:10px;color:var(--muted)}.heat .hh{overflow:visible;white-space:nowrap}.heat .cell{background:var(--accent);border-radius:2px;aspect-ratio:1}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips code{border:1px solid var(--line);border-radius:6px;padding:2px 6px}.warn{color:var(--warn)}
.funnel div{display:grid;grid-template-columns:minmax(150px,240px) 1fr 60px;gap:10px;align-items:center;margin:6px 0}.funnel .bar{width:100%}
`;

// The dashboard's sections, as HTML for a <main> element.
export function usageReportBody(r) {
  const t = r.totals;
  const maxDay = Math.max(0.01, ...r.daily.map(d => d.hours));
  const W = 720, H = 140, bw = W / Math.max(1, r.daily.length);
  const chart = `<svg viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Hours in Studio per day">${r.daily.map((d, i) => {
    const h = d.hours / maxDay * H;
    return `<rect x="${i * bw + 1}" y="${H - h}" width="${bw - 2}" height="${h}" rx="2"><title>${esc(d.day)}: ${n(d.hours, 1)} h, ${d.runs} runs, ${d.actions} actions${d.errors ? `, ${d.errors} errors` : ''}</title></rect>`
      + (i % 7 === 0 ? `<text x="${i * bw}" y="${H + 14}">${esc(d.day.slice(5))}</text>` : '');
  }).join('')}</svg>`;
  const maxHeat = Math.max(1, ...r.heat.flat());
  const heat = `<div class="heat"><span></span>${Array.from({length: 24}, (_, h) => `<span class="hh">${h % 3 === 0 ? h : ''}</span>`).join('')}${r.heat.map((row, w) =>
    `<span class="hd">${r.week[w]}</span>${row.map((v, h) => `<span class="cell" style="opacity:${v ? 0.15 + 0.85 * v / maxHeat : 0.06}" title="${r.week[w]} ${h}:00 · ${v} events"></span>`).join('')}`).join('')}</div>`;
  const top = Math.max(1, ...r.funnel.map(f => f.runs)); // a later step can have more runs (a diagnosis opened from a work order)
  const tiles = [['Studio runs', n(t.runs)], ['Locations active', n(t.places)], ['Logins active', n(t.logins)], ['Hours in Studio', n(t.hours, 1)],
    ['Median run', `${n(t.medianRunMinutes, 1)} min`], ['Diagnoses finalized', n(t.finalized)], ['Customer PDFs', n(t.pdfs)], ['Errors', n(t.errors)]];
  return `<h1>EVCore Studio usage</h1><p class="muted">${esc(r.period.from)} to ${esc(r.period.to)} (${r.period.days} days, times in ${esc(r.period.tz)}) · ${n(t.events)} events · generated ${esc(when(r.period.generated))}</p>
<div class="tiles">${tiles.map(([label, value]) => `<div class="tile"><b>${value}</b><span>${label}</span></div>`).join('')}</div>
<section><h2>Every day</h2><p class="muted">Hours with Studio open on a screen. Hover a bar for runs, actions and errors.</p>${chart}</section>
<section><h2>Locations</h2>${table(['Location', 'Runs', 'Hours', 'Days used', 'Finalized', 'PDFs', 'Errors', 'Most time on', 'Logins', 'Last seen'],
    r.places.map(p => [esc(p.name), n(p.runs), n(p.hours, 1), n(p.days), n(p.finalized), n(p.pdfs), p.errors ? `<span class="warn">${n(p.errors)}</span>` : '0',
      esc(p.top.map(([s, h]) => `${s} (${n(h, 1)} h)`).join(', ')), esc(p.logins.join(', ')), esc(when(p.last))]))}</section>
<section><h2>Logins</h2>${table(['Login', 'Runs', 'Hours', 'Locations', 'Version', 'Platform', 'Edition', 'Last seen'],
    r.logins.map(l => [esc(l.email), n(l.runs), n(l.hours, 1), esc(l.locations.join(', ')), esc(l.version), esc(l.platform), esc(l.edition), esc(when(l.last))]))}</section>
<div class="grid">
<section><h2>When shops work</h2><p class="muted">Screens and actions by weekday and hour.</p>${heat}</section>
<section><h2>Diagnosis funnel</h2><p class="muted">Studio runs that reached each step.</p><div class="funnel">${r.funnel.map(f =>
    `<div><span>${esc(f.label)}</span>${bar(f.runs / top)}<b>${n(f.runs)}</b></div>`).join('')}</div></section>
</div>
<section><h2>Screens, by time spent</h2>${table(['Screen', 'Share of time', 'Hours', 'Visits', 'Median visit', 'Locations', 'Logins', 'Last seen'],
    r.screens.map(s => [`<code>${esc(s.name)}</code>`, `${bar(s.share)} ${n(s.share * 100)}%`, n(s.hours, 2), n(s.visits), `${n(s.avg)} s`, n(s.places), n(s.logins), esc(when(s.last))]))}</section>
<section><h2>Features, by use</h2>${table(['Feature', 'Uses', 'In runs', 'Locations', 'Logins', 'Last used'],
    r.actions.map(a => [`<code>${esc(a.name)}</code>`, n(a.uses), n(a.runs), n(a.places), n(a.logins), esc(when(a.last))]))}</section>
<section><h2>Never used in this period</h2><p class="muted">Everything Studio offers that nobody opened or pressed. Candidates to simplify, explain or remove.</p>
  <h3>Screens (${r.unused.screens.length})</h3><div class="chips">${r.unused.screens.map(s => `<code>${esc(s)}</code>`).join('') || '<span class="muted">Every screen was used.</span>'}</div>
  <h3>Features (${r.unused.actions.length})</h3><div class="chips">${r.unused.actions.map(s => `<code>${esc(s)}</code>`).join('') || '<span class="muted">Every feature was used.</span>'}</div></section>
<div class="grid">
<section><h2>Rarely used</h2><p class="muted">Used fewer than 3 times, or at one location only.</p><div class="chips">${r.rare.map(s => `<code>${esc(s)}</code>`).join('') || '<span class="muted">None.</span>'}</div></section>
<section><h2>Errors, by screen</h2>${table(['Screen', 'Errors'], r.errorScreens.map(e => [`<code>${esc(e.name)}</code>`, n(e.errors)]), 'No errors in this period.')}
  <h2>Versions in use</h2>${table(['Version · platform', 'Logins'], r.versions.map(v => [esc(v.name), n(v.logins)]))}</section>
</div>
${r.uncatalogued.length ? `<section><h2>Used but not in this Studio's code</h2><p class="muted">From another Studio version.</p><div class="chips">${r.uncatalogued.map(s => `<code>${esc(s)}</code>`).join('')}</div></section>` : ''}
<p class="muted">Studio sends screen and feature names with times only: no customers, vehicles, diagnoses, reports, photos or typed text (decision 0020).</p>
`;
}
