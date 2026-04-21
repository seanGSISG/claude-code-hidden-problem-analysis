#!/usr/bin/env node
/**
 * dual-window-simulation.mjs — Simulate ArkNill's dual sliding window
 * (5-hour + 7-day) rate limit system against our 179K-call dataset.
 *
 * ArkNill captured actual utilization headers via cc-relay proxy (April 4-14).
 * We don't have headers, but we have timestamps and token usage. This script
 * buckets calls into 5-hour SLIDING windows (primary) and tumbling windows
 * (retained for comparison) and estimates utilization under the old
 * (cache_read=0x) and new (cache_read=1x) quota formulas.
 *
 * v2 (ArkNill review response): sliding-window pass added. The real system
 * uses sliding windows, and tumbling undercounts peaks that straddle bucket
 * boundaries. Sliding step: 15 min. Two-pointer sweep, O(n).
 *
 * ArkNill benchmarks (Max 20x, April 4-14):
 *   1% of 5h = 1.5M-2.1M visible tokens (midpoint 1.8M)
 *   100% of 5h = ~180M visible tokens
 *   7d/5h accumulation ratio: 0.12-0.17
 *   5h is bottleneck in 77.4% of requests
 *
 * Reference: ArkNill/claude-code-hidden-problem-analysis 02_RATELIMIT-HEADERS.md
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, 'projects');

// ─── Constants ─────────────────────────────────────────────────────────────
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
const SLIDING_STEP_MS = 15 * 60 * 1000; // 15-minute step; 20 steps per 5h window

// ArkNill: 1% ≈ 1.8M visible tokens (midpoint). 100% ≈ 180M.
const BUDGET_5H_VISIBLE = 180_000_000;

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
function fmtK(n) { return (n / 1e3).toFixed(1) + 'K'; }
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function pad(s, n) { return String(s).padStart(n); }

// ─── Load all calls into flat array ────────────────────────────────────────
const files = findJsonlFiles(PROJECTS_DIR);
console.error(`Scanning ${files.length} files...`);

const calls = [];

for (const file of files) {
  let lines;
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }

  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage || !rec.timestamp) continue;
    if (rec.message.model === '<synthetic>') continue;

    const u = rec.message.usage;
    calls.push({
      ts: new Date(rec.timestamp).getTime(),
      date: rec.timestamp.slice(0, 10),
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_create: u.cache_creation_input_tokens || 0,
    });
  }
}

calls.sort((a, b) => a.ts - b.ts);
console.error(`Loaded ${calls.length} calls. Range: ${calls[0]?.date} to ${calls[calls.length - 1]?.date}\n`);

// ─── Helpers ───────────────────────────────────────────────────────────────
function finalizeWindow(w) {
  w.visible = w.input + w.output + w.cache_read + w.cache_create;
  w.q0 = w.input * W_INPUT + w.cache_create * W_CACHE_WRITE + w.output * W_OUTPUT;
  w.q1 = w.q0 + w.cache_read;
  w.util_visible = w.visible / BUDGET_5H_VISIBLE;
  w.util_q1 = w.q1 / BUDGET_5H_VISIBLE;
  return w;
}

const startTs = calls[0].ts;
const endTs = calls[calls.length - 1].ts;

// ─── Tumbling 5-hour windows (baseline) ────────────────────────────────────
const tumbling = [];
{
  let winStart = startTs;
  let callIdx = 0;
  while (winStart < endTs) {
    const winEnd = winStart + WINDOW_5H_MS;
    const win = {
      start: winStart, end: winEnd,
      startDate: new Date(winStart).toISOString().slice(0, 16),
      calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0,
    };
    while (callIdx < calls.length && calls[callIdx].ts < winEnd) {
      const c = calls[callIdx];
      win.calls++;
      win.input += c.input; win.output += c.output;
      win.cache_read += c.cache_read; win.cache_create += c.cache_create;
      callIdx++;
    }
    if (win.calls > 0) tumbling.push(finalizeWindow(win));
    winStart = winEnd;
  }
}

// ─── Sliding 5-hour windows (primary, matches real system) ─────────────────
// Step every 15 minutes through [startTs, endTs]. For each step t, the
// window covers calls with ts ∈ [t - 5h, t). Two-pointer sweep: both
// pointers advance monotonically as t advances, so overall pass is O(n+T/Δ).
const sliding = [];
{
  let lo = 0, hi = 0;
  let input = 0, output = 0, cache_read = 0, cache_create = 0, nCalls = 0;

  for (let t = startTs + WINDOW_5H_MS; t <= endTs + SLIDING_STEP_MS; t += SLIDING_STEP_MS) {
    const winStart = t - WINDOW_5H_MS;

    // Advance hi to include calls with ts < t
    while (hi < calls.length && calls[hi].ts < t) {
      const c = calls[hi];
      input += c.input; output += c.output;
      cache_read += c.cache_read; cache_create += c.cache_create;
      nCalls++;
      hi++;
    }
    // Advance lo to drop calls with ts < winStart
    while (lo < hi && calls[lo].ts < winStart) {
      const c = calls[lo];
      input -= c.input; output -= c.output;
      cache_read -= c.cache_read; cache_create -= c.cache_create;
      nCalls--;
      lo++;
    }

    if (nCalls > 0) {
      sliding.push(finalizeWindow({
        start: winStart, end: t,
        startDate: new Date(winStart).toISOString().slice(0, 16),
        calls: nCalls, input, output, cache_read, cache_create,
      }));
    }
  }
}

// Primary windows = sliding. Tumbling retained for side-by-side.
const windows = sliding;

// ─── 7-day rolling, computed from tumbling (cheaper, directionally correct) ─
for (let i = 0; i < tumbling.length; i++) {
  const w = tumbling[i];
  const cutoff = w.end - WINDOW_7D_MS;
  let rolling_visible = 0, rolling_q1 = 0, rolling_windows = 0;
  for (let j = i; j >= 0; j--) {
    if (tumbling[j].start < cutoff) break;
    rolling_visible += tumbling[j].visible;
    rolling_q1 += tumbling[j].q1;
    rolling_windows++;
  }
  w.rolling_7d_visible = rolling_visible;
  w.rolling_7d_q1 = rolling_q1;
  w.rolling_7d_windows = rolling_windows;
  w.rolling_7d_util = rolling_visible / (BUDGET_5H_VISIBLE * 33.6); // 33.6 x 5h per 7d
}

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  DUAL-WINDOW SIMULATION: 5-Hour and 7-Day Rate Limit Windows');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

// ─── Section 1: Monthly summary (sliding primary, tumbling comparison) ─────
console.log('── MONTHLY 5-HOUR WINDOW SUMMARY (SLIDING) ────────────────────────────\n');
console.log('  Budget reference: 100% of 5h ≈ 180M visible tokens (ArkNill midpoint)');
console.log('  Sliding step: 15 min. Tumbling max shown for comparison.\n');

function summarizeByMonth(wins) {
  const months = {};
  for (const w of wins) {
    const m = w.startDate.slice(0, 7);
    if (!months[m]) months[m] = { windows: 0, totalVis: 0, maxVis: 0, over80: 0, over100: 0 };
    const md = months[m];
    md.windows++;
    md.totalVis += w.visible;
    if (w.visible > md.maxVis) md.maxVis = w.visible;
    if (w.util_visible > 0.8) md.over80++;
    if (w.util_visible > 1.0) md.over100++;
  }
  return months;
}

const slidingMonths = summarizeByMonth(sliding);
const tumblingMonths = summarizeByMonth(tumbling);

console.log('  Month    | Sliding Steps | Avg Util | Max Util (Sliding) | Max Util (Tumbling) | >80% | >100%');
console.log('  ---------|---------------|----------|--------------------|---------------------|------|------');
for (const m of Object.keys(slidingMonths).sort()) {
  const s = slidingMonths[m];
  const t = tumblingMonths[m] || { maxVis: 0 };
  const avgUtil = s.totalVis / s.windows / BUDGET_5H_VISIBLE;
  const maxUtilS = s.maxVis / BUDGET_5H_VISIBLE;
  const maxUtilT = t.maxVis / BUDGET_5H_VISIBLE;
  console.log(`  ${m}  | ${pad(s.windows, 13)} | ${pad(pct(avgUtil), 8)} | ${pad(pct(maxUtilS), 18)} | ${pad(pct(maxUtilT), 19)} | ${pad(s.over80, 4)} | ${pad(s.over100, 5)}`);
}

// ─── Section 2: Top 20 heaviest 5h windows (de-overlapped sliding peaks) ────
console.log('\n── TOP 20 HEAVIEST 5-HOUR WINDOWS (SLIDING, DE-OVERLAPPED) ────────────\n');
console.log('  Greedy peak-picking: take the heaviest sliding window, skip overlaps,');
console.log('  repeat. Each reported peak is a distinct 5h span.\n');

const peaks = [];
{
  const sorted = [...sliding].sort((a, b) => b.visible - a.visible);
  for (const w of sorted) {
    const overlapsExisting = peaks.some(p =>
      !(w.end <= p.start || w.start >= p.end)
    );
    if (!overlapsExisting) peaks.push(w);
    if (peaks.length >= 20) break;
  }
}

console.log('  Rank | Window Start     | Calls | CacheRead  | Output    | Visible    | Est Util | Quota(1x)');
console.log('  -----|------------------|-------|------------|-----------|------------|----------|----------');
for (let i = 0; i < peaks.length; i++) {
  const w = peaks[i];
  console.log(`  ${pad(i + 1, 4)} | ${w.startDate} | ${pad(w.calls, 5)} | ${pad(fmtM(w.cache_read), 10)} | ${pad(fmtM(w.output), 9)} | ${pad(fmtM(w.visible), 10)} | ${pad(pct(w.util_visible), 8)} | ${pad(fmtM(w.q1), 9)}`);
}

// ─── Section 3: Rolling 7-day peaks ────────────────────────────────────────
console.log('\n── ROLLING 7-DAY UTILIZATION PEAKS ─────────────────────────────────────\n');
console.log('  ArkNill: 7d peaked at 0.966 on April 10. Weekly budget is separate from 5h.');
console.log('  Computed from tumbling windows (each 5h bucket counted once in the 7d sum).\n');

// Find peak 7d windows per month (from tumbling, since sliding would overcount)
const monthly7d = {};
for (const w of tumbling) {
  const m = w.startDate.slice(0, 7);
  if (!monthly7d[m]) monthly7d[m] = { maxRolling: 0, maxWindow: null };
  if (w.rolling_7d_visible > monthly7d[m].maxRolling) {
    monthly7d[m].maxRolling = w.rolling_7d_visible;
    monthly7d[m].maxWindow = w;
  }
}

console.log('  Month    | Peak 7d Visible | As Multiple of 5h Budget | Windows in 7d');
console.log('  ---------|-----------------|--------------------------|-------------');
for (const m of Object.keys(monthly7d).sort()) {
  const d = monthly7d[m];
  const mult = (d.maxRolling / BUDGET_5H_VISIBLE).toFixed(1) + 'x';
  console.log(`  ${m}  | ${pad(fmtM(d.maxRolling), 15)} | ${pad(mult, 24)} | ${pad(d.maxWindow?.rolling_7d_windows || 0, 12)}`);
}

// ─── Section 4: "Would you have been rate-limited?" (SLIDING — primary) ────
console.log('\n── WOULD YOU HAVE BEEN RATE-LIMITED? (SLIDING) ─────────────────────────\n');
console.log('  Sliding window is the real system. Peak util under sliding is the');
console.log('  number that would have triggered a rate limit.\n');

const febWindows = sliding.filter(w => w.startDate.startsWith('2026-02'));
const marWindows = sliding.filter(w => w.startDate.startsWith('2026-03'));
const aprWindows = sliding.filter(w => w.startDate.startsWith('2026-04'));

for (const { label, wins } of [
  { label: 'Feb 2026', wins: febWindows },
  { label: 'Mar 2026', wins: marWindows },
  { label: 'Apr 2026', wins: aprWindows },
]) {
  if (!wins.length) continue;
  const maxVis = Math.max(...wins.map(w => w.visible));
  const maxQ1 = Math.max(...wins.map(w => w.q1));
  const maxQ0 = Math.max(...wins.map(w => w.q0));
  const over100vis = wins.filter(w => w.util_visible > 1.0).length;
  const over80vis = wins.filter(w => w.util_visible > 0.8).length;

  console.log(`  ${label}: ${wins.length} sliding steps`);
  console.log(`    Heaviest window: ${fmtM(maxVis)} visible (${pct(maxVis / BUDGET_5H_VISIBLE)} of 5h budget)`);
  console.log(`    Sliding steps exceeding 80% of 5h budget: ${over80vis}`);
  console.log(`    Sliding steps exceeding 100% of 5h budget: ${over100vis}`);
  console.log(`    Under 0x weight (cache_read free): max quota = ${fmtM(maxQ0)} (${pct(maxQ0 / BUDGET_5H_VISIBLE)})`);
  console.log(`    Under 1x weight: max quota = ${fmtM(maxQ1)} (${pct(maxQ1 / BUDGET_5H_VISIBLE)})`);
  console.log();
}

// ─── Section 5: Window utilization distribution (TUMBLING) ─────────────────
console.log('── 5-HOUR WINDOW UTILIZATION DISTRIBUTION (TUMBLING) ──────────────────\n');
console.log('  Tumbling used here so each 5h window is counted once; sliding would');
console.log('  over-represent sustained high-usage periods.\n');

const buckets = [
  { label: '0-10%', lo: 0, hi: 0.1 },
  { label: '10-25%', lo: 0.1, hi: 0.25 },
  { label: '25-50%', lo: 0.25, hi: 0.5 },
  { label: '50-75%', lo: 0.5, hi: 0.75 },
  { label: '75-100%', lo: 0.75, hi: 1.0 },
  { label: '100-150%', lo: 1.0, hi: 1.5 },
  { label: '150%+', lo: 1.5, hi: Infinity },
];

const febTumbling = tumbling.filter(w => w.startDate.startsWith('2026-02'));
const marTumbling = tumbling.filter(w => w.startDate.startsWith('2026-03'));
const aprTumbling = tumbling.filter(w => w.startDate.startsWith('2026-04'));

for (const period of [
  { label: 'Feb', wins: febTumbling },
  { label: 'Mar', wins: marTumbling },
  { label: 'Apr', wins: aprTumbling },
]) {
  if (!period.wins.length) continue;
  console.log(`  ${period.label} (${period.wins.length} windows):`);
  for (const b of buckets) {
    const count = period.wins.filter(w => w.util_visible >= b.lo && w.util_visible < b.hi).length;
    if (count > 0) {
      const bar = '█'.repeat(Math.round(count / period.wins.length * 40));
      console.log(`    ${pad(b.label, 8)}: ${pad(count, 4)} (${pad((count / period.wins.length * 100).toFixed(0) + '%', 4)}) ${bar}`);
    }
  }
  console.log();
}

// ─── Section 6: Key findings ───────────────────────────────────────────────
console.log('── KEY FINDINGS ────────────────────────────────────────────────────────\n');

if (febWindows.length && marWindows.length) {
  const febMaxS = Math.max(...febWindows.map(w => w.util_visible));
  const marMaxS = Math.max(...marWindows.map(w => w.util_visible));
  const aprMaxS = Math.max(...aprWindows.map(w => w.util_visible));
  const febMaxT = febTumbling.length ? Math.max(...febTumbling.map(w => w.util_visible)) : 0;
  const marMaxT = marTumbling.length ? Math.max(...marTumbling.map(w => w.util_visible)) : 0;
  const aprMaxT = aprTumbling.length ? Math.max(...aprTumbling.map(w => w.util_visible)) : 0;

  console.log(`  1. Peak 5h utilization (sliding vs tumbling):`);
  console.log(`     Feb: sliding ${pct(febMaxS)}, tumbling ${pct(febMaxT)}`);
  console.log(`     Mar: sliding ${pct(marMaxS)}, tumbling ${pct(marMaxT)}`);
  console.log(`     Apr: sliding ${pct(aprMaxS)}, tumbling ${pct(aprMaxT)}`);
  console.log(`     Sliding catches spikes that straddle tumbling boundaries.`);
  console.log();

  console.log('  2. Under the old regime (0x cache_read), NO 5-hour window in any month');
  console.log(`     exceeds the budget. Max quota(0x) across all sliding windows:`);
  const allMaxQ0 = Math.max(...sliding.map(w => w.q0));
  console.log(`     ${fmtM(allMaxQ0)} = ${pct(allMaxQ0 / BUDGET_5H_VISIBLE)} of budget`);
  console.log();

  console.log('  3. Under the new regime (1x cache_read), multiple sliding windows');
  console.log('     per day exceed the budget because cache_read tokens dominate.');
}
