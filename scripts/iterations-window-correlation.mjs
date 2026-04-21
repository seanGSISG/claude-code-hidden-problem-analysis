#!/usr/bin/env node
/**
 * iterations-window-correlation.mjs — Does the `iterations` usage field
 * correlate with quota spikes at 5-hour window granularity?
 *
 * Context: in our 179K-call dataset, calls with a `usage.iterations` field
 * went from 7.7% of calls in Feb to 42.3% in Mar to 52.4% in Apr, and those
 * calls average ~479 output tokens vs ~14 without (60x more). Output tokens
 * carry 5x weight in the community-inferred quota formula.
 *
 * ArkNill asked: do the iterations-heavy calls cluster in the same 5h
 * windows that drive quota into rate-limit territory? This script answers
 * by binning calls into 5h sliding windows (matching the real system),
 * computing (util_1x, iter_output_fraction) per window, and looking at
 * the relationship across util buckets.
 *
 * Primary outputs:
 *   1. Monthly avg iter_call_fraction and iter_output_fraction
 *   2. Mean iter_output_fraction by util_1x bucket (the correlation)
 *   3. Top sliding peaks with their iter share annotated
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, 'projects');

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const SLIDING_STEP_MS = 15 * 60 * 1000;
const BUDGET_5H_VISIBLE = 180_000_000;

const W_INPUT = 1, W_OUTPUT = 5, W_CACHE_WRITE = 1;

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

function fmtM(n) { return (n / 1e6).toFixed(2) + 'M'; }
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function pad(s, n) { return String(s).padStart(n); }

// ─── Load calls ────────────────────────────────────────────────────────────
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
      month: rec.timestamp.slice(0, 7),
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_create: u.cache_creation_input_tokens || 0,
      hasIter: u.iterations !== undefined,
    });
  }
}
calls.sort((a, b) => a.ts - b.ts);
console.error(`Loaded ${calls.length} calls.\n`);

// ─── Monthly iter-share baseline ───────────────────────────────────────────
const monthly = {};
for (const c of calls) {
  if (!monthly[c.month]) monthly[c.month] = { calls: 0, iterCalls: 0, output: 0, iterOutput: 0 };
  const m = monthly[c.month];
  m.calls++;
  m.output += c.output;
  if (c.hasIter) { m.iterCalls++; m.iterOutput += c.output; }
}

// ─── 5h sliding windows via two-pointer sweep ──────────────────────────────
const startTs = calls[0].ts;
const endTs = calls[calls.length - 1].ts;

const windows = [];
{
  let lo = 0, hi = 0;
  let input = 0, output = 0, cache_read = 0, cache_create = 0;
  let nCalls = 0, iterCalls = 0, iterOutput = 0;

  for (let t = startTs + WINDOW_5H_MS; t <= endTs + SLIDING_STEP_MS; t += SLIDING_STEP_MS) {
    const winStart = t - WINDOW_5H_MS;
    while (hi < calls.length && calls[hi].ts < t) {
      const c = calls[hi];
      input += c.input; output += c.output;
      cache_read += c.cache_read; cache_create += c.cache_create;
      nCalls++;
      if (c.hasIter) { iterCalls++; iterOutput += c.output; }
      hi++;
    }
    while (lo < hi && calls[lo].ts < winStart) {
      const c = calls[lo];
      input -= c.input; output -= c.output;
      cache_read -= c.cache_read; cache_create -= c.cache_create;
      nCalls--;
      if (c.hasIter) { iterCalls--; iterOutput -= c.output; }
      lo++;
    }
    if (nCalls > 0) {
      const q0 = input * W_INPUT + cache_create * W_CACHE_WRITE + output * W_OUTPUT;
      const q1 = q0 + cache_read;
      windows.push({
        start: winStart, end: t,
        startDate: new Date(winStart).toISOString().slice(0, 16),
        month: new Date(winStart).toISOString().slice(0, 7),
        calls: nCalls,
        iterCalls,
        output,
        iterOutput,
        util_q1: q1 / BUDGET_5H_VISIBLE,
        q1,
        iter_call_frac: iterCalls / nCalls,
        iter_output_frac: output > 0 ? iterOutput / output : 0,
      });
    }
  }
}

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  ITERATIONS × 5-HOUR WINDOW CORRELATION');
console.log('═══════════════════════════════════════════════════════════════════════════\n');
console.log('  Answering ArkNill issue-3 reply: do iterations-bearing calls correlate');
console.log('  with the quota jumps that appear in the 5h sliding window simulation?\n');

// ─── Section 1: Monthly iter-share baseline ────────────────────────────────
console.log('── MONTHLY BASELINE: iter share of calls and output tokens ─────────────\n');
console.log('  Month    | Calls   | Iter Calls  | Iter Call % | Output       | Iter Output  | Iter Output %');
console.log('  ---------|---------|-------------|-------------|--------------|--------------|--------------');
for (const m of Object.keys(monthly).sort()) {
  const d = monthly[m];
  const iterCallPct = d.calls > 0 ? (d.iterCalls / d.calls * 100).toFixed(1) + '%' : 'N/A';
  const iterOutPct = d.output > 0 ? (d.iterOutput / d.output * 100).toFixed(1) + '%' : 'N/A';
  console.log(`  ${m}  | ${pad(d.calls, 7)} | ${pad(d.iterCalls, 11)} | ${pad(iterCallPct, 11)} | ${pad(fmtM(d.output), 12)} | ${pad(fmtM(d.iterOutput), 12)} | ${pad(iterOutPct, 12)}`);
}

// ─── Section 2: Iter share by util bucket (the correlation) ────────────────
console.log('\n── CORRELATION: iter_output_fraction by util(1x) bucket ────────────────\n');
console.log('  Each sliding window contributes one (util_1x, iter_output_fraction)');
console.log('  observation. If iterations drive the quota jumps, higher util buckets');
console.log('  should have higher mean iter_output_fraction.\n');

const utilBuckets = [
  { label: '  0–25%', lo: 0,    hi: 0.25 },
  { label: ' 25–50%', lo: 0.25, hi: 0.50 },
  { label: ' 50–80%', lo: 0.50, hi: 0.80 },
  { label: ' 80–100%', lo: 0.80, hi: 1.00 },
  { label: '100%+',   lo: 1.00, hi: Infinity },
];

for (const m of [null, '2026-02', '2026-03', '2026-04']) {
  const label = m === null ? 'ALL MONTHS' : m;
  const subset = m === null ? windows : windows.filter(w => w.month === m);
  if (subset.length === 0) continue;
  console.log(`  ${label}  (n=${subset.length} sliding windows):`);
  console.log('    Util Bucket | Windows | Mean iter_call_frac | Mean iter_output_frac | Mean Util');
  console.log('    ------------|---------|---------------------|-----------------------|----------');
  for (const b of utilBuckets) {
    const hits = subset.filter(w => w.util_q1 >= b.lo && w.util_q1 < b.hi);
    if (hits.length === 0) continue;
    const meanCallFrac = hits.reduce((s, w) => s + w.iter_call_frac, 0) / hits.length;
    const meanOutFrac = hits.reduce((s, w) => s + w.iter_output_frac, 0) / hits.length;
    const meanUtil = hits.reduce((s, w) => s + w.util_q1, 0) / hits.length;
    console.log(`    ${pad(b.label, 11)} | ${pad(hits.length, 7)} | ${pad(pct(meanCallFrac), 19)} | ${pad(pct(meanOutFrac), 21)} | ${pad(pct(meanUtil), 8)}`);
  }
  console.log();
}

// ─── Section 3: Pearson correlation ────────────────────────────────────────
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : NaN;
}

console.log('── PEARSON CORRELATION: util_q1 vs iter_output_fraction ────────────────\n');
for (const m of [null, '2026-02', '2026-03', '2026-04']) {
  const label = m === null ? 'All months' : m;
  const subset = m === null ? windows : windows.filter(w => w.month === m);
  if (subset.length < 2) continue;
  const xs = subset.map(w => w.util_q1);
  const ys = subset.map(w => w.iter_output_frac);
  const r = pearson(xs, ys);
  console.log(`  ${pad(label, 11)} (n=${pad(subset.length, 5)}): r = ${isNaN(r) ? 'N/A' : r.toFixed(3)}`);
}

// ─── Section 4: Top util peaks annotated with iter share ───────────────────
console.log('\n── TOP 10 SLIDING PEAKS WITH ITER SHARE ────────────────────────────────\n');
// De-overlap: take highest util windows greedily, skipping overlaps.
const byUtil = [...windows].sort((a, b) => b.util_q1 - a.util_q1);
const peaks = [];
for (const w of byUtil) {
  if (peaks.some(p => !(w.end <= p.start || w.start >= p.end))) continue;
  peaks.push(w);
  if (peaks.length >= 10) break;
}

console.log('  Rank | Window Start     | Calls | Util(1x) | Quota(1x)   | Iter Call % | Iter Output %');
console.log('  -----|------------------|-------|----------|-------------|-------------|---------------');
for (let i = 0; i < peaks.length; i++) {
  const w = peaks[i];
  console.log(`  ${pad(i + 1, 4)} | ${w.startDate} | ${pad(w.calls, 5)} | ${pad(pct(w.util_q1), 8)} | ${pad(fmtM(w.q1), 11)} | ${pad(pct(w.iter_call_frac), 11)} | ${pad(pct(w.iter_output_frac), 13)}`);
}

// ─── Section 5: Key finding summary ────────────────────────────────────────
console.log('\n── KEY FINDING ────────────────────────────────────────────────────────\n');
const all = windows;
const lowBucket = all.filter(w => w.util_q1 < 0.25);
const highBucket = all.filter(w => w.util_q1 >= 0.80);
if (lowBucket.length && highBucket.length) {
  const lowMean = lowBucket.reduce((s, w) => s + w.iter_output_frac, 0) / lowBucket.length;
  const highMean = highBucket.reduce((s, w) => s + w.iter_output_frac, 0) / highBucket.length;
  console.log(`  Mean iter_output_fraction in low-util  (<25%): ${pct(lowMean)}`);
  console.log(`  Mean iter_output_fraction in high-util (>=80%): ${pct(highMean)}`);
  console.log(`  Difference: ${((highMean - lowMean) * 100).toFixed(1)} percentage points`);
  if (highMean > lowMean + 0.05) {
    console.log(`\n  High-util windows ARE iter-dominated. Iterations growth compounds on`);
    console.log(`  top of the cache_read weight change: more of your quota-spiking windows`);
    console.log(`  are driven by iter-bearing output.`);
  } else {
    console.log(`\n  No meaningful correlation at sliding-window granularity. Iterations`);
    console.log(`  growth is a secular trend; high-util windows reflect cache_read weight`);
    console.log(`  more than iter share per window.`);
  }
}
