# Context Management Optimization Plan

## Status

- Owner: TBD
- Scope: `pi-context-prune`
- Source session: `019f03ac-1d93-7308-beae-1bc80133ad5f`
- Cache export: `/home/sylv/.pi/agent/2026-06-26T11-23-59-251Z_019f03ac-1d93-7308-beae-1bc80133ad5f.csv`
- State: planning only. No implementation is approved by this document.

## Goal

Improve context management with a reliable and simple approach. The extension
should prune stale tool output, keep recent evidence available while it is still
useful, and expose enough measurements to tune behavior without adding a large
new policy system.

## Guiding principles

- Prefer small, reversible changes over new architecture.
- Keep the current placeholder strategy and agent-message trigger.
- Measure the direct pruning effect first. Avoid claiming cache causality from
  correlation alone.
- Add only the diagnostics needed to make tuning decisions.
- Keep recovery through `context_tree_query`, but do not assume recovery is
  equivalent to preserving full raw output.
- Use project-local experiments for settings that could affect unrelated work.

## Baseline findings

The analyzed session showed that the current approach reduces context size well,
but it does not guarantee stable prompt-cache hits.

Observed baseline:

- Assistant/model calls: 215
- Tool results in the session: 291
- Prune events: 19
- Indexed/pruned tool results: 240
- Preserved or otherwise unpruned tool results: 51
- Raw tool output pruned: about 851,766 chars
- Replacement summary/placeholder text: about 42,534 chars
- Approximate compression: 95% by chars
- Estimated net token reduction: about 202k tokens, based on the configured
  character-per-token estimator
- Maximum prompt size: 181,391 tokens
- Final prompt size: 132,721 tokens
- Weighted cache hit rate: 81.77%
- Median per-call cache hit rate: 99.09%

Interpretation:

- `pi-context-prune` is effective at removing raw tool-output bulk.
- The next model call after pruning often has lower cache reuse because pruning
  changes earlier context.
- Cache misses are not always caused by pruning. Other causes include provider
  cache TTL, backend routing, large dynamic suffix growth, subagent/control
  messages, and preserved instruction or documentation reads.

## Captured decisions

These decisions came from the follow-up planning prompt and the later request to
avoid overengineering.

- Diagnostics: add minimal runtime diagnostics first. Defer a full external
  analyzer until manual analysis becomes painful.
- Minimum prune guard: use a simple combined guard based on raw-token threshold
  or tool-count threshold.
- Protected tail: test `protectedTailTokens: 16000` through a project-scope
  override, not a global setting change.
- Preserve rules: preserve instruction-file reads only. Keep non-read preserve
  rules unchanged.
- Adaptive trigger: keep `agent-message`; do not add an adaptive threshold
  trigger yet.
- Stable summary architecture: defer rolling summaries, delayed insertion, and
  retrieval-only mode.

## Non-goals for the first pass

- Do not replace the placeholder strategy.
- Do not switch to `agentic-auto`.
- Do not add adaptive pruning triggers.
- Do not build replay tooling.
- Do not build a full cache-correlation analyzer yet.
- Do not add stable rolling summaries or retrieval-only mode.
- Do not claim cache-hit causality from correlation data alone.
- Do not remove recovery through `context_tree_query`.

## Reviewer findings incorporated

The plan was reviewed by three read-only subagents. The revised approach keeps
only the findings needed for a practical first pass.

- `/pruner now` force semantics must be explicit before adding a guard.
- Below-threshold skips must not advance the prune frontier.
- Diagnostics should be append-only custom entries that do not enter model
  context.
- The protected-tail experiment must be project-local and should use fresh
  sessions where possible.
- Removing broad docs preservation is a fidelity tradeoff because
  `context_tree_query` may truncate large recovered outputs.
- Preserve-rule changes should narrow read-tool doc globs only. They should not
  remove preserve rules for tools such as `todo`, `memory`, `AskUserQuestion`,
  or `context_tree_query`.

## Workstream 1: Minimal diagnostics

### Diagnostics objective

Make pruning behavior visible without creating a large diagnostics subsystem.

### Diagnostics decision

Add one append-only diagnostic custom entry per prune attempt:

```text
CUSTOM_TYPE_DIAGNOSTIC
```

The entry must not be added to model context. It should be session metadata only.

### Fields

Keep the first version small:

- timestamp
- trigger mode
- prune strategy
- batching mode
- `protectedTailTokens`
- attempted batch count
- eligible tool-call count
- pruned tool-call count
- raw chars and estimated raw tokens pruned
- replacement chars and estimated replacement tokens
- skip reason, if pruning did not run
- frontier entry ID, when a frontier entry is written

### Command behavior

Add a simple `/pruner diagnostics` command that prints recent diagnostic entries
and cumulative totals. It does not need filtering, export formats, charts, or a
separate report generator in the first pass.

### Diagnostics baseline TODOs

- [x] Add `CUSTOM_TYPE_DIAGNOSTIC` and a small `PruneDiagnostic` type.
- [x] Append one diagnostic entry for each prune attempt or below-threshold skip.
- [x] Ensure diagnostic entries do not enter the `context` message array.
- [x] Add `/pruner diagnostics` with recent entries and cumulative totals.
- [x] Show enough data to answer what was pruned or skipped.
- [ ] Validate against the baseline session numbers where practical.

### Diagnostics acceptance criteria

- Diagnostics do not change model-facing context.
- A below-threshold skip is visible in diagnostics.
- A successful prune records pruned raw size and replacement size.
- `/pruner diagnostics` is understandable without an external analyzer.

## Workstream 2: Simple minimum prune guard

### Guard objective

Avoid cache churn from small prune events that save little context.

### Guard decision

Use one combined guard:

```text
prune if estimatedRawTokens >= minPruneRawTokens
   OR eligibleToolCalls >= minPruneToolCalls
```

Recommended starting defaults:

```json
{
  "minPruneRawTokens": 4000,
  "minPruneToolCalls": 8
}
```

The threshold values are starting points. They should be adjusted after real
usage, not treated as permanent constants.

### Eligibility definition

The guard should run on the batches that would actually be pruned:

- already indexed results removed
- preserve-rule matches removed
- frontier-past results removed
- batching mode already applied

In code terms, apply the guard to the output of the existing pending-batch
capture path, not to raw turn counts.

### Manual command behavior

Keep the behavior predictable:

- Automatic pruning respects the guard.
- `/pruner now` respects the guard and reports below-threshold state.
- `/pruner now --force` bypasses the guard.
- A below-threshold skip keeps the batch pending.
- A below-threshold skip must not advance the frontier.

### Guard baseline TODOs

- [x] Add `minPruneRawTokens` and `minPruneToolCalls` to config.
- [x] Add one small helper that decides whether a batch set is worth pruning.
- [x] Add `force?: boolean` to the flush path.
- [x] Add `/pruner now --force`.
- [x] Ensure below-threshold skips happen before summary generation, indexing,
      and frontier updates.
- [x] Record guard skips in diagnostics.
- [x] Add a small validation script or test for tiny batch, huge single output,
      many small outputs, force mode, and frontier unchanged on skip.

### Guard acceptance criteria

- Small automatic prune attempts are skipped and remain pending.
- A huge single tool result can still be pruned.
- Many related small tool calls can still be pruned.
- `/pruner now --force` can flush a below-threshold batch.
- The frontier is unchanged after a below-threshold skip.

## Workstream 3: Project-local protected-tail experiment

### Protected-tail objective

Reduce retained raw context while keeping recent tool evidence available.

### Protected-tail decision

Test `protectedTailTokens: 16000`, but only as a project-scope override.

Do not change the global config for this experiment.

### Plan

- Add or modify the project-local config under `.pi/context-prune/settings.json`.
- Set `protectedTailTokens` to `16000` for this project only.
- Prefer fresh sessions for comparison so old frontier/index state does not
  contaminate the result.
- Compare normal usage against the current `24000` baseline.

### Metrics

Keep metrics simple:

- maximum prompt tokens
- final prompt tokens
- prune count
- raw chars protected by tail
- visible relevance regressions
- number of times `context_tree_query` is needed

Cache-hit percentage can be recorded, but it should not be the sole success
metric because suffix size changes the denominator.

### Protected-tail baseline TODOs

- [x] Record `protectedTailTokens` in diagnostics.
- [x] Add a project-scope override for `16000` only when this experiment is
      approved.
- [x] Use a reloaded session for initial observation.
- [x] Compare prompt size and obvious relevance behavior.
- [ ] Revert to `24000` if relevance suffers.

### Protected-tail acceptance criteria

- The experiment does not change global behavior outside this project.
- `16000` reduces protected raw context or prompt size in comparable usage.
- The model can still recover older output with `context_tree_query` when needed.
- Any relevance regression is documented and used to decide whether to revert.

## Workstream 4: Narrow read-tool preserve rules

### Preserve-rules objective

Stop broad documentation reads from staying in raw context indefinitely.

### Preserve-rules decision

Preserve instruction-file reads only. Keep non-read preserve rules unchanged.

Instruction-file read globs should include:

```json
"**/skills/**/*.md",
"**/SKILL.md",
"**/AGENTS.md"
```

Remove broad generic documentation globs from the active project config, such as:

```json
"**/docs/*.md",
"**/docs/**/*.md",
"**/docs/README.md",
"**/docs/**/README.md"
```

### Recovery caveat

This is a deliberate tradeoff. Large docs that are no longer preserved may be
recoverable through `context_tree_query`, but recovery can be truncated. If this
causes real quality problems, address that later with a focused improvement to
recovery, not by keeping every docs read raw by default.

The config change affects future reads. It does not retroactively index docs
that were preserved before the change.

### Preserve-rules baseline TODOs

- [x] Confirm the effective preserve rules from global and project scope.
- [x] Remove only broad read-tool docs globs from the active project config.
- [x] Keep instruction-file read globs.
- [x] Keep non-read tool preserve rules unchanged.
- [ ] Defer preserve-rule match counts until diagnostics need more detail.
- [x] Manually verify that a newly read generic doc can be pruned and recovered
      well enough for normal use.

### Preserve-rules acceptance criteria

- Large generic docs are no longer permanently preserved as raw tool output.
- `AGENTS.md`, `SKILL.md`, and skill instruction files remain preserved.
- Tool-state preserve rules for non-read tools remain unchanged.
- The plan explicitly accepts that recovered large docs may be truncated.

## Workstream 5: Keep `agent-message` trigger

### Trigger objective

Avoid adding mid-run pruning until simpler changes have been measured.

### Trigger decision

Keep `pruneOn: "agent-message"`.

### Rationale

`agent-message` avoids pruning after every tool turn. It usually changes context
once after a final assistant response, which should be less disruptive to prompt
cache than frequent pruning.

The analyzed session did show large prompt peaks, but the first pass should use
minimal diagnostics, a simple guard, a smaller project-local protected tail, and
narrower preserve rules before adding another trigger.

### Trigger baseline TODOs

- [x] Keep the current trigger mode unchanged.
- [x] Use diagnostics to see whether long autonomous runs still exceed the
      desired prompt-size budget.
- [ ] Revisit threshold-based early pruning only if large peaks remain.

### Trigger acceptance criteria

- The default trigger remains stable while other changes are evaluated.
- Any future adaptive trigger proposal is based on post-change evidence.

## Workstream 6: Defer summary architecture redesign

### Summary-architecture objective

Avoid complex context architecture work before simpler changes are tested.

### Summary-architecture decision

Defer these ideas:

- stable rolling summary block
- delayed summary insertion
- retrieval-only pruning
- prefix-stable summary placement
- external replay tooling
- full cache-correlation analyzer

### Summary-architecture baseline TODOs

- [ ] Do not implement stable summary placement in the first pass.
- [ ] Track whether cache misses remain severe after Workstreams 1 through 5.
- [ ] Reopen this workstream only with fresh diagnostics and a clear problem
      statement.

### Summary-architecture acceptance criteria

- The first implementation pass remains small and reversible.
- Future architecture work has concrete context and cache evidence.

## Suggested implementation order

1. Add minimal diagnostics.
2. Add the simple minimum prune guard.
3. Narrow read-tool preserve rules in project config.
4. Test `protectedTailTokens: 16000` in project config.
5. Observe real usage.
6. Revisit analyzer, adaptive trigger, or recovery improvements only if needed.

## Validation checklist

For each implemented workstream:

- [x] Run any available TypeScript or project validation.
- [x] Add a focused script or test when no validation exists.
- [ ] Run the extension in a short session with several tool calls.
- [ ] Confirm pruned output can be recovered with `context_tree_query`.
- [ ] Confirm diagnostics do not enter model-facing context.
- [ ] Confirm frontier behavior after below-threshold skips.
- [ ] Compare against the baseline session metrics in this document when relevant.

## Approval gate

This plan records decisions and TODOs only. Implementation requires explicit
approval for the selected workstream or group of workstreams.

Workstreams 3 and 4 change model-facing context behavior through configuration.
They should receive separate approval or be included explicitly in a named
approved batch.
