#!/usr/bin/env node
/**
 * opus-47-comparison.mjs — Opus 4.7 vs 4.6 on our own dataset.
 *
 * ArkNill's 16_OPUS-47-ADVISORY.md claims:
 *   1. Tokenizer inflation 1.0–1.35x (code/CJK hits upper bound)
 *   2. Adaptive thinking → 2.4x averaged Q5h burn
 *   3. Long-context retrieval regression (91.9% → 59.2%)
 *
 * We can test the first two from our JSONL. Third needs benchmarks.
 *
 * Approach:
 *   - Partition calls by model (opus-4-6 vs opus-4-7)
 *   - Compare per-call token averages (input, output, cache_read)
 *   - Compare iter share and avg iter_output per call
 *   - Build 5h sliding windows for calls sharing a dominant model,
 *     report utilization distribution for 4.6-dominant vs 4.7-dominant
 *
 * Scope: post-Apr-16 for 4.7, last 2 weeks pre-launch for 4.6 fair comparison.
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

function find(dir, out=[]) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) find(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function fmtM(n) { return (n / 1e6).toFixed(2) + 'M'; }
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function pad(s, n) { return String(s).padStart(n); }

// Opus 4.7 launched 2026-04-16. Use Apr 16+ for 4.7 window.
// Fair 4.6 comparison: same span, 14 days prior (Apr 2-15 for 4.6).
const FOUR_SEVEN_START = '2026-04-16';
const FOUR_SIX_START = '2026-04-02';
const FOUR_SIX_END = '2026-04-15';

const files = find(PROJECTS_DIR);
console.error(`Scanning ${files.length} files...`);

const calls = [];
for (const file of files) {
  let lines; try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message?.usage || !rec.timestamp) continue;
    const m = rec.message.model || '';
    if (m === '<synthetic>') continue;
    const u = rec.message.usage;
    calls.push({
      ts: new Date(rec.timestamp).getTime(),
      date: rec.timestamp.slice(0, 10),
      model: m,
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

function classify(c) {
  if (c.model === 'claude-opus-4-7' && c.date >= FOUR_SEVEN_START) return '4.7';
  if (c.model === 'claude-opus-4-6' && c.date >= FOUR_SIX_START && c.date <= FOUR_SIX_END) return '4.6';
  return null;
}

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  OPUS 4.7 vs 4.6 COMPARISON (our 215K-call dataset)');
console.log('═══════════════════════════════════════════════════════════════════════════\n');
console.log(`  4.7 window: ${FOUR_SEVEN_START}+ (claude-opus-4-7)`);
console.log(`  4.6 window: ${FOUR_SIX_START} to ${FOUR_SIX_END} (claude-opus-4-6)`);
console.log(`  Testing: tokenizer inflation, Q5h burn multiplier, iter share\n`);

// ─── Section 1: Per-call averages ──────────────────────────────────────────
function summarize(filter) {
  const arr = calls.filter(filter);
  if (!arr.length) return { n: 0 };
  const n = arr.length;
  const sum = (k) => arr.reduce((s, c) => s + c[k], 0);
  const iterCalls = arr.filter(c => c.hasIter).length;
  const iterOut = arr.filter(c => c.hasIter).reduce((s, c) => s + c.output, 0);
  return {
    n,
    input: sum('input'), output: sum('output'),
    cache_read: sum('cache_read'), cache_create: sum('cache_create'),
    avg_input: sum('input')/n, avg_output: sum('output')/n,
    avg_cache_read: sum('cache_read')/n, avg_cache_create: sum('cache_create')/n,
    iterCalls, iterOut,
    iter_call_frac: iterCalls / n,
    iter_output_frac: sum('output') > 0 ? iterOut / sum('output') : 0,
  };
}

const s46 = summarize(c => classify(c) === '4.6');
const s47 = summarize(c => classify(c) === '4.7');

console.log('── SECTION 1: PER-CALL AVERAGES ────────────────────────────────────────\n');
console.log('  Metric              |   Opus 4.6   |   Opus 4.7   | 4.7 / 4.6');
console.log('  --------------------|--------------|--------------|----------');
const rows = [
  ['Calls', s46.n, s47.n],
  ['Avg input tokens', Math.round(s46.avg_input), Math.round(s47.avg_input)],
  ['Avg output tokens', Math.round(s46.avg_output), Math.round(s47.avg_output)],
  ['Avg cache_read tokens', Math.round(s46.avg_cache_read), Math.round(s47.avg_cache_read)],
  ['Avg cache_create tokens', Math.round(s46.avg_cache_create), Math.round(s47.avg_cache_create)],
  ['Iter-call %', pct(s46.iter_call_frac), pct(s47.iter_call_frac)],
  ['Iter-output %', pct(s46.iter_output_frac), pct(s47.iter_output_frac)],
];
for (const [label, a, b] of rows) {
  let ratio = 'N/A';
  if (typeof a === 'number' && typeof b === 'number' && a > 0) {
    ratio = (b / a).toFixed(2) + 'x';
  }
  console.log(`  ${pad(label, 19)} | ${pad(String(a), 12)} | ${pad(String(b), 12)} | ${pad(ratio, 9)}`);
}

// ─── Section 2: Per-call quota(1x) multiplier ──────────────────────────────
const q46 = s46.input * W_INPUT + s46.cache_create * W_CACHE_WRITE + s46.output * W_OUTPUT + s46.cache_read;
const q47 = s47.input * W_INPUT + s47.cache_create * W_CACHE_WRITE + s47.output * W_OUTPUT + s47.cache_read;
const qpc46 = s46.n > 0 ? q46 / s46.n : 0;
const qpc47 = s47.n > 0 ? q47 / s47.n : 0;

console.log('\n── SECTION 2: QUOTA PER CALL (cache_read = 1x formula) ─────────────────\n');
console.log(`  4.6 avg quota/call: ${qpc46.toLocaleString(undefined, {maximumFractionDigits: 0})} tokens`);
console.log(`  4.7 avg quota/call: ${qpc47.toLocaleString(undefined, {maximumFractionDigits: 0})} tokens`);
console.log(`  Multiplier: ${qpc46 > 0 ? (qpc47 / qpc46).toFixed(2) + 'x' : 'N/A'}`);
console.log();
console.log(`  ArkNill claim: adaptive thinking → 2.4x averaged Q5h burn.`);
if (qpc46 > 0) {
  const mult = qpc47 / qpc46;
  const verdict = mult >= 2.0 ? `CONSISTENT with advisory (observed ${mult.toFixed(2)}x ≥ 2.0x threshold)`
    : mult >= 1.35 ? `PARTIAL support (observed ${mult.toFixed(2)}x; between tokenizer-only 1.35x and claimed 2.4x)`
    : mult >= 1.0 ? `WEAK support (observed ${mult.toFixed(2)}x; close to tokenizer-only 1.0-1.35x)`
    : `NO support (observed ${mult.toFixed(2)}x < 1.0x)`;
  console.log(`  Our measurement: ${verdict}`);
}

// ─── Section 3: Daily breakdown for the 4.7 window ─────────────────────────
console.log('\n── SECTION 3: 4.7 DAILY BREAKDOWN ──────────────────────────────────────\n');
const daily47 = {};
for (const c of calls) {
  if (classify(c) !== '4.7') continue;
  if (!daily47[c.date]) daily47[c.date] = { n: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
  const d = daily47[c.date];
  d.n++;
  d.input += c.input; d.output += c.output;
  d.cache_read += c.cache_read; d.cache_create += c.cache_create;
}
console.log('  Date       | Calls | AvgInput | AvgOutput | AvgCacheRead | Daily Q(1x)');
console.log('  -----------|-------|----------|-----------|--------------|------------');
for (const d of Object.keys(daily47).sort()) {
  const x = daily47[d];
  const q = x.input + x.cache_create + x.output * 5 + x.cache_read;
  console.log(`  ${d} | ${pad(x.n, 5)} | ${pad(Math.round(x.input/x.n), 8)} | ${pad(Math.round(x.output/x.n), 9)} | ${pad(Math.round(x.cache_read/x.n), 12)} | ${pad(fmtM(q), 10)}`);
}

// ─── Section 4: 5h sliding windows, by dominant-model ──────────────────────
console.log('\n── SECTION 4: 5h SLIDING WINDOWS BY DOMINANT MODEL ────────────────────\n');
console.log('  A window is labeled "4.6" or "4.7" if >50% of calls use that model.');
console.log('  Only considers windows starting from Apr 2 (fair comparison span).\n');

const windows = [];
const cutoffTs = new Date(FOUR_SIX_START + 'T00:00:00Z').getTime();
const startTs = cutoffTs;
const endTs = calls[calls.length - 1].ts;

{
  let lo = 0, hi = 0;
  let input = 0, output = 0, cache_read = 0, cache_create = 0, n = 0;
  let n46 = 0, n47 = 0;
  while (lo < calls.length && calls[lo].ts < startTs - WINDOW_5H_MS) lo++;
  hi = lo;

  for (let t = startTs; t <= endTs + SLIDING_STEP_MS; t += SLIDING_STEP_MS) {
    const winStart = t - WINDOW_5H_MS;
    while (hi < calls.length && calls[hi].ts < t) {
      const c = calls[hi];
      input += c.input; output += c.output;
      cache_read += c.cache_read; cache_create += c.cache_create;
      n++;
      if (c.model === 'claude-opus-4-6') n46++;
      if (c.model === 'claude-opus-4-7') n47++;
      hi++;
    }
    while (lo < hi && calls[lo].ts < winStart) {
      const c = calls[lo];
      input -= c.input; output -= c.output;
      cache_read -= c.cache_read; cache_create -= c.cache_create;
      n--;
      if (c.model === 'claude-opus-4-6') n46--;
      if (c.model === 'claude-opus-4-7') n47--;
      lo++;
    }
    if (n > 0) {
      const q1 = input + cache_create + output * 5 + cache_read;
      let dom = null;
      if (n46 > n / 2) dom = '4.6';
      else if (n47 > n / 2) dom = '4.7';
      windows.push({
        start: winStart, end: t, n, q1,
        util: q1 / BUDGET_5H_VISIBLE,
        dom,
      });
    }
  }
}

const w46 = windows.filter(w => w.dom === '4.6');
const w47 = windows.filter(w => w.dom === '4.7');

function windowStats(ws) {
  if (!ws.length) return { n: 0 };
  const utils = ws.map(w => w.util).sort((a, b) => a - b);
  const p = (q) => utils[Math.min(utils.length - 1, Math.floor(q * utils.length))];
  const mean = utils.reduce((s, x) => s + x, 0) / utils.length;
  const over80 = ws.filter(w => w.util > 0.8).length;
  const over100 = ws.filter(w => w.util > 1.0).length;
  return { n: ws.length, mean, p50: p(0.5), p90: p(0.9), p99: p(0.99), max: utils[utils.length - 1], over80, over100 };
}

const stats46 = windowStats(w46);
const stats47 = windowStats(w47);

console.log('  Dominant | Windows | Mean Util | p50 Util | p90 Util | p99 Util | Max Util | >80% | >100%');
console.log('  ---------|---------|-----------|----------|----------|----------|----------|------|------');
for (const [label, s] of [['4.6', stats46], ['4.7', stats47]]) {
  if (!s.n) { console.log(`  ${pad(label, 8)} | ${pad(0, 7)} | (no windows in this span)`); continue; }
  console.log(`  ${pad(label, 8)} | ${pad(s.n, 7)} | ${pad(pct(s.mean), 9)} | ${pad(pct(s.p50), 8)} | ${pad(pct(s.p90), 8)} | ${pad(pct(s.p99), 8)} | ${pad(pct(s.max), 8)} | ${pad(s.over80, 4)} | ${pad(s.over100, 5)}`);
}

if (stats46.n > 0 && stats47.n > 0) {
  console.log(`\n  Mean utilization 4.7 / 4.6 ratio: ${(stats47.mean / stats46.mean).toFixed(2)}x`);
  console.log(`  p90  utilization 4.7 / 4.6 ratio: ${(stats47.p90 / stats46.p90).toFixed(2)}x`);
}

// ─── Section 5: Key findings ───────────────────────────────────────────────
console.log('\n── KEY FINDINGS ────────────────────────────────────────────────────────\n');
if (s46.n > 0 && s47.n > 0) {
  const inputMult = s47.avg_input / s46.avg_input;
  const outputMult = s47.avg_output / s46.avg_output;
  const crMult = s47.avg_cache_read / s46.avg_cache_read;
  const iterCallDelta = s47.iter_call_frac - s46.iter_call_frac;
  const iterOutDelta = s47.iter_output_frac - s46.iter_output_frac;

  console.log(`  1. Per-call token multipliers (4.7 vs 4.6):`);
  console.log(`       input      ${inputMult.toFixed(2)}x   (advisory: 1.0–1.35x tokenizer)`);
  console.log(`       output     ${outputMult.toFixed(2)}x   (advisory: adaptive thinking heavier)`);
  console.log(`       cache_read ${crMult.toFixed(2)}x   (advisory: cache metering anomaly ~7x reported)`);
  console.log();
  console.log(`  2. Iter-call share: 4.6 ${pct(s46.iter_call_frac)}, 4.7 ${pct(s47.iter_call_frac)}`);
  console.log(`     Iter-output share: 4.6 ${pct(s46.iter_output_frac)}, 4.7 ${pct(s47.iter_output_frac)}`);
  if (Math.abs(iterOutDelta) > 0.05) {
    console.log(`     Δ ${(iterOutDelta*100).toFixed(1)} pp — notable shift in iter contribution.`);
  } else {
    console.log(`     Δ ${(iterOutDelta*100).toFixed(1)} pp — small.`);
  }
  console.log();
  console.log(`  3. Sample sizes: 4.6 ${s46.n} calls, 4.7 ${s47.n} calls.`);
  console.log(`     CAVEAT: early-window 4.7 data. Workload mix may not match 4.6 baseline.`);
}
