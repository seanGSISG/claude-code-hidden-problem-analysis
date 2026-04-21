#!/usr/bin/env node
/**
 * thinking-token-estimation.mjs — Estimate the invisible thinking token
 * contribution to quota that neither our logs nor ArkNill's proxy can
 * directly observe.
 *
 * ArkNill identified thinking tokens as a "blind spot": the usage object
 * returns output_tokens but doesn't separate visible output from thinking.
 * Their proxy found output per 1% utilization is only 9K-16K tokens, but
 * we need to know if those are purely visible tokens or include thinking.
 *
 * Our approach: we have the actual content blocks in our JSONL logs.
 * For calls with type="thinking" blocks, we can estimate visible output
 * from text/tool_use blocks and compare against reported output_tokens.
 * The gap bounds the thinking token contribution.
 *
 * v2 (ArkNill review response): tool_use token estimate refined. The
 * original fixed 80-tokens-per-block heuristic is wrong for calls that
 * mostly use small tools (Read) or large tools (Edit). We now estimate
 * per-block from the JSON size of the `input` payload. Legacy estimate
 * retained side-by-side as sensitivity check.
 *
 * Reference: ArkNill/claude-code-hidden-problem-analysis 02_RATELIMIT-HEADERS.md §5
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, 'projects');

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
function fmtK(n) { return (n / 1e3).toFixed(1) + 'K'; }
function pct(part, total) { return total ? ((part / total) * 100).toFixed(1) + '%' : '0.0%'; }
function pad(s, n) { return String(s).padStart(n); }
function avg(total, count) { return count ? Math.round(total / count) : 0; }

// ─── Load all calls with content analysis ──────────────────────────────────
const files = findJsonlFiles(PROJECTS_DIR);
console.error(`Scanning ${files.length} files...`);

const monthly = {};

function ensure(m) {
  if (!monthly[m]) monthly[m] = {
    total_calls: 0,
    // Calls WITH thinking blocks (new per-block estimate)
    think_calls: 0,
    think_reported_output: 0,
    think_visible_est: 0,
    think_visible_est_legacy: 0,
    think_thinking_chars: 0,
    think_text_chars: 0,
    think_tool_blocks: 0,
    // Calls WITHOUT thinking blocks
    nothink_calls: 0,
    nothink_reported_output: 0,
    nothink_visible_est: 0,
    nothink_visible_est_legacy: 0,
    nothink_text_chars: 0,
    nothink_tool_blocks: 0,
    // Distribution tracking (under new estimate)
    gap_positive: 0,
    gap_negative: 0,
    total_gap: 0,
    // Cache_read for quota context
    cache_read: 0,
    input: 0,
    cache_create: 0,
    // Per-tool distribution (for the sensitivity section)
    toolBlockSizes: [], // array of per-block estimated tokens (new formula)
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
    const content = rec.message.content || [];
    const output = u.output_tokens || 0;

    ensure(month);
    const m = monthly[month];
    m.total_calls++;
    m.cache_read += u.cache_read_input_tokens || 0;
    m.input += u.input_tokens || 0;
    m.cache_create += u.cache_creation_input_tokens || 0;
    total++;

    // Analyze content blocks
    const hasThinking = content.some(c => c.type === 'thinking');

    let textChars = 0;
    let thinkChars = 0;
    let toolBlocks = 0;
    let toolTokensNew = 0; // per-block JSON-size estimate

    for (const c of content) {
      if (c.type === 'text' && c.text) {
        textChars += c.text.length;
      } else if (c.type === 'thinking' && c.thinking) {
        thinkChars += c.thinking.length;
      } else if (c.type === 'tool_use') {
        toolBlocks++;
        // Per-block estimate: JSON-serialized input payload, plus name, plus
        // ~8 tokens for the {type, id} wrapper. Rough but data-driven.
        const inputJson = JSON.stringify(c.input ?? {});
        const nameChars = (c.name ?? '').length;
        const blockTokens = Math.ceil(inputJson.length / 4) + Math.ceil(nameChars / 4) + 8;
        toolTokensNew += blockTokens;
        m.toolBlockSizes.push(blockTokens);
      }
    }

    // New estimate: per-block JSON size.
    // Legacy estimate: fixed 80 tokens per tool_use block (for sensitivity).
    const visibleEstNew = Math.ceil(textChars / 4) + toolTokensNew;
    const visibleEstLegacy = Math.ceil(textChars / 4) + (toolBlocks * 80);

    if (hasThinking) {
      m.think_calls++;
      m.think_reported_output += output;
      m.think_visible_est += visibleEstNew;
      m.think_visible_est_legacy += visibleEstLegacy;
      m.think_thinking_chars += thinkChars;
      m.think_text_chars += textChars;
      m.think_tool_blocks += toolBlocks;

      const gap = output - visibleEstNew;
      m.total_gap += gap;
      if (gap > 0) m.gap_positive++;
      else m.gap_negative++;
    } else {
      m.nothink_calls++;
      m.nothink_reported_output += output;
      m.nothink_visible_est += visibleEstNew;
      m.nothink_visible_est_legacy += visibleEstLegacy;
      m.nothink_text_chars += textChars;
      m.nothink_tool_blocks += toolBlocks;
    }
  }
}

console.error(`Loaded ${total} calls.\n`);

const focus = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

// ─── Section 1: Thinking block prevalence ──────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('  THINKING TOKEN ESTIMATION: The Invisible Quota Contributor?');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

console.log('── THINKING BLOCK PREVALENCE ──────────────────────────────────────────\n');
console.log('  Month    |  Total |  w/Thinking | % w/Thinking | Avg Think Chars | Avg Text Chars');
console.log('  ---------|--------|-------------|--------------|-----------------|---------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const avgThinkChars = d.think_calls > 0 ? Math.round(d.think_thinking_chars / d.think_calls) : 0;
  const avgTextChars = d.think_calls > 0 ? Math.round(d.think_text_chars / d.think_calls) : 0;
  console.log(`  ${m}  | ${pad(d.total_calls, 6)} | ${pad(d.think_calls, 11)} | ${pad(pct(d.think_calls, d.total_calls), 12)} | ${pad(avgThinkChars, 15)} | ${pad(avgTextChars, 14)}`);
}

// ─── Section 2: Output token gap analysis ──────────────────────────────────
console.log('\n── OUTPUT TOKEN GAP: Reported vs Visible Estimate ────────────────────\n');
console.log('  For calls WITH thinking blocks:');
console.log('  If reported output_tokens >> visible estimate, the gap = thinking tokens.\n');

console.log('  Month    | Think Calls | Reported Output | Visible Est   | Gap (think?)  | Avg Gap/Call | Gap+ | Gap-');
console.log('  ---------|-------------|-----------------|---------------|---------------|-------------|------|-----');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  if (d.think_calls === 0) {
    console.log(`  ${m}  | ${pad(0, 11)} | ${pad('N/A', 15)} | ${pad('N/A', 13)} | ${pad('N/A', 13)} | ${pad('N/A', 11)} | ${pad('N/A', 4)} | N/A`);
    continue;
  }
  const gap = d.think_reported_output - d.think_visible_est;
  const avgGap = avg(gap, d.think_calls);
  console.log(`  ${m}  | ${pad(d.think_calls, 11)} | ${pad(fmtM(d.think_reported_output), 15)} | ${pad(fmtM(d.think_visible_est), 13)} | ${pad(fmtM(gap), 13)} | ${pad(avgGap, 11)} | ${pad(d.gap_positive, 4)} | ${pad(d.gap_negative, 4)}`);
}

console.log('\n  For calls WITHOUT thinking blocks (control group):');
console.log('  Month    | Calls       | Reported Output | Visible Est   | Gap           | Avg Gap/Call');
console.log('  ---------|-------------|-----------------|---------------|---------------|------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const gap = d.nothink_reported_output - d.nothink_visible_est;
  const avgGap = avg(gap, d.nothink_calls);
  console.log(`  ${m}  | ${pad(d.nothink_calls, 11)} | ${pad(fmtM(d.nothink_reported_output), 15)} | ${pad(fmtM(d.nothink_visible_est), 13)} | ${pad(fmtM(gap), 13)} | ${pad(avgGap, 11)}`);
}

// ─── Section 3: Thinking token quota impact ────────────────────────────────
console.log('\n── THINKING TOKEN QUOTA IMPACT ─────────────────────────────────────────\n');
console.log('  If the gap represents thinking tokens, and they carry 5x output weight:\n');

console.log('  Month    | Gap Tokens  | Gap * 5x Weight | Total Quota(1x) | Gap % of Quota');
console.log('  ---------|-------------|-----------------|-----------------|---------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const gap = Math.max(0, d.think_reported_output - d.think_visible_est);
  const gapQuota = gap * 5;
  const totalQuota = d.input * 1 + d.cache_create * 1 + (d.think_reported_output + d.nothink_reported_output) * 5 + d.cache_read * 1;
  console.log(`  ${m}  | ${pad(fmtM(gap), 11)} | ${pad(fmtM(gapQuota), 15)} | ${pad(fmtM(totalQuota), 15)} | ${pad(pct(gapQuota, totalQuota), 14)}`);
}

// ─── Section 4: Per-call thinking content analysis ─────────────────────────
console.log('\n── THINKING CONTENT ANALYSIS ───────────────────────────────────────────\n');
console.log('  Are thinking blocks empty (just signatures) or do they contain real text?\n');

for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  if (d.think_calls === 0) continue;

  const avgThinkChars = Math.round(d.think_thinking_chars / d.think_calls);
  const avgThinkTokensEst = Math.round(avgThinkChars / 4);
  const avgReported = avg(d.think_reported_output, d.think_calls);
  const thinkPctOfReported = avgReported > 0 ? (avgThinkTokensEst / avgReported * 100).toFixed(1) : '0.0';

  console.log(`  ${m}:`);
  console.log(`    Avg thinking block chars: ${avgThinkChars} (~${avgThinkTokensEst} tokens)`);
  console.log(`    Avg reported output_tokens: ${avgReported}`);
  console.log(`    Thinking chars as % of reported output: ${thinkPctOfReported}%`);
  console.log(`    Avg tool_use blocks per thinking call: ${(d.think_tool_blocks / d.think_calls).toFixed(1)}`);
  console.log();
}

// ─── Section 4b: Tool_use token estimate sensitivity ───────────────────────
console.log('── TOOL_USE ESTIMATE SENSITIVITY (legacy 80/block vs per-block JSON) ──\n');
console.log('  ArkNill flagged the fixed 80-token assumption. This table shows the');
console.log('  gap under both formulas. If the verdict (gap small/moderate/large)');
console.log('  doesn\'t shift between columns, the estimate is robust.\n');

console.log('  Month    | Reported    | Est (new)   | Est (legacy) | Gap (new)   | Gap (legacy) | Gap% (new) | Gap% (legacy)');
console.log('  ---------|-------------|-------------|--------------|-------------|--------------|-----------|--------------');
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  const reported = d.think_reported_output + d.nothink_reported_output;
  const estNew = d.think_visible_est + d.nothink_visible_est;
  const estLeg = d.think_visible_est_legacy + d.nothink_visible_est_legacy;
  const gapN = reported - estNew;
  const gapL = reported - estLeg;
  const gapNpct = reported > 0 ? (gapN / reported * 100).toFixed(1) + '%' : 'N/A';
  const gapLpct = reported > 0 ? (gapL / reported * 100).toFixed(1) + '%' : 'N/A';
  console.log(`  ${m}  | ${pad(fmtM(reported), 11)} | ${pad(fmtM(estNew), 11)} | ${pad(fmtM(estLeg), 12)} | ${pad(fmtM(gapN), 11)} | ${pad(fmtM(gapL), 12)} | ${pad(gapNpct, 9)} | ${pad(gapLpct, 12)}`);
}

// Distribution of per-block tool_use token estimates
const allBlockSizes = [];
for (const m of focus) {
  if (!monthly[m]) continue;
  allBlockSizes.push(...monthly[m].toolBlockSizes);
}
if (allBlockSizes.length) {
  allBlockSizes.sort((a, b) => a - b);
  const p = (q) => allBlockSizes[Math.min(allBlockSizes.length - 1, Math.floor(q * allBlockSizes.length))];
  const mean = Math.round(allBlockSizes.reduce((s, x) => s + x, 0) / allBlockSizes.length);
  console.log('\n  Per-block tool_use token distribution (new formula):');
  console.log(`    n=${allBlockSizes.length}  mean=${mean}  p10=${p(0.1)}  p50=${p(0.5)}  p90=${p(0.9)}  p99=${p(0.99)}  max=${allBlockSizes[allBlockSizes.length - 1]}`);
  console.log(`    Legacy assumed 80 for every block. Actual tool_use blocks vary`);
  console.log(`    across ~2 orders of magnitude — small Reads vs large Edits.`);
}

// ─── Section 5: ArkNill blind spot cross-reference ─────────────────────────
console.log('\n── ArkNill BLIND SPOT CROSS-REFERENCE ─────────────────────────────────\n');
console.log('  ArkNill found output per 1% = 9K-16K tokens (from proxy response bodies).');
console.log('  Question: does usage.output_tokens include thinking, or is thinking separate?\n');

// Estimate: use the gap ratio to infer
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  if (d.think_calls === 0) continue;

  const totalReported = d.think_reported_output + d.nothink_reported_output;
  const totalVisibleEst = d.think_visible_est + d.nothink_visible_est;
  const totalGap = totalReported - totalVisibleEst;
  const gapPct = totalReported > 0 ? (totalGap / totalReported * 100).toFixed(1) : '0.0';

  console.log(`  ${m}: reported=${fmtM(totalReported)}, visible_est=${fmtM(totalVisibleEst)}, gap=${fmtM(totalGap)} (${gapPct}% of reported)`);
}

console.log('\n  If gap is small (<20%): output_tokens ≈ visible output. Thinking is separate.');
console.log('  If gap is large (>50%): output_tokens INCLUDES thinking. Thinking is a major hidden cost.');

// ─── Section 6: Key findings ───────────────────────────────────────────────
console.log('\n── KEY FINDINGS ────────────────────────────────────────────────────────\n');

// Compute overall gap ratio
let totalReported = 0, totalVisibleEst = 0;
for (const m of focus) {
  if (!monthly[m]) continue;
  const d = monthly[m];
  totalReported += d.think_reported_output + d.nothink_reported_output;
  totalVisibleEst += d.think_visible_est + d.nothink_visible_est;
}
const overallGap = totalReported - totalVisibleEst;
const overallGapPct = (overallGap / totalReported * 100).toFixed(1);

console.log(`  1. Overall gap between reported output and visible estimate: ${fmtM(overallGap)} (${overallGapPct}%)`);
console.log();

if (parseFloat(overallGapPct) < 20) {
  console.log('  2. The gap is SMALL. This means output_tokens closely matches visible output.');
  console.log('     Thinking tokens are likely NOT included in output_tokens.');
  console.log('     They may be billed separately or not billed at all.');
} else if (parseFloat(overallGapPct) > 50) {
  console.log('  2. The gap is LARGE. output_tokens likely INCLUDES thinking tokens.');
  console.log('     Thinking is a major hidden cost in the quota formula.');
} else {
  console.log('  2. The gap is MODERATE. Thinking tokens may be partially included.');
  console.log('     The estimate is rough (4 chars/token assumption), so error bars are wide.');
}

console.log();
console.log('  3. CAVEAT: The visible-output estimate uses 4 chars/token for text, and');
console.log('     per-block JSON-size/4 + 8 for tool_use (new in v2, replaces fixed 80).');
console.log('     Real tokenization varies. See "TOOL_USE ESTIMATE SENSITIVITY" above —');
console.log('     the gap verdict can shift between formulas in some months.');
