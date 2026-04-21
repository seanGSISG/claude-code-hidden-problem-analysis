# Analysis scripts

Self-contained Node.js scripts used for the 179K-call analysis in [issue #3 of ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis/issues/3). Point them at your own `~/.claude/projects` directory and reproduce the results on your own data.

## Dataset shape expected

The scripts read every `*.jsonl` file under a `projects/` directory (symlink your `~/.claude/projects` here, or edit `PROJECTS_DIR` in each script). Claude Code writes one JSONL per session, one line per record. The scripts look for `assistant` records with a `usage` object and a `timestamp`:

```jsonc
{
  "type": "assistant",
  "timestamp": "2026-03-21T05:21:33.123Z",
  "message": {
    "model": "claude-opus-4-5",
    "content": [/* text, thinking, tool_use blocks */],
    "usage": {
      "input_tokens": 12,
      "output_tokens": 480,
      "cache_read_input_tokens": 180000,
      "cache_creation_input_tokens": 4000,
      "iterations": { /* ... */ }
    }
  }
}
```

Synthetic records (`model === "<synthetic>"`) are skipped.

## Reproducing

```bash
# Symlink or copy your logs directory under the name `projects`
ln -s ~/.claude/projects projects

# Node 18+ required (uses ESM, no dependencies)
node dual-window-simulation.mjs
node cache-read-weight-transition.mjs
node thinking-token-estimation.mjs
node iterations-window-correlation.mjs
node quota-composition-breakdown.mjs
node opus-47-comparison.mjs
```

Each script is standalone — no shared module — so you can run one without pulling the others.

## Which script answers which question

| Script | Question |
|---|---|
| `dual-window-simulation.mjs` | For each 5-hour window in your history, what would your ArkNill-style utilization be under `cache_read=0x` vs `cache_read=1x`? (Uses sliding windows as primary, tumbling retained for comparison.) |
| `cache-read-weight-transition.mjs` | Does the data support the claim that `cache_read` weight shifted from ~0x to ~1x? Leads with the counterfactual: days exceeding budget under each formula. |
| `thinking-token-estimation.mjs` | How big is the gap between reported `output_tokens` and the visible content we can see in JSONL? Bounds the hidden thinking-token contribution. Includes a sensitivity pass comparing a fixed-80 vs per-block JSON-size tool_use estimate. |
| `iterations-window-correlation.mjs` | Do calls with the `usage.iterations` field correlate with the 5-hour windows that push utilization toward rate-limit territory? |
| `quota-composition-breakdown.mjs` | Monthly breakdown of input / output / cache_read / cache_write under both quota formulas, with ArkNill's per-1% benchmarks. |
| `opus-47-comparison.mjs` | Opus 4.7 vs 4.6 per-call token multipliers and 5h window utilization. Tests the tokenizer-inflation and Q5h-burn claims from `16_OPUS-47-ADVISORY.md`. Small sample on 4.7 side; see sample-output for caveats. |

## `sample-output/`

Captured stdout from running each script against our 178K-call, 5,605-file dataset (Dec 23 2025 – Apr 11 2026). Read these if you don't have the raw logs.

## Changelog

### v2.1 (2026-04-21) — Opus 4.7 comparison added

- `opus-47-comparison.mjs` — partitions calls by model, compares 4.6 vs 4.7 on per-call token averages, quota-per-call, iter share, and 5h window utilization. Built to test claims from `16_OPUS-47-ADVISORY.md` against client-side JSONL data. Early-window: n=2,615 on 4.7 side, directional only.

### v2 (2026-04-21) — ArkNill review response

Incorporates feedback from [issue-3 comment](https://github.com/ArkNill/claude-code-hidden-problem-analysis/issues/3#issuecomment-):

- `dual-window-simulation.mjs` — added sliding-window pass (15-minute step, two-pointer sweep). Sliding is now the primary reporter; tumbling retained for comparison. Peak utilization numbers are higher under sliding because spikes that straddled tumbling boundaries are now captured.
- `cache-read-weight-transition.mjs` — reordered to lead with the counterfactual (days exceeding budget under each weight), demoted transition-detection / ratio-trend to supporting-evidence sections. Logic unchanged.
- `thinking-token-estimation.mjs` — replaced fixed 80-tokens-per-tool_use with per-block `JSON.stringify(input).length / 4 + name_chars/4 + 8`. Added a sensitivity section showing old-vs-new gap side-by-side. Per-block distribution has p50=44, p90=221, p99=3041, max=23796 — the old fixed 80 was a poor approximation.
- `iterations-window-correlation.mjs` — new script, answers ArkNill's open question.
