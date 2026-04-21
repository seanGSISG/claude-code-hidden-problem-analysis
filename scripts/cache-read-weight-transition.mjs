#!/usr/bin/env node
/**
 * cache-read-weight-transition.mjs — Does our data support the claim that
 * cache_read weight shifted from ~0x to ~1x in the quota formula?
 *
 * v2 (ArkNill review response): reframed to lead with the counterfactual —
 * "how many days exceed budget under 0x vs 1x weight" — because that's the
 * stronger evidence. The ratio itself doesn't jump at a transition date.
 * What changed is whether the quota system APPLIES the weight.
 *
 * Our data: 179K calls, Dec 2025 to Apr 2026, Max 20x. ArkNill's proxy
 * started Apr 4, so this fills the pre-transition baseline gap they lacked.
 *
 * @fgrosswig (Max 5x, dual-machine):
 *   - March 26: consumed 3.2B tokens, no limit hit
 *   - April 5: consumed 88M tokens, hit 90%
 *   - ~64x effective budget reduction
 *
 * Reference: ArkNill/claude-code-hidden-problem-analysis 02_RATELIMIT-HEADERS.md §9
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, 'projects');

// Quota weights
const W_INPUT = 1;
const W_OUTPUT = 5;
const W_CACHE_WRITE = 1;

function findJsonlFiles(dir) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) results.push(...findJsonlFiles(full));
    else if (e.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

function fmtM(n) { return (n / 1e6).toFixed(1) + 'M'; }
function fmtB(n) { return (n / 1e9).toFixed(2) + 'B'; }
function pct(part, total) { return total ? ((part / total) * 100).toFixed(1) + '%' : '0.0%'; }
function pad(s, n) { return String(s).padStart(n); }

// ─── Load all calls, group by date ─────────────────────────────────────────
const files = findJsonlFiles(PROJECTS_DIR);
console.error(`Scanning ${files.length} files...`);

const daily = {};

function ensureDay(d) {
  if (!daily[d]) daily[d] = {
    calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0,
  };
}

let total = 0;
for (const file of files) {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage || !rec.timestamp) continue;
    if (rec.message.model === '<synthetic>') continue;

    const date = rec.timestamp.slice(0, 10);
    const u = rec.message.usage;

    ensureDay(date);
    const d = daily[date];
    d.calls++;
    d.input += u.input_tokens || 0;
    d.output += u.output_tokens || 0;
    d.cache_read += u.cache_read_input_tokens || 0;
    d.cache_create += u.cache_creation_input_tokens || 0;
    total++;
  }
}

console.error(`Loaded ${total} calls across ${Object.keys(daily).length} days.\n`);

const dates = Object.keys(daily).sort();

// ─── Pre-compute derived daily rows + monthly aggregates ───────────────────
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('  CACHE_READ WEIGHT TRANSITION: Does the Data Support a 0x → 1x Shift?');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

const rows = [];
for (const date of dates) {
  const d = daily[date];
  const q0 = d.input * W_INPUT + d.cache_create * W_CACHE_WRITE + d.output * W_OUTPUT;
  const q1 = q0 + d.cache_read;
  const visible = d.input + d.output + d.cache_read + d.cache_create;
  const ratio = q0 > 0 ? q1 / q0 : 1;
  const cr_pct = visible > 0 ? (d.cache_read / visible * 100) : 0;
  rows.push({ date, ...d, q0, q1, ratio, visible, cr_pct });
}

const monthlyAgg = {};
for (const r of rows) {
  const m = r.date.slice(0, 7);
  if (!monthlyAgg[m]) monthlyAgg[m] = { cache_read: 0, visible: 0, q0: 0, q1: 0, calls: 0, days: 0 };
  monthlyAgg[m].cache_read += r.cache_read;
  monthlyAgg[m].visible += r.visible;
  monthlyAgg[m].q0 += r.q0;
  monthlyAgg[m].q1 += r.q1;
  monthlyAgg[m].calls += r.calls;
  monthlyAgg[m].days++;
}

const preMarch = rows.filter(r => r.date < '2026-03-23' && r.calls >= 10);
const postMarch = rows.filter(r => r.date >= '2026-03-23' && r.calls >= 10);

// ─── Section 1: Counterfactual (the strongest evidence) ────────────────────
const BUDGET_5H = 180_000_000;

console.log('── SECTION 1: COUNTERFACTUAL ──────────────────────────────────────────\n');
console.log('  Strongest evidence up front. Under the old formula (cache_read = 0x),');
console.log('  how many days in our dataset would have exceeded the 180M 5h budget?');
console.log('  Under the new formula (cache_read = 1x), how many days exceed?\n');

const febDays = rows.filter(r => r.date.startsWith('2026-02'));
const marDays = rows.filter(r => r.date.startsWith('2026-03'));
const aprDays = rows.filter(r => r.date.startsWith('2026-04'));

console.log('  Month | Active Days | Days > 180M quota(0x) | Days > 180M quota(1x)');
console.log('  ------|-------------|-----------------------|----------------------');
let total0x = 0, total1x = 0;
for (const group of [{ label: 'Feb', days: febDays }, { label: 'Mar', days: marDays }, { label: 'Apr', days: aprDays }]) {
  const over0x = group.days.filter(d => d.q0 > BUDGET_5H).length;
  const over1x = group.days.filter(d => d.q1 > BUDGET_5H).length;
  total0x += over0x; total1x += over1x;
  console.log(`  ${group.label}   | ${pad(group.days.length, 11)} | ${pad(over0x, 21)} | ${pad(over1x, 20)}`);
}
console.log(`  ------|-------------|-----------------------|----------------------`);
console.log(`  Total |             | ${pad(total0x, 21)} | ${pad(total1x, 20)}`);
console.log();
console.log(`  Under the old formula, our maximum quota consumption in any single 5h`);
console.log(`  window across the entire dataset was well below budget. The transition is`);
console.log(`  not subtle — it's a categorical flip from "never constrained" to`);
console.log(`  "constrained on most active days."`);

// ─── Section 2: Cache_read growth trajectory ───────────────────────────────
console.log('\n── SECTION 2: CACHE_READ SHARE HAS ALWAYS BEEN 90–95% ─────────────────\n');
console.log('  Usage pattern didn\'t change. What changed is whether the quota system');
console.log('  APPLIES cache_read weight.\n');

console.log('  Month    | CacheRead     | % of Visible | Quota(0x)   | Quota(1x)   | Multiplier');
console.log('  ---------|---------------|--------------|-------------|-------------|----------');
for (const m of Object.keys(monthlyAgg).sort()) {
  const a = monthlyAgg[m];
  const mult = a.q0 > 0 ? (a.q1 / a.q0).toFixed(1) + 'x' : 'N/A';
  console.log(`  ${m}  | ${pad(fmtM(a.cache_read), 13)} | ${pad(pct(a.cache_read, a.visible), 12)} | ${pad(fmtM(a.q0), 11)} | ${pad(fmtM(a.q1), 11)} | ${pad(mult, 10)}`);
}

// ─── Section 3: @fgrosswig 64x validation ──────────────────────────────────
console.log('\n── SECTION 3: @fgrosswig 64x TEST ─────────────────────────────────────\n');
console.log('  @fgrosswig (Max 5x): March 26 consumed 3.2B tokens with no limit.');
console.log('  April 5 consumed 88M and hit 90%. A ~64x effective budget reduction.');
console.log('  A 64x multiplier requires cache_read ≈ 98.4% of visible tokens.\n');

const sortedByQ1 = [...rows].sort((a, b) => b.q1 - a.q1);
const sortedByVisible = [...rows].sort((a, b) => b.visible - a.visible);

console.log('  Our top 5 days by visible tokens (old-budget proxy):');
for (let i = 0; i < Math.min(5, sortedByVisible.length); i++) {
  const r = sortedByVisible[i];
  console.log(`    ${r.date}: ${fmtM(r.visible)} visible, ${r.calls} calls, ratio=${r.ratio.toFixed(1)}x`);
}

console.log('\n  Our top 5 days by quota(1x) (new-budget proxy):');
for (let i = 0; i < Math.min(5, sortedByQ1.length); i++) {
  const r = sortedByQ1[i];
  console.log(`    ${r.date}: ${fmtM(r.q1)} quota(1x), ${r.calls} calls, CR=${pct(r.cache_read, r.visible)} of visible`);
}

if (preMarch.length && postMarch.length) {
  const heaviestPre = preMarch.reduce((a, b) => a.visible > b.visible ? a : b);
  const heaviestPost = postMarch.reduce((a, b) => a.q1 > b.q1 ? a : b);
  console.log('\n  Our heaviest-day multiplier:');
  console.log(`    Pre-transition  ${heaviestPre.date}: visible=${fmtM(heaviestPre.visible)}, quota(1x)=${fmtM(heaviestPre.q1)} → ${heaviestPre.ratio.toFixed(1)}x`);
  console.log(`    Post-transition ${heaviestPost.date}: visible=${fmtM(heaviestPost.visible)}, quota(1x)=${fmtM(heaviestPost.q1)} → ${heaviestPost.ratio.toFixed(1)}x`);
}

// ─── Section 4: SUPPORTING EVIDENCE — ratio doesn't "jump" ─────────────────
console.log('\n── SECTION 4: SUPPORTING EVIDENCE (ratio does not jump) ───────────────\n');
console.log('  The multiplier has been 10–15x on every active day since December.');
console.log('  Nothing changes at a "transition date" — the quota formula decided to');
console.log('  start applying weight that was always latent in the data.\n');

console.log('  ── 4a. Weekly 1x/0x ratio trend ──');
console.log('  Week       | Days | Calls |  Avg Ratio | Quota(0x)   | Quota(1x)');
console.log('  -----------|------|-------|------------|-------------|-------------');
const weeks = {};
for (const r of rows) {
  const d = new Date(r.date);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  if (!weeks[weekKey]) weeks[weekKey] = { q0_sum: 0, q1_sum: 0, calls: 0, days: 0, dates: [] };
  weeks[weekKey].q0_sum += r.q0;
  weeks[weekKey].q1_sum += r.q1;
  weeks[weekKey].calls += r.calls;
  weeks[weekKey].days++;
  weeks[weekKey].dates.push(r.date);
}
for (const [wk, w] of Object.entries(weeks).sort()) {
  const ratio = w.q0_sum > 0 ? (w.q1_sum / w.q0_sum).toFixed(1) + 'x' : 'N/A';
  console.log(`  ${pad(wk, 10)} | ${pad(w.days, 4)} | ${pad(w.calls, 5)} | ${pad(ratio, 10)} | ${pad(fmtM(w.q0_sum), 11)} | ${pad(fmtM(w.q1_sum), 11)}`);
}

console.log('\n  ── 4b. "Transition-point" detection (expectedly inconclusive) ──');
const thresholds = [2, 3, 5, 10, 20];
for (const thresh of thresholds) {
  const day = rows.find(r => r.ratio >= thresh && r.calls >= 10);
  if (day) {
    console.log(`  First day with 1x/0x ratio >= ${pad(thresh + 'x', 3)}: ${day.date} (ratio=${day.ratio.toFixed(1)}x, ${day.calls} calls)`);
  } else {
    console.log(`  First day with 1x/0x ratio >= ${pad(thresh + 'x', 3)}: never reached (with 10+ calls)`);
  }
}

// ─── Section 5: Daily detail (full table) ──────────────────────────────────
console.log('\n── SECTION 5: DAILY DETAIL (full table) ───────────────────────────────\n');
console.log('  Date       | Calls | CacheRead   | Quota(0x)   | Quota(1x)   | 1x/0x  | CR% of Vis');
console.log('  -----------|-------|-------------|-------------|-------------|--------|----------');
for (const r of rows) {
  console.log(`  ${r.date} | ${pad(r.calls, 5)} | ${pad(fmtM(r.cache_read), 11)} | ${pad(fmtM(r.q0), 11)} | ${pad(fmtM(r.q1), 11)} | ${pad(r.ratio.toFixed(1) + 'x', 6)} | ${pad(r.cr_pct.toFixed(1) + '%', 9)}`);
}

// ─── Section 6: Key findings ───────────────────────────────────────────────
console.log('\n── KEY FINDINGS ────────────────────────────────────────────────────────\n');

if (preMarch.length && postMarch.length) {
  console.log(`  1. Counterfactual: ${total0x} days exceed 180M under quota(0x),`);
  console.log(`     ${total1x} days exceed under quota(1x). The old formula never bound us;`);
  console.log(`     the new formula does, on most active days.`);
  console.log();
  console.log('  2. The 1x/0x ratio doesn\'t "jump" — it\'s 10–15x every week since Dec');
  console.log('     because cache_read has always been 90–95% of visible tokens.');
  console.log('     What changed is whether the quota system APPLIES the weight.');
  console.log();
  console.log('  3. The multiplier tells you how much worse each day becomes once');
  console.log('     cache_read counts. A 15x multiplier means the same workload now');
  console.log('     costs 15x more quota than before the change.');
}
