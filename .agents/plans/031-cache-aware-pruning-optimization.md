---
name: 031-cache-aware-pruning-optimization
description: Use pruneable raw-token savings as the automatic prune threshold.
steps:
  - phase: evidence
    steps:
      - "- [x] step 1: inspect cache export `2026-06-29T12-47-38-343Z_019f136b-c767-7f46-81d4-2ca56fc9f87e.csv`"
      - "- [x] step 2: correlate cache rows with the matching session JSONL and pruner diagnostics"
  - phase: design
    steps:
      - "- [x] step 1: choose pruneable raw-token savings as the automatic prune trigger"
      - "- [x] step 2: exclude protected-tail and `preserveToolResults` matches from the threshold"
  - phase: implementation
    steps:
      - "- [x] step 1: update the guard to count only pruneable raw tokens"
      - "- [x] step 2: remove or demote the pure tool-count trigger"
  - phase: validation
    steps:
      - "- [x] step 1: add guard tests for pruneable and non-pruneable tokens"
      - "- [x] step 2: run the repo validation command"
---

# 031-cache-aware-pruning-optimization

## Goal

Optimize `extensions/pi-context-prune/` with one simple rule: automatic pruning
should run when pruneable raw tool-result tokens reach a threshold. Tokens that
will not be removed must not count toward that threshold.

## Evidence from session `019f136b-c767-7f46-81d4-2ca56fc9f87e`

Source cache export:

`/home/sylv/work/secunet/vbox-eval/git/linux-vbox-windows-perf/2026-06-29T12-47-38-343Z_019f136b-c767-7f46-81d4-2ca56fc9f87e.csv`

Matching session file:

`/home/sylv/.pi/agent/sessions/--home-sylv-work-secunet-vbox-eval-git-linux-vbox-windows-perf--/2026-06-29T12-47-38-343Z_019f136b-c767-7f46-81d4-2ca56fc9f87e.jsonl`

Summary:

- 62 assistant requests.
- Total prompt tokens: 2,863,635.
- Total cache-hit tokens: 2,429,440.
- Weighted cache-hit rate: 84.84%.
- Complete cache misses occurred at assistant request 1, 3, and 19.
- Request 1 is expected for a cold session.
- Request 3 happened before any successful `context-prune-summary` entry
  existed, so that miss is not caused by pruning.
- Request 19 happened after the first prune but before a new successful prune.
  It followed a user correction and a `memory` tool call. Treat it as a
  provider or prompt-construction instability until a request fingerprint
  proves otherwise.

Successful prune diagnostics in this session:

| Time | Tools | Raw chars | Raw tokens | Repl chars | Repl tokens |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12:49:47 | 24 | 105,442 | 25,799 | 3,729 | 1,114 |
| 14:21:38 | 6 | 45,390 | 10,630 | 1,166 | 327 |
| 14:32:07 | 23 | 86,612 | 21,725 | 3,408 | 1,191 |

Cache behavior around the first prune:

| Request | Context event | Prompt tokens | Cache-hit tokens | Hit rate |
| ---: | --- | ---: | ---: | ---: |
| 12 | before first prune | 47,320 | 43,008 | 90.9% |
| 13 | before first prune | 47,422 | 47,104 | 99.3% |
| 14 | before first prune | 47,476 | 47,104 | 99.2% |
| 15 | final answer after summary insertion | 47,541 | 47,104 | 99.1% |
| 16 | next user turn after pruning applies | 36,051 | 18,432 | 51.1% |
| 17 | next user turn | 36,292 | 18,432 | 50.8% |
| 18 | next user turn | 33,207 | 18,432 | 55.5% |

Interpretation:

- The first prune saved a large amount of raw context, but the next request
  reused only the static early prefix, about 18k tokens, instead of the previous
  47k-token prefix.
- This is the expected cache cost of replacing old raw tool results with
  summaries. It is not always a total miss, but it can collapse cache reuse to
  the system and tool-definition prefix.
- Complete misses also occur before pruning in this and another observed
  session (`019f175b-a99c-7cb6-bb01-460f94a543f4`, where requests 1, 2, and 4
  missed). Do not attribute every zero-hit row to `pi-context-prune` without
  request fingerprinting.
- Later in the session the cache recovers well. Requests after 50 have a
  weighted hit rate of about 94.67%.

## Working hypotheses

1. **Pruning has a predictable one-time cache cost.** Removing indexed
   `toolResult` messages and inserting compact summaries changes the
   model-facing prefix. The next request may reuse only the stable system and
   tool prefix until the shortened context warms again.
2. **Large prunes are still worthwhile.** The context saved by pruning applies
   to every future request on the branch. In this session, the first successful
   prune saved about 24.7k net tokens per future request.
3. **The current guard should count pruneable raw tokens.** A pure tool-count
   trigger is too indirect. The threshold should use the estimated tokens of
   tool results that will actually be removed.

## Proposed design change

### Prune when pruneable raw tokens reach the threshold

Use one main automatic trigger:

```ts
pruneableRawTokens >= minPruneRawTokens
```

`pruneableRawTokens` is the sum of estimated tokens for tool results that are
actually eligible for removal. Do not count:

- already-pruned tool results;
- tool results in the protected tail;
- tool results matched by `preserveToolResults`;
- `context_prune` housekeeping calls.

If the sum is below `minPruneRawTokens`, keep the pending batches queued. Later
tool calls can push the same accumulated eligible set over the threshold. Once a
protected-tail result ages out of the tail, it may count toward a later prune if
it is not preserved by `preserveToolResults`.

Keep `agent-message` batching. Do not add cache policies, request-shape hashes,
or context-pressure gates unless later evidence shows they are needed.

## Validation plan

1. Add or update guard tests:
   - below `minPruneRawTokens`: skip and keep pending batches;
   - protected-tail tokens alone reach the threshold: skip;
   - `preserveToolResults` tokens alone reach the threshold: skip;
   - pruneable tokens reach the threshold: prune;
   - mixed pruneable and non-pruneable tokens: count only pruneable tokens.
2. Run `npm run validate` in `extensions/pi-context-prune/`.

## Open questions

- What default `minPruneRawTokens` gives the best simple tradeoff for typical
  Pi sessions?
