# Project Guidance

This repository is for a Pi coding-agent extension that prunes tool-call trees before the next request is sent.

## Working style

- Keep changes small, focused, and reversible.
- Read existing files before editing them.
- Preserve user work; do not overwrite unrelated changes.
- Prefer Markdown for plans and notes, and keep code and docs aligned.

## Planning

- Use the `planning` skill for any multi-step task.
- Store plans in `.agents/plans/`.
- Use zero-padded numbered plan filenames like `000-first-plan.md`, `001-another-plan.md`, and `002-plan-more.md`.
- Keep plan checklists in sync with actual progress.

## Implementation

- When adding code, include a brief explanation of why the change exists.
- Add tests or a reproducible verification command for behavior changes when possible.

---

## Code Structure

```
pi-context-prune/
├── index.ts                       # Extension entry point — wires all modules together
├── package.json                   # Pi package manifest; declares extension at ./index.ts
└── src/
    ├── types.ts                   # Shared types, constants, and interfaces (including PruneOn modes)
    ├── config.ts                  # Load/save ~/.pi/agent/context-prune/settings.json
    ├── batch-capture.ts           # Capture turn results from events or session branch
    ├── summarizer.ts              # LLM call that summarizes a CapturedBatch to markdown
    ├── indexer.ts                 # Runtime Map<toolCallId, ToolCallRecord> + session persistence
    ├── pruner.ts                  # Filter context event messages (removes summarized ToolResultMessages)
    ├── reminder.ts                # Append <pruner-note> reminder to last toolResult (agentic-auto only)
    ├── query-tool.ts              # Register the context_tree_query tool for recovering pruned outputs
    ├── context-prune-tool.ts      # Register the context_prune tool for agentic-auto mode
    ├── tree-browser.ts            # TreeBrowser TUI component + buildPruneTree for /pruner tree
    ├── stats.ts                   # StatsAccumulator and compact progress formatting
    ├── diagnostics.ts             # Append-only prune-attempt diagnostics
    ├── frontier.ts                # Last completed prune-attempt boundary
    ├── prune-guard.ts             # Eligibility filters and minimum-size guard
    ├── placeholder.ts             # Deterministic replacement strategy
    ├── token-estimator.ts         # Protected-tail and guard token estimates
    ├── multi-batch-loader.ts      # Legacy/tested progress-overlay component
    └── commands.ts                # /pruner command, settings overlay, progress widget, renderer
```

### `index.ts` — Extension entry point

Wires all modules together and registers Pi event handlers:

- **`pendingBatches: CapturedBatch[]`** — queue of captured batches not yet summarized; drained by `flushPending`.
- **`capturePendingBatches(ctx)`** — runs capture, eligibility filtering, frontier trimming, and batching without LLM work. `/pruner now` uses the result to build progress rows before flushing.
- **`flushPending(ctx, options?)`** — filters eligible pending batches, enforces the minimum guard, produces replacements, persists accepted results, and advances the frontier after completed attempts. Summarizer mode runs one LLM call per batch in parallel by default. Passing `onProgress` uses sequential calls for `/pruner now`. Placeholder mode makes no LLM call. `FlushOptions` is `{ delivery?, onProgress?, onBatchTextProgress?, previewedBatches?, force?, signal? }`. `force` bypasses the minimum guard, and aborts restore pending work without advancing the frontier.

- **`syncToolActivation()`** — activates or deactivates the `context_prune` tool in the Pi active-tools list based on whether `enabled && pruneOn === "agentic-auto"`. Uses `pi.getActiveTools()` / `pi.setActiveTools()` (ExtensionAPI, not ExtensionContext).
- **`session_start`** — loads global config plus a project overlay only when Pi marks the project trusted, rebuilds the index, statistics, frontier, and diagnostics from the current branch, clears `pendingBatches`, updates status, and calls `syncToolActivation()`.
- **`session_tree`** — rebuilds the index, statistics, frontier, and diagnostics after branch navigation and clears pending batches from the old branch.
- **`turn_end`** — captures the batch (filtering out any `context_prune` tool call to avoid re-queuing agentic-auto housekeeping), pushes to `pendingBatches`. Behavior depends on `pruneOn` mode:
  - `every-turn`: flushes immediately with `delivery: "session"`.
  - `on-context-tag` / `on-demand` / `agent-message` / `agentic-auto`: queues and notifies the user of pending count and trigger.
- **`tool_execution_end`** — when `event.toolName === "context_tag"` and mode is `on-context-tag`, calls `flushPending` with `delivery: "runtime"`.
- **`message_end`** — when mode is `agent-message` and the message is a final text-only assistant response (no tool calls), calls `flushPending` with `delivery: "session"`. This is the primary flush path for `agent-message` mode.
- **`agent_end`** — safety net: if pending batches still remain (e.g. because no `message_end` fired before session shutdown), updates the status widget to show the pending count. Does **not** attempt a best-effort LLM call here to avoid starting async work after Pi may have already disposed the session.
- **`before_agent_start`** — when mode is `agentic-auto` and pruning is enabled, appends `AGENTIC_AUTO_SYSTEM_PROMPT` to the system prompt so the LLM knows when and how to call `context_prune`.
- **`context`** — filters the message array sent to the LLM, removing `ToolResultMessage` entries that have been summarized. Additionally, when `pruneOn === "agentic-auto"` and `remindUnprunedCount` is true, appends a `<pruner-note>` reminder to the last toolResult telling the LLM how many unpruned tool calls are currently in context. Returns `undefined` (no change) if neither pruning nor annotation modified the list.

### `src/types.ts` — Shared types and constants

Single source of truth for all interfaces and constants:

- **`CapturedBatch`** / **`CapturedToolCall`** — snapshot of one assistant turn's tool calls + results. `CapturedBatch` carries `assistantText` (any non-tool-call text from the assistant message) and an optional `userTurnGroup` field set by `captureUnindexedBatchesFromSession` to identify which user→agent span the batch belongs to (used for `agent-message` batching mode).
- **`ToolCallRecord`** — full record stored in the runtime index (includes original `resultText`).
- **`IndexEntryData`** — data shape written to session via `pi.appendEntry` for persistence across restarts.
- **`PruneOn`** — `"every-turn" | "on-context-tag" | "on-demand" | "agent-message" | "agentic-auto"` — when summarization is triggered:
  - `every-turn`: summarize after every tool-calling turn.
  - `on-context-tag`: batch turns, flush when `context_tag` is called.
  - `on-demand`: only when the user runs `/pruner now`.
  - `agent-message`: batch turns, flush when the agent sends a final text-only response (default).
  - `agentic-auto`: the LLM decides when to prune by calling the `context_prune` tool, guided by `AGENTIC_AUTO_SYSTEM_PROMPT`.
- **`BatchingMode`** — `"turn" | "agent-message"` — granularity of each pruning batch.
  - `turn`: one summary per assistant turn (default; current behavior).
  - `agent-message`: all assistant turns between two consecutive user messages are merged into a single summary.
- **`SummarizerThinking`** — `"default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` — reasoning effort level to pass to the summarizer LLM. `"default"` omits the option entirely (provider default); other values set `reasoningEffort` in the provider call options.
- **`PRUNE_ON_MODES`** — `{ value, label }` array for interactive selectors.
- **`BATCHING_MODES`** — `{ value, label }` array for interactive selectors.
- **`SUMMARIZER_THINKING_LEVELS`** — `{ value, label }` array for interactive selectors.
- **`ContextPruneConfig`** — `{ enabled, showPruneStatusLine, summarizerModel, summarizerThinking, pruneOn, pruneStrategy, remindUnprunedCount, batchingMode, preserveToolResults, protectedTailTokens, tokenEstimator, tokenizerEncoding, charsPerToken, minPruneRawTokens, minPruneToolCalls }`. Global values come from `~/.pi/agent/context-prune/settings.json`. A trusted project may overlay a partial config from `<project>/.pi/context-prune/settings.json`.
- **`SummarizerStats`** — cumulative token/cost stats: `{ totalInputTokens, totalOutputTokens, totalCost, callCount }`. Persisted via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`PruneDiagnostic`** — one append-only attempt record with trigger, strategy, batching mode, eligibility, size estimates, skip reason, and frontier outcome.
- **`PruneFrontier`** — the last completed attempt boundary. Successful and oversized attempts advance it. Below-threshold, aborted, and failed attempts do not.
- **`ProgressCallback`** — `(index, total, batch, stage: "start" | "done" | "skipped") => void` — progress callback fired by `flushPending` when processing batches sequentially. Only used when the caller passes `onProgress` in `FlushOptions` (i.e. `/pruner now`).
- **`BatchTextProgressCallback`** — `(index, total, batch, receivedChars) => void` — live callback fired while the summarizer streams text for the active batch in `/pruner now`.
- **`FlushOptions`** — `{ delivery?, onProgress?, onBatchTextProgress?, previewedBatches?, force?, signal? }`. `onProgress` selects sequential processing, `previewedBatches` avoids recapture, `force` bypasses the minimum guard, and `signal` cancels in-flight work without advancing the frontier.
- **`SummarizeBatchOptions`** — `{ onTextProgress? }` — optional per-call summarizer hooks. Used to surface streamed character counts during a single batch summary.
- **`SummarizeBatchesOptions`** — `{ onBatchTextProgress? }` — optional hooks for parallel multi-batch summarization so callers can surface live per-batch text progress in the footer or overlay.
- **`SummarizeResult`** — return type from summarizer: `{ summaryText, usage }` carrying both the markdown summary and LLM usage data.
- **`SummaryMessageDetails`** — metadata attached to `context-prune-summary` custom messages.
- Constants include the summary, index, statistics, diagnostic, and frontier custom types. They also include the status and progress widget IDs, `DEFAULT_CONFIG`, `CONTEXT_PRUNE_TOOL_NAME`, and `AGENTIC_AUTO_SYSTEM_PROMPT`.

### `src/config.ts` — Config persistence

- **`SETTINGS_PATH`** — global settings at `~/.pi/agent/context-prune/settings.json`.
- **`PROJECT_SETTINGS_RELATIVE_PATH`** — partial project overlay at `.pi/context-prune/settings.json`.
- **`loadConfigState(cwd, projectTrusted)`** — always loads global settings and reads the nearest project overlay only when `projectTrusted` is true.
- **`mergeConfig(global, project?)`** — overlays project fields on global values; arrays replace rather than append.
- **`saveConfig` / `saveProjectConfig`** — write the active scope. Commands update the project overlay when one was loaded.

### `src/batch-capture.ts` — Turn capture and serialization

- **`captureBatch(message, toolResults, turnIndex, timestamp)`** — converts raw `turn_end` event data into a typed `CapturedBatch`. Extracts `assistantText` from `TextContent` blocks and matches each `ToolCall` content block in the `AssistantMessage` with its corresponding `ToolResultMessage` by `toolCallId`. Falls back to `"(no result)"` if no match is found for a tool call.
- **`captureUnindexedBatchesFromSession(branch, indexer, excludeToolNames)`** — scans a session branch for all unsummarized tool results and groups them into `CapturedBatch` objects. Each batch is tagged with a `userTurnGroup` counter that increments on every `role: "user"` message encountered while walking the branch — all assistant turns between two consecutive user messages share the same `userTurnGroup`. This allows `groupBatchesByMode` to merge them later. **Important**: `getBranch()` returns `SessionEntry[]` (not `AgentMessage[]`). Each message entry is `{ type: "message", message: AgentMessage }`. The function unwraps `entry.message` before accessing `role`/`toolCallId`. Pi appends both the assistant message and individual tool results to the session as they arrive (not batched at `turn_end`), so mid-turn results ARE visible in the branch.
- **`groupBatchesByMode(batches, mode)`** — applies the batching-mode grouping. `"turn"` returns batches unchanged (one summary per assistant turn). `"agent-message"` merges consecutive batches that share the same `userTurnGroup` into a single `CapturedBatch` (concat `toolCalls`, join `assistantText`, keep last `turnIndex`/`timestamp`). Batches without `userTurnGroup` (live `turn_end` path) are always passed through one-per-batch. Called in `flushPending` after frontier trimming and before `summarizeBatches`.
- **`serializeBatchForSummarizer(batch)`** — renders a single `CapturedBatch` as plain text for the summarizer LLM. Includes `assistantText` as a header if present. Truncates individual result text at 2 000 chars to keep the summarizer prompt manageable.
- **`serializeBatchesForSummarizer(batches)`** — renders multiple `CapturedBatch` objects into a single text block for batched summarization. Each batch is rendered as a `=== Turn N ===` section, separated by blank lines. Reuses `serializeBatchForSummarizer` for each batch's body.

### `src/summarizer.ts` — LLM summarization

- **`summarizerThinkingOptions(config)`** — translates `config.summarizerThinking` into a provider-call options object. `"default"` returns `{}`; `"off"` returns `{ reasoningEffort: undefined }`; all other levels return `{ reasoningEffort: level }`. Provider adapters translate `reasoningEffort` into the provider-specific field.
- **`resolveModel(config, ctx)`** — resolves `config.summarizerModel` to a model instance. `"default"` returns `ctx.model`; `"provider/model-id"` splits on `/` and looks up via `ctx.modelRegistry.find(provider, modelId)` with a fallback to `ctx.model` + warning on failure.
- **`summarizeBatch(batch, config, ctx, options?)`** — summarizes a single `CapturedBatch` in one LLM call. Internally uses streaming so it can optionally report received summary-text character counts through `options.onTextProgress`, while still returning a final `SummarizeResult` (summary text + usage) on success or `null` on failure.
- **`summarizeBatches(batches, config, ctx, options?)`** — summarizes multiple `CapturedBatch` objects via one parallel LLM call per batch. If only one batch, delegates to `summarizeBatch`. For live UX it can forward streamed per-batch character counts through `options.onBatchTextProgress`. Returns an array of per-batch results.

### `src/indexer.ts` — `ToolCallIndexer` class

Maintains the runtime `Map<toolCallId, ToolCallRecord>` and handles session persistence:

- **`reconstructFromSession(ctx)`** — scans the current branch's session entries for `CUSTOM_TYPE_INDEX` custom entries and repopulates the in-memory map.
- **`addBatch(batch, pi)`** — adds all records from a batch to the map and calls `pi.appendEntry(CUSTOM_TYPE_INDEX, ...)` to persist them so they survive restarts and branch switches.
- **`isSummarized(toolCallId)`** — used by the pruner to decide which messages to drop.
- **`getRecord(refOrToolCallId)`** / **`lookupToolCalls(ids)`** — resolve short refs or full IDs to captured records for the query tool and tree browser.

### `src/pruner.ts` — Context message filter

- **`pruneMessages(messages, indexer)`** — filters the `context` event's message array. Drops any message with `role === "toolResult"` whose `toolCallId` is present in the index. All other messages (including `AssistantMessage` tool-call blocks that carry the IDs) are kept so the model can still reference them when calling `context_tree_query`.

### `src/reminder.ts` — Unpruned-count reminder (agentic-auto only)

- **`countUnprunedToolCalls(messages, indexer)`** — walks `AssistantMessage` `toolCall` content blocks and counts those whose id is NOT in the indexer.
- **`buildReminderText(count)`** — returns `<pruner-note>N unpruned tool call result(s) currently in context. Consider calling context_prune after a logical batch of 8–12 related tool calls.</pruner-note>`.
- **`annotateWithUnprunedCount(messages, count)`** — if the last message is a `ToolResultMessage`, returns a shallow-cloned list with a `text` content block appended carrying the reminder. Otherwise returns `messages` unchanged. Wired from `index.ts`'s `context` handler, gated on `enabled && pruneOn === "agentic-auto" && remindUnprunedCount`. Annotating only the tail of the last toolResult preserves role alternation and keeps the static prompt-cache prefix intact.

### `src/query-tool.ts` — `context_tree_query` tool

Registers a Pi tool that allows the LLM (or user) to recover pruned outputs:

- Accepts `{ toolCallIds: string[] }`. Callers should use the short refs printed in summaries, while full IDs remain compatible.
- Resolves each ref in the indexer and returns line- and byte-bounded `resultText` through Pi's `truncateHead` helper. Truncated content is marked, so callers must reread or narrow the original source when exact output matters.
- IDs not found in the index return a "(not found)" notice rather than an error.
- Returns `{ content, details: { results } }` with found records in the `details` field.

### `src/context-prune-tool.ts` — `context_prune` tool (agentic-auto mode)

Registers the `context_prune` tool with Pi. The tool is **always registered** (so Pi knows about it), but is only added to the active tools list when `pruneOn === "agentic-auto"` and `enabled === true`. Activation/deactivation is handled in `index.ts` via `syncToolActivation()` → `pi.setActiveTools()`.

- Takes no parameters — calling it flushes all pending batches via `flushPending(ctx, { delivery: "runtime" })`.
- Uses the tool `onUpdate` callback to stream compact live progress text into the running tool output box (e.g. `Context prune running… batch 2/4 · 1.2k chars received`).
- Returns a typed `FlushResult` describing how many batches and tool calls were summarized, or a reason if the flush did not run (empty, already-flushing, stale-context, etc.).
- Carries `promptSnippet` and `promptGuidelines` so the LLM is guided to call it after batches of 8–10 tool calls, not after every 2–3.

### `src/tree-browser.ts` — `TreeBrowser` TUI component

Provides a foldable interactive tree view of pruned tool calls, opened by `/pruner tree`.

- **`buildPruneTree(ctx, indexer)`** — scans the current session branch for `CUSTOM_TYPE_SUMMARY` entries and constructs a `TreeNode[]` where each summary is a parent node and its pruned tool calls are children. Each node carries a `charCount` (character count of the result text) so the UI can show space savings at a glance.
- **`TreeNode`** — `{ id, label, children, expanded, depth, isLeaf, detail?, charCount? }`. Summary nodes carry their markdown summary text in `detail`; tool-call leaf nodes carry a 200-char result preview.
- **`TreeBrowser`** — a `Component` (Pi TUI interface) implementing a scrollable keyboard-navigable tree:
  - Arrow keys move selection; `Enter`/`Space` expand/collapse parent nodes.
  - `Ctrl-O` opens a **summary overlay** for the selected summary node — a centered box rendering the full markdown summary with scroll support.
  - `Esc`/`q` closes the overlay (or the browser if no overlay is open).
  - Renders via `boxLines()` (a local box-drawing helper that draws `┌─┐` borders with a title).
  - The overlay uses the `Markdown` TUI renderer with `getMarkdownTheme()` for styled summary display.

### `src/multi-batch-loader.ts` — legacy/tested overlay component

This component remains covered by tests but is not the current `/pruner now` UI. The command now uses the above-editor widget implemented in `commands.ts`.

- **`MultiBatchLoaderOverlay extends Container`** — constructor takes `(tui, theme, batches: CapturedBatch[])`.
  Builds one `DynamicBorder` top + one `Loader` per batch + one `DynamicBorder` bottom.
  Each `Loader` label shows `Batch N/M (K tool calls) summarizing…`, then appends `received N chars` while text is streaming.
- **`markRunning(index)`** — resets a row to the base `summarizing…` label.
- **`markReceivedChars(index, receivedChars)`** — updates the row label with the number of summary characters streamed so far.
- **`markDone(index)`** — calls `loader.stop()` + `loader.setMessage("✓ Batch N/M done (K tool calls)")` to freeze the spinner and show a checkmark.
- **`markSkipped(index)`** — calls `loader.stop()` + `loader.setMessage("⚠ Batch N/M skipped")` when the LLM call returned null.
- **`onAbort` setter + `handleInput`** — forwards `Esc`/`q` to the abort callback so the overlay can be dismissed without cancelling in-flight LLM calls.

### `src/stats.ts` — `StatsAccumulator` class + formatting helpers

Accumulates cumulative token/cost stats for summarizer LLM calls and persists them to the session:

- **`add(usage)`** — accumulates one LLM call's usage (input tokens, output tokens, total cost).
- **`getStats()`** — returns a `SummarizerStats` snapshot.
- **`reset()`** — clears all accumulated stats to zero.
- **`reconstructFromSession(ctx)`** — scans session entries for `CUSTOM_TYPE_STATS` and restores the last snapshot.
- **`persist(pi)`** — writes current stats as a session entry via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`.
- **`formatTokens(n)`** — formats token counts like Pi's footer (e.g. `1.2k`, `340`).
- **`formatCost(n)`** — formats cost like `$0.003` or `<$0.001`.
- **`statsSuffix(stats)`** — returns `""` when there are no calls. Otherwise it returns the status suffix with a leading space before the `│` separator, followed by token and cost values.

### `src/commands.ts` — `/pruner` command + settings overlay + renderer

- **`SettingsOverlay`** — a TUI `Container` subclass that wraps a `SettingsList` with a `DynamicBorder` + title. Forwards `handleInput` and `invalidate` to the inner list so keyboard navigation works inside the overlay.
- **`pruneStatusText(config, stats?)`** — formats the footer widget string including mode label and optional stats suffix: e.g. `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003`.
- **`SUBCOMMANDS`** — `{ value, label }` array for tab-completion and the interactive picker. Includes `settings`, `on`, `off`, `status`, `model`, `thinking`, `prune-on`, `batching`, `stats`, `diagnostics`, `tree`, `now`, and `help`.
- **`HELP_TEXT`** — full explanation of all subcommands, batching mode guidance, prune-on mode guidance, and a note on prompt-cache impact.
- **`getArgumentCompletions(prefix)`** — filters `SUBCOMMANDS` by prefix for tab-completion.
- **Bare `/pruner`** (no args) — calls `ctx.ui.select()` to show an interactive picker over `SUBCOMMANDS`.
- **`/pruner settings`** — opens an interactive `SettingsOverlay` with ten items:
  1. **Enabled** — toggle pruning.
  2. **Prune status line** — toggle footer status and queued-turn notices.
  3. **Prune trigger** — choose a `PruneOn` mode.
  4. **Prune strategy** — choose LLM summaries or deterministic placeholders.
  5. **Summarizer model** — search available models.
  6. **Summarizer thinking** — choose reasoning effort.
  7. **Token estimator** — choose automatic, tiktoken, or character estimates.
  8. **Tokenizer encoding** — select the tiktoken encoding.
  9. **Unpruned reminder** — toggle the `agentic-auto` reminder.
  10. **Batching mode** — choose `"turn"` or `"agent-message"`.
  Changes are persisted to the active global or trusted-project scope and update the footer when enabled.
- **`/pruner on|off`** — enables/disables pruning, saves config, calls `syncToolActivation()`, updates footer widget.
- **`/pruner status`** — shows enabled state, summarizer model, thinking level, prune trigger, batching mode, status line visibility, and cumulative summarizer stats (calls, tokens, cost).
- **`/pruner stats`** — shows detailed cumulative summarizer token/cost stats.
- **`/pruner diagnostics`** — reports recent persisted attempts, skip reasons, frontier outcomes, and cumulative raw/replacement totals.
- **`/pruner model [value]`** — gets or sets the summarizer model. Accepts `"provider/model-id"` or `"provider/model-id:thinking"` (colon-separated suffix sets both model and thinking level in one command).
- **`/pruner thinking [value]`** — gets or sets the summarizer thinking level; bare form shows `ctx.ui.select()` picker over `SUMMARIZER_THINKING_LEVELS`.
- **`/pruner prune-on [value]`** — gets or sets the trigger mode; bare form shows `ctx.ui.select()` picker over `PRUNE_ON_MODES`.
- **`/pruner batching [value]`** — gets or sets the batching mode (`turn` or `agent-message`); bare form shows `ctx.ui.select()` picker over `BATCHING_MODES`.
- **`/pruner tree`** — builds a `TreeNode[]` via `buildPruneTree()` and opens a `TreeBrowser` via `ctx.ui.custom()` so the user can browse pruned tool calls interactively.
- **`/pruner now [--force]`** — previews pending batches and uses an above-editor progress widget. Normal use keeps below-threshold work pending without moving the frontier. `--force` bypasses the minimum guard. Sequential summarizer calls provide per-row progress. The widget is removed when the attempt finishes.
- **`/pruner help`** — displays `HELP_TEXT` via `ctx.ui.notify`.
- **`default` case** — directs unknown subcommands to run `/pruner help`.
- **Message renderer** for `context-prune-summary` — renders summary messages in the TUI with a styled header (accent color) showing turn index and tool count; collapses to header-only when not expanded, shows full content when expanded.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Pruning only `ToolResultMessage`s | `AssistantMessage` tool-call blocks (which carry IDs) are kept so the model can call `context_tree_query` by ID |
| Two `flushPending` delivery modes | `"runtime"` uses `pi.sendMessage` steer (safe during active agent loops); `"session"` writes via `sessionManager` directly (safe when Pi may be shutting down the session after print-mode runs) |
| `pi.appendEntry` for persistence | Session custom entries survive restarts and branch navigation; index is rebuilt on `session_start` / `session_tree` |
| `summarizerModel: "default"` | Reuses the active model's credentials via `ctx.modelRegistry.getApiKeyAndHeaders()` — no hidden side-channel or extra config needed |
| `summarizerThinking` setting | Lets users trade summarizer cost/latency for quality; `"default"` preserves old behavior (no explicit reasoning option sent) |
| Global config plus trust-gated project overlay | The extension owns its files. Untrusted projects cannot activate `.pi/context-prune/settings.json`. Trusted overlays replace global values per field. |
| Five `pruneOn` trigger modes | `every-turn` (immediate), `on-context-tag` (aligned with save-points), `on-demand` (manual), `agent-message` (batch until final text response), `agentic-auto` (LLM decides via `context_prune` tool) — lets users trade immediacy for batch efficiency |
| `pendingBatches` queue + `flushPending` | Decouples capture from replacement. Summarizer mode uses one call per batch in parallel by default. `/pruner now` uses sequential calls for progress, and placeholder mode uses none. |
| `message_end` instead of `turn_end` for `agent-message` flush | `message_end` fires reliably at the final text-only response and before session teardown, giving time to capture the sessionManager before awaiting the summarizer LLM call. `turn_end` in print mode fires too late. |
| `agent_end` as status update only | Avoids starting async LLM work after Pi may have disposed the session. If batches remain, the user sees a "N pending" status and can `/pruner now` next session. |
| `context_prune` tool always registered, conditionally activated | Keeps Pi's tool registry consistent; `syncToolActivation()` adds/removes it from the active list on every config change without re-registering. |
| Above-editor progress widget for `/pruner now` | Shows per-batch spinner rows and streamed character counts. Sequential calls are limited to this command. Automatic paths keep parallel per-batch summarization. |
| `context_prune` onUpdate progress | Keeps the footer status simple while agentic-auto pruning still shows live progress in the running tool output box above the input |
| `capturePendingBatches` extracted from `flushPending` | Lets `/pruner now` build progress rows before flushing and avoids double capture through `previewedBatches`. |
| `context` handler returns `undefined` when no pruning occurs | Avoids unnecessary message-list reconstruction when nothing was filtered |
| Stats persistence via `CUSTOM_TYPE_STATS` | Stats are snapshots persisted alongside index entries; on `session_start` / `session_tree`, the last snapshot is applied, matching the same lifecycle as the indexer |
| `SummarizeResult` return type | Summarizer functions return `{ summaryText, usage }` so callers can accumulate token/cost data without side effects in the summarizer module |
| Status widget includes stats suffix | Footer shows `prune: ON (Every turn) │ ↑1.2k ↓340 $0.003` after summarizer calls, giving users visibility into pruner overhead |
| Auth via `ctx.modelRegistry.getApiKeyAndHeaders()` | Explicit credential resolution for the summarizer LLM call, with error notification on failure |
| `TreeBrowser` for `/pruner tree` | Gives users a visual, keyboard-navigable audit trail of what was pruned and how much space was saved, without leaving the Pi TUI |
| `userTurnGroup` field on `CapturedBatch` | Assigned in `captureUnindexedBatchesFromSession` by incrementing a counter at every user message — gives `groupBatchesByMode` a stable key to merge turns within the same conversation exchange without changing the live `turn_end` capture path. |
| `batchingMode` is separate from `pruneOn` | `pruneOn` controls *when* to flush; `batchingMode` controls *how coarse* each summary is. Keeping them independent lets users mix e.g. `pruneOn: on-demand` with `batchingMode: agent-message` freely. |
