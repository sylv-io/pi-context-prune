# Context Management Evaluation Runbook

## Purpose

Use this runbook to collect real-session samples after the first pruning
optimization pass. The goal is to measure whether the new settings reduce raw
context without causing obvious relevance or recovery regressions.

This is an observation workflow. Do not treat one session as proof. Compare
several similar sessions before changing thresholds or pruning architecture.

## Current evaluation scope

The active first-pass settings are:

```json
{
  "pruneOn": "agent-message",
  "batchingMode": "agent-message",
  "protectedTailTokens": 16000,
  "minPruneRawTokens": 4000,
  "minPruneToolCalls": 8
}
```

The main questions are:

- Are small, low-value prune attempts skipped?
- Do meaningful batches still prune automatically?
- Does the lower protected tail reduce retained raw context in practice?
- Can older outputs still be recovered with `context_tree_query` when needed?
- Are there visible relevance regressions that suggest reverting to `24000`?

## When to collect a sample

Collect a sample after a normal session that has enough tool activity to matter.
Good candidates include:

- implementation or debugging sessions with at least one successful prune
- sessions that read large docs, logs, build output, or search results
- sessions where the context grows large enough that pruning should help
- sessions where the agent needed to recover pruned data with
  `context_tree_query`

Skip tiny sessions that only produce a few small tool results unless the point
is to validate below-threshold skip behavior.

## Minimal assisted workflow

For normal evaluation, the user should only provide a session ID, a
`session.jsonl` path, or say that the latest session should be evaluated. The
assistant collects the session file, the current configuration, matching cache
CSVs, and commit IDs. Then the assistant writes the sample notes and reports the
results.

Useful prompts:

```text
Evaluate pruning for the latest session.
Evaluate pruning for session <session-id>.
Evaluate pruning for /path/to/session.jsonl.
```

Use the manual commands below only when working without an assistant or when
checking the exact contents collected.

## Before starting the session

Record the active configuration and code version:

```bash
cd ~/.pi/agent
mkdir -p /tmp/pi-context-prune-samples
cp context-prune/settings.json /tmp/pi-context-prune-samples/settings-before.json

git rev-parse HEAD > /tmp/pi-context-prune-samples/pi-agent-head.txt
git -C extensions/pi-context-prune rev-parse HEAD \
  > /tmp/pi-context-prune-samples/pi-context-prune-head.txt
```

Start a fresh Pi session when possible. Fresh sessions reduce noise from old
frontier and index state.

## During the session

Use Pi normally. Do not force pruning unless the sample is specifically about
manual behavior.

Useful manual checks:

```text
/pruner status
/pruner diagnostics
/pruner stats
```

If a summary references a needed raw output, recover it with:

```text
context_tree_query({ toolCallIds: ["<ref>"] })
```

Record whether recovery was enough for the task. Note any truncation that
changed the answer or forced an extra read/search.

## After the session

Find the session file:

```bash
find ~/.pi/agent/sessions -name session.jsonl -printf '%T@ %p\n' \
  | sort -nr \
  | head -20
```

Copy the relevant session file and config into a sample directory:

```bash
sample_dir=/tmp/pi-context-prune-samples/$(date +%Y%m%d-%H%M%S)
mkdir -p "$sample_dir"
cp /path/to/session.jsonl "$sample_dir/session.jsonl"
cp ~/.pi/agent/context-prune/settings.json "$sample_dir/settings.json"
git -C ~/.pi/agent rev-parse HEAD > "$sample_dir/pi-agent-head.txt"
git -C ~/.pi/agent/extensions/pi-context-prune rev-parse HEAD \
  > "$sample_dir/pi-context-prune-head.txt"
```

If a cache CSV exists for the same session, copy it too:

```bash
session_id=<session-id>
cp ~/.pi/agent/*"$session_id"*.csv "$sample_dir/" 2>/dev/null || true
```

Do not commit raw session files or cache exports. They can contain prompts,
paths, tool outputs, and other local data.

## Cleanup and retention

Keep raw samples only as long as they are needed for analysis. After extracting
sanitized notes or aggregate numbers, delete the copied raw artifacts:

```bash
rm -rf "$sample_dir"
```

If a raw sample must be kept for comparison, leave it outside the repository,
record why it is being kept in `notes.md`, and delete it after the follow-up
comparison is complete. Prefer sanitized notes or tables for durable records.

## What to record

Create a short note beside the sample:

```bash
cat > "$sample_dir/notes.md" <<'EOF'
# Pruning sample notes

- Date:
- Session ID:
- Task type:
- Pruner commit:
- Pi agent commit:
- Config summary:
  - protectedTailTokens:
  - minPruneRawTokens:
  - minPruneToolCalls:
  - project override present:
- Prune attempts:
- Successful prunes:
- Below-threshold skips:
- Raw chars/tokens pruned:
- Replacement chars/tokens:
- Max prompt tokens, if known:
- Final prompt tokens, if known:
- context_tree_query recoveries:
- Recovery truncation or failures:
- Visible relevance regressions:
- Follow-up decision:
EOF
```

Use `/pruner diagnostics` for prune attempts, skipped attempts, raw size, and
replacement size. Use cache CSVs or context tooling for prompt-size and cache
metrics when available.

## Interpreting samples

Keep the first evaluation simple:

- If many attempts are skipped but pending batches later prune successfully,
  the guard is doing its job.
- If meaningful sessions still produce frequent tiny prunes, raise
  `minPruneRawTokens` or `minPruneToolCalls` only after several samples.
- If large outputs stay raw too long and prompt size remains high, consider an
  adaptive trigger only after diagnostics show repeated high peaks.
- If the model repeatedly needs raw docs and `context_tree_query` recovery is
  insufficient, evaluate a targeted recovery improvement before restoring broad
  docs preservation.
- If relevance suffers soon after reducing the protected tail, compare with a
  temporary `protectedTailTokens: 24000` run before deciding to revert.

## Suggested sample table

Track real sessions in a small table. Keep raw artifacts outside the repository
unless a sanitized fixture is intentionally created.

| Date | Session | Task type | Config | Attempts | Pruned | Skipped | Raw -> replacement | Recoveries | Relevance notes | Decision |
|---|---|---|---|---:|---:|---:|---|---:|---|---|
| TBD | TBD | TBD | 16k / 4k / 8 | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Future decisions to revisit

Revisit these only after several real samples:

1. Whether `protectedTailTokens: 16000` should stay or revert to `24000`.
2. Whether the prune guard thresholds need tuning.
3. Whether long autonomous runs need a threshold-based early trigger.
4. Whether recovery needs a larger or smarter raw-output retrieval path.
5. Whether summary architecture work is justified by persistent cache churn.
