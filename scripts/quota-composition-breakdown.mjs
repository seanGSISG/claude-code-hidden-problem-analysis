#!/usr/bin/env node
/**
 * quota-composition-breakdown.mjs — Break down quota-weighted tokens by category
 * under two cache_read weight regimes (0x and 1x) to validate ArkNill's finding
 * that cache_read is 96-99% of visible tokens per utilization point.
 *
 * ArkNill proxy data (April 4-14, Max 20x plan, 23,374 requests):
 *   - Each 1% of 5h utilization costs ~1.5M-2.1M visible tokens
 *   - 96-99% of those visible tokens are cache_read
 *   - Output per 1%: only 9K-16K tokens
 *   - Thinking tokens not visible in usage (blind spot)
 *
 * This script tests what our 179K-call dataset (Dec 2025-Apr 2026) looks like
 * under both the old (cache_read=0x) and new (cache_read=1x) quota formulas.
 *
 * Reference: ArkNill/claude-code-hidden-problem-analysis 02_RATELIMIT-HEADERS.md
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, 'projects');

// ─── Quota weights ─────────────────────────────────────────────────────────
const W_INPUT = 1;
const W_OUTPUT = 5;
const W_CACHE_WRITE = 1;  // conservative (treats all writes as 1h tier)
// cache_read weight is the variable: 0x (old) vs 1x (new)

// ArkNill benchmarks (April 4-14 proxy data, Max 20x)
const ARKNILL_TOKENS_PER_1PCT_LOW = 1_500_000;
const ARKNILL_TOKENS_PER_1PCT_HIGH = 2_100_000;
const ARKNILL_OUTPUT_PER_1PCT_LOW = 9_000;
const ARKNILL_OUTPUT_PER_1PCT_HIGH = 16_000;

// ─── File walker ───────────────────────────────────────────────────────────
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

// ─── Formatting helpers ────────────────────────────────────────────────────
function fmtM(n) { return (n / 1e6).toFixed(2) + 'M'; }
function fmtK(n) { return (n / 1e3).toFixed(1) + 'K'; }
function pct(part, total) { return total ? ((part / total) * 100).toFixed(1) + '%' : '0.0%'; }
function pad(s, n) { return String(s).padStart(n); }

// ─── Main ──────────────────────────────────────────────────────────────────
const files = findJsonlFiles(PROJECTS_DIR);
console.error(`Scanning ${files.length} files...`);

const monthly = {};

function ensure(m) {
  if (!monthly[m]) monthly[m] = {
    calls: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
    // iterations breakdown
    iter_calls: 0, iter_output: 0,
    iter_input: 0, iter_cache_read: 0, iter_cache_create: 0,
    noiter_calls: 0, noiter_output: 0,
    noiter_input: 0, noiter_cache_read: 0, noiter_cache_create: 0,
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

    const month = rec.timestamp.slice(0, 7);
    const u = rec.message.usage;

    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cache_read = u.cache_read_input_tokens || 0;
    const cache_create = u.cache_creation_input_tokens || 0;
    const hasIter = u.iterations !== undefined;

    ensure(month);
    const m = monthly[month];
    m.calls++;
    m.input += input;
    m.output += output;
    m.cache_read += cache_read;
    m.cache_create += cache_create;

    if (hasIter) {
      m.iter_calls++;
      m.iter_output += output;
      m.iter_input += input;
      m.iter_cache_read += cache_read;
      m.iter_cache_create += cache_create;
    } else {
      m.noiter_calls++;
      m.noiter_output += output;
      m.noiter_input += input;
      m.noiter_cache_read += cache_read;
      m.noiter_cache_create += cache_create;
    }

    total++;
  }
}

console.error(`Loaded ${total} calls.\n`);

const focus = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

// ─── Section 1: Raw token volumes ──────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  QUOTA COMPOSITION BREAKDOWN: What Eats Your Budget?');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

console.log('── RAW TOKEN VOLUMES BY MONTH ──────────────────────────────────────────\n');
console.log('  Month    |    Calls |      Input |     Output |  CacheRead |  CacheWrite |    Visible');
console.log('  ---------|---------|------------|------------|------------|-------------|----------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const visible = d.input + d.output + d.cache_read + d.cache_create;
  console.log(`  ${m}  | ${pad(d.calls, 7)} | ${pad(fmtM(d.input), 10)} | ${pad(fmtM(d.output), 10)} | ${pad(fmtM(d.cache_read), 10)} | ${pad(fmtM(d.cache_create), 11)} | ${pad(fmtM(visible), 9)}`);
}

// ─── Section 2: Composition under 0x cache_read weight ─────────────────────
console.log('\n── QUOTA COMPOSITION: cache_read = 0x (OLD REGIME) ────────────────────\n');
console.log('  Under this regime, cache_read is FREE. Output at 5x dominates quota.\n');
console.log('  Month    |  Quota(0x) |  Input% | CacheWrite% |  Output(5x)% | CacheRead%');
console.log('  ---------|------------|---------|-------------|--------------|----------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const q_input = d.input * W_INPUT;
  const q_cw = d.cache_create * W_CACHE_WRITE;
  const q_output = d.output * W_OUTPUT;
  const q_cr = 0;
  const q_total = q_input + q_cw + q_output + q_cr;
  console.log(`  ${m}  | ${pad(fmtM(q_total), 10)} | ${pad(pct(q_input, q_total), 7)} | ${pad(pct(q_cw, q_total), 11)} | ${pad(pct(q_output, q_total), 12)} | ${pad('0.0%', 10)}`);
}

// ─── Section 3: Composition under 1x cache_read weight ─────────────────────
console.log('\n── QUOTA COMPOSITION: cache_read = 1x (NEW REGIME) ────────────────────\n');
console.log('  Under this regime, cache_read counts at 1x. It dominates by volume.\n');
console.log('  Month    |  Quota(1x) |  Input% | CacheWrite% |  Output(5x)% | CacheRead(1x)%');
console.log('  ---------|------------|---------|-------------|--------------|----------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const q_input = d.input * W_INPUT;
  const q_cw = d.cache_create * W_CACHE_WRITE;
  const q_output = d.output * W_OUTPUT;
  const q_cr = d.cache_read * 1;
  const q_total = q_input + q_cw + q_output + q_cr;
  console.log(`  ${m}  | ${pad(fmtM(q_total), 10)} | ${pad(pct(q_input, q_total), 7)} | ${pad(pct(q_cw, q_total), 11)} | ${pad(pct(q_output, q_total), 12)} | ${pad(pct(q_cr, q_total), 10)}`);
}

// ─── Section 4: Side-by-side quota explosion ───────────────────────────────
console.log('\n── QUOTA EXPLOSION: 0x vs 1x SIDE BY SIDE ─────────────────────────────\n');
console.log('  Shows how much larger the quota bill becomes when cache_read counts.\n');
console.log('  Month    |  Quota(0x) |  Quota(1x) | Multiplier | CacheRead Raw');
console.log('  ---------|------------|------------|------------|-------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const q0 = d.input * W_INPUT + d.cache_create * W_CACHE_WRITE + d.output * W_OUTPUT;
  const q1 = q0 + d.cache_read * 1;
  const mult = q0 > 0 ? (q1 / q0).toFixed(1) + 'x' : 'N/A';
  console.log(`  ${m}  | ${pad(fmtM(q0), 10)} | ${pad(fmtM(q1), 10)} | ${pad(mult, 10)} | ${pad(fmtM(d.cache_read), 10)}`);
}

// ─── Section 5: Visible token composition (for ArkNill comparison) ─────────
console.log('\n── VISIBLE TOKEN COMPOSITION (ArkNill comparison) ────────────────────\n');
console.log('  ArkNill found cache_read = 96-99% of visible tokens per 1% utilization.');
console.log('  Our raw visible token composition by month:\n');
console.log('  Month    |  CacheRead% of Visible |  Output% of Visible |  Input% of Visible | CacheWrite% of Visible');
console.log('  ---------|------------------------|---------------------|--------------------|-----------------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const visible = d.input + d.output + d.cache_read + d.cache_create;
  console.log(`  ${m}  | ${pad(pct(d.cache_read, visible), 22)} | ${pad(pct(d.output, visible), 19)} | ${pad(pct(d.input, visible), 18)} | ${pad(pct(d.cache_create, visible), 22)}`);
}

// ─── Section 6: Per-1% estimation ──────────────────────────────────────────
console.log('\n── ESTIMATED TOKENS PER 1% UTILIZATION ─────────────────────────────────\n');
console.log('  Using ArkNill benchmark: 1% of 5h = 1.5M-2.1M visible tokens (midpoint 1.8M)');
console.log('  100% of 5h window = ~180M visible tokens\n');

const BUDGET_5H_VISIBLE = 180_000_000; // midpoint of ArkNill range * 100

for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const visible = d.input + d.output + d.cache_read + d.cache_create;
  const est_pct_used = (visible / BUDGET_5H_VISIBLE * 100);
  const output_per_1pct = est_pct_used > 0 ? d.output / est_pct_used : 0;
  const cache_read_per_1pct = est_pct_used > 0 ? d.cache_read / est_pct_used : 0;

  console.log(`  ${m} (${d.calls} calls):`);
  console.log(`    Total visible: ${fmtM(visible)} = ~${est_pct_used.toFixed(0)}% of one 5h window`);
  console.log(`    Output per est. 1%: ${fmtK(output_per_1pct)} (ArkNill: ${fmtK(ARKNILL_OUTPUT_PER_1PCT_LOW)}-${fmtK(ARKNILL_OUTPUT_PER_1PCT_HIGH)})`);
  console.log(`    CacheRead per est. 1%: ${fmtM(cache_read_per_1pct)} (ArkNill: ${fmtM(ARKNILL_TOKENS_PER_1PCT_LOW)}-${fmtM(ARKNILL_TOKENS_PER_1PCT_HIGH)})`);
  console.log();
}

// ─── Section 7: Iterations cross-reference ─────────────────────────────────
console.log('── ITERATIONS CROSS-REFERENCE ─────────────────────────────────────────\n');
console.log('  How do iterations-bearing calls differ in quota composition?\n');
console.log('  Month    | Iter Calls |  Iter Output(5x)% |  NoIter Output(5x)% | Iter CacheRead% | NoIter CacheRead%');
console.log('  ---------|-----------|-------------------|---------------------|-----------------|------------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];

  // iter quota under 1x regime
  const iter_q = d.iter_input * W_INPUT + d.iter_cache_create * W_CACHE_WRITE + d.iter_output * W_OUTPUT + d.iter_cache_read * 1;
  const iter_out_pct = iter_q > 0 ? pct(d.iter_output * W_OUTPUT, iter_q) : 'N/A';
  const iter_cr_pct = iter_q > 0 ? pct(d.iter_cache_read, iter_q) : 'N/A';

  const noiter_q = d.noiter_input * W_INPUT + d.noiter_cache_create * W_CACHE_WRITE + d.noiter_output * W_OUTPUT + d.noiter_cache_read * 1;
  const noiter_out_pct = noiter_q > 0 ? pct(d.noiter_output * W_OUTPUT, noiter_q) : 'N/A';
  const noiter_cr_pct = noiter_q > 0 ? pct(d.noiter_cache_read, noiter_q) : 'N/A';

  console.log(`  ${m}  | ${pad(d.iter_calls, 9)} | ${pad(iter_out_pct, 17)} | ${pad(noiter_out_pct, 19)} | ${pad(iter_cr_pct, 15)} | ${pad(noiter_cr_pct, 17)}`);
}

// ─── Section 8: Key findings ───────────────────────────────────────────────
console.log('\n── KEY FINDINGS ────────────────────────────────────────────────────────\n');

if (monthly['2026-02'] && monthly['2026-03']) {
  const feb = monthly['2026-02'];
  const mar = monthly['2026-03'];

  const feb_q0 = feb.input * W_INPUT + feb.cache_create * W_CACHE_WRITE + feb.output * W_OUTPUT;
  const feb_q1 = feb_q0 + feb.cache_read;
  const mar_q0 = mar.input * W_INPUT + mar.cache_create * W_CACHE_WRITE + mar.output * W_OUTPUT;
  const mar_q1 = mar_q0 + mar.cache_read;

  console.log('  1. QUOTA MULTIPLIER from cache_read weight change:');
  console.log(`     Feb: ${fmtM(feb_q0)} (0x) → ${fmtM(feb_q1)} (1x) = ${(feb_q1 / feb_q0).toFixed(1)}x increase`);
  console.log(`     Mar: ${fmtM(mar_q0)} (0x) → ${fmtM(mar_q1)} (1x) = ${(mar_q1 / mar_q0).toFixed(1)}x increase`);
  console.log();

  const feb_vis = feb.input + feb.output + feb.cache_read + feb.cache_create;
  const mar_vis = mar.input + mar.output + mar.cache_read + mar.cache_create;
  console.log('  2. CACHE READ SHARE of visible tokens:');
  console.log(`     Feb: ${pct(feb.cache_read, feb_vis)} of visible tokens`);
  console.log(`     Mar: ${pct(mar.cache_read, mar_vis)} of visible tokens`);
  console.log();

  console.log('  3. OUTPUT (5x) SHARE of quota:');
  console.log(`     Under 0x: Feb ${pct(feb.output * W_OUTPUT, feb_q0)}, Mar ${pct(mar.output * W_OUTPUT, mar_q0)}`);
  console.log(`     Under 1x: Feb ${pct(feb.output * W_OUTPUT, feb_q1)}, Mar ${pct(mar.output * W_OUTPUT, mar_q1)}`);
  console.log('     When cache_read counts, output\'s share shrinks but its absolute cost stays the same.');
}
