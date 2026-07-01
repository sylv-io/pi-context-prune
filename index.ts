/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save ~/.pi/agent/context-prune/settings.json
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  loadConfigState,
  mergeConfig,
  normalizeConfig,
  normalizeConfigPatch,
  saveConfig,
  saveProjectConfig,
  type ConfigState,
} from "./src/config.js";
import {
  captureBatch,
  captureUnindexedBatchesFromSession,
  groupBatchesByMode,
} from "./src/batch-capture.js";
import { summarizeBatch, summarizeBatches } from "./src/summarizer.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import {
  annotateWithUnprunedCount,
  countUnprunedToolCalls,
} from "./src/reminder.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import {
  formatSummaryToolCallRefs,
  makeSummaryDetails,
} from "./src/summary-refs.js";
import { renderPlaceholderSummary } from "./src/placeholder.js";
import type {
  ContextPruneConfig,
  CapturedBatch,
  IndexEntryData,
  PruneFrontier,
  FlushOptions,
  PruneDiagnostic,
  SummarizerStats,
} from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CONTEXT_PRUNE_TOOL_NAME,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";
import { computeProtectedTail } from "./src/context-tail.js";
import { estimateTokens } from "./src/token-estimator.js";
import { PruneDiagnosticsStore } from "./src/diagnostics.js";
import {
  evaluatePruneGuard,
  filterPruneableBatches,
} from "./src/prune-guard.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" },
  };
  const configState: { value: ConfigState } = {
    value: { global: { ...DEFAULT_CONFIG }, effective: currentConfig.value },
  };

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Shared diagnostics — append-only metadata about prune attempts.
  const diagnostics = new PruneDiagnosticsStore();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  let isFlushing = false;

  type FlushResult =
    | {
        ok: true;
        reason: "flushed" | "skipped-oversized";
        batchCount: number;
        toolCallCount: number;
        rawCharCount: number;
        summaryCharCount: number;
      }
    | {
        ok: false;
        reason:
          | "empty"
          | "already-flushing"
          | "summarizer-failed"
          | "stale-context"
          | "failed"
          | "aborted"
          | "below-threshold";
        error?: string;
      };
  type FlushFailureReason = Extract<FlushResult, { ok: false }>["reason"];

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(
      customType: string,
      content: string,
      display: boolean,
      details?: unknown,
    ): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

  const estimateTexts = (texts: string[]) =>
    texts.reduce(
      (sum, text) => sum + estimateTokens(text, currentConfig.value).tokens,
      0,
    );

  const baseDiagnostic = (
    delivery: "runtime" | "session",
    patch: Partial<PruneDiagnostic>,
  ): PruneDiagnostic => ({
    timestamp: Date.now(),
    trigger: currentConfig.value.pruneOn,
    pruneStrategy: currentConfig.value.pruneStrategy,
    batchingMode: currentConfig.value.batchingMode,
    protectedTailTokens: currentConfig.value.protectedTailTokens,
    delivery,
    attemptedBatchCount: 0,
    eligibleToolCallCount: 0,
    prunedToolCallCount: 0,
    rawCharCount: 0,
    estimatedRawTokens: 0,
    replacementCharCount: 0,
    estimatedReplacementTokens: 0,
    ...patch,
  });

  const recordDiagnostic = (
    delivery: "runtime" | "session",
    patch: Partial<PruneDiagnostic>,
    appendEntry?: (customType: string, data?: unknown) => unknown,
  ) => {
    const entry = baseDiagnostic(delivery, patch);
    if (appendEntry) {
      diagnostics.record(entry, appendEntry);
    } else {
      diagnostics.recordBestEffort(entry, pi);
    }
  };

  const setPruneStatusWidgetBestEffort = (
    ctx: any,
    value?: SummarizerStats | string,
  ) => {
    try {
      setPruneStatusWidget(ctx, currentConfig.value, value);
    } catch {
      // Status updates are advisory and must not change prune outcomes.
    }
  };

  const reloadConfig = async (ctx: any) => {
    configState.value = await loadConfigState(ctx.cwd ?? process.cwd());
    currentConfig.value = configState.value.effective;
  };

  const updateConfig = async (patch: Partial<ContextPruneConfig>) => {
    const state = configState.value;
    if (state.projectPath) {
      const project = normalizeConfigPatch({
        ...(state.project ?? {}),
        ...patch,
      });
      await saveProjectConfig(state.projectPath, project);
      configState.value = {
        ...state,
        project,
        effective: mergeConfig(state.global, project),
      };
    } else {
      const global = normalizeConfig({ ...state.global, ...patch });
      await saveConfig(global);
      configState.value = { global, effective: mergeConfig(global) };
    }
    currentConfig.value = configState.value.effective;
  };

  const safeNotify = (
    ctx: any,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ) => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) =>
    message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (
    batch: CapturedBatch,
    protectedToolCallIds = new Set<string>(),
  ): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    const pruneableBatch = filterPruneableBatches([batch], {
      protectedToolCallIds,
      preserveToolResults: currentConfig.value.preserveToolResults,
      isSummarized: (toolCallId) => indexer.isSummarized(toolCallId),
    })[0];
    if (!pruneableBatch) return null;
    const toolCalls = pruneableBatch.toolCalls;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex)
      return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex(
      (tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId,
    );
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  const persistBatchIndex = (
    batch: CapturedBatch,
    appendEntry: (customType: string, data?: unknown) => void,
  ) => {
    const records = batch.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      isError: tc.isError,
      turnIndex: batch.turnIndex,
      timestamp: batch.timestamp,
    }));

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
    for (const record of records) {
      indexer.getIndex().set(record.toolCallId, record);
    }
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  const capturePendingBatches = (ctx: any): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    let protectedToolCallIds = new Set<string>();
    try {
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry: any) => entry.type === "message")
        .map((entry: any) => entry.message);
      protectedToolCallIds = computeProtectedTail(
        messages,
        currentConfig.value,
      ).protectedToolCallIds;
      batches = captureUnindexedBatchesFromSession(branch, indexer, [
        CONTEXT_PRUNE_TOOL_NAME,
      ]);
    } catch {
      if (currentConfig.value.protectedTailTokens > 0) return [];
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch, protectedToolCallIds))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  // Summarizes + indexes all pending batches.
  // When options.onProgress is provided batches are processed sequentially
  // (one LLM call each) so the caller can update per-row UI. Otherwise all
  // batches are summarized in parallel (one summarizeBatches call).
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  const flushPending = async (
    ctx: any,
    options: FlushOptions = {},
  ): Promise<FlushResult> => {
    const delivery = options.delivery ?? "runtime";

    if (isFlushing) {
      recordDiagnostic(delivery, { skipReason: "already-flushing" });
      return { ok: false, reason: "already-flushing" };
    }

    // Use pre-captured batches if provided (avoids double-capture when the
    // caller previewed the queue before opening the progress overlay).
    const batches: CapturedBatch[] =
      options.previewedBatches ?? capturePendingBatches(ctx);

    if (batches.length === 0) {
      recordDiagnostic(delivery, { skipReason: "empty" });
      return { ok: false, reason: "empty" };
    }

    // Bail out before we drain pendingBatches so they don't need restoring.
    if (options.signal?.aborted) {
      const eligibleToolCallCount = batches.reduce(
        (sum, batch) => sum + batch.toolCalls.length,
        0,
      );
      recordDiagnostic(delivery, {
        attemptedBatchCount: batches.length,
        eligibleToolCallCount,
        skipReason: "aborted",
      });
      return { ok: false, reason: "aborted" };
    }

    const guard = evaluatePruneGuard(batches, currentConfig.value);
    if (!options.force && !guard.shouldPrune) {
      recordDiagnostic(delivery, {
        attemptedBatchCount: batches.length,
        eligibleToolCallCount: guard.eligibleToolCallCount,
        rawCharCount: guard.rawCharCount,
        estimatedRawTokens: guard.estimatedRawTokens,
        skipReason: guard.reason,
      });
      return { ok: false, reason: "below-threshold" };
    }

    // Draining the queue since we've captured the state via session or slice.
    // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
    // or rapid turn-ends don't result in double-summarization.
    pendingBatches.length = 0;

    isFlushing = true;

    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return {
          ok: false,
          reason: isStaleContextError(err) ? "stale-context" : "failed",
          error: errorMessage(err),
        };
      }
    }

    const appendEntry = (customType: string, data?: unknown) =>
      sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(
        CUSTOM_TYPE_SUMMARY,
        content,
        true,
        details,
      );

    try {
      const usePlaceholderStrategy =
        currentConfig.value.pruneStrategy === "placeholder";
      setPruneStatusWidgetBestEffort(
        ctx,
        usePlaceholderStrategy ? "prune: indexing…" : "prune: summarizing…",
      );

      const reportBatchTextProgress = (
        index: number,
        total: number,
        batch: CapturedBatch,
        receivedChars: number,
      ) => {
        options.onBatchTextProgress?.(index, total, batch, receivedChars);
      };

      // Summarize batches. When onProgress is provided (i.e. /pruner now with the
      // multi-row overlay) we process sequentially so each row can be checked off
      // as its LLM call completes. Otherwise all batches run in parallel.
      let results: ({
        summaryText: string;
        usage?: import("./src/types.js").SummarizeResult["usage"];
      } | null)[];
      if (usePlaceholderStrategy) {
        results = batches.map((batch, i) => {
          options.onProgress?.(i, batches.length, batch, "start");
          options.onProgress?.(i, batches.length, batch, "done");
          return { summaryText: "" };
        });
      } else if (options.onProgress) {
        results = [];
        for (let i = 0; i < batches.length; i++) {
          options.onProgress(i, batches.length, batches[i], "start");
          const r = await summarizeBatch(batches[i], currentConfig.value, ctx, {
            signal: options.signal,
            onTextProgress: (receivedChars) => {
              reportBatchTextProgress(
                i,
                batches.length,
                batches[i],
                receivedChars,
              );
            },
          });
          results.push(r);
          options.onProgress(
            i,
            batches.length,
            batches[i],
            r ? "done" : "skipped",
          );
        }
      } else {
        // Parallel — one LLM call per batch, all in flight simultaneously.
        results = await summarizeBatches(batches, currentConfig.value, ctx, {
          onBatchTextProgress: reportBatchTextProgress,
          signal: options.signal,
        });
      }

      // Process results in order; stop at first null (individual call failure).
      // Batches before the first failure are persisted; remaining are restored to
      // pendingBatches so they are retried on the next flush.
      const processedBatches: CapturedBatch[] = [];
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalToolCallCount = 0;
      let prunedRawCharCount = 0;
      let prunedSummaryCharCount = 0;
      let prunedToolCallCount = 0;
      const prunedRawTexts: string[] = [];
      const prunedSummaryTexts: string[] = [];
      const oversizedBatches: CapturedBatch[] = [];
      let firstFailureIndex = -1;
      let firstFailureReason: FlushFailureReason = "summarizer-failed";

      for (let i = 0; i < batches.length; i++) {
        const result = results[i];
        if (!result) {
          firstFailureIndex = i;
          break;
        }

        const batch = batches[i];
        const batchRawCharCount = batch.toolCalls.reduce(
          (s, tc) => s + tc.resultText.length,
          0,
        );
        const summaryRefs = indexer.allocateSummaryRefs(batch);
        const summaryText = usePlaceholderStrategy
          ? renderPlaceholderSummary(batch, summaryRefs, currentConfig.value)
          : result.summaryText + formatSummaryToolCallRefs(summaryRefs);
        const shouldSkipOversized =
          !usePlaceholderStrategy && summaryText.length > batchRawCharCount;

        const batchDetails = makeSummaryDetails(batch, summaryRefs);

        try {
          if (!shouldSkipOversized) {
            // Write one summary message per turn and index its tool calls.
            if (delivery === "runtime") {
              pi.sendMessage(
                {
                  customType: CUSTOM_TYPE_SUMMARY,
                  content: summaryText,
                  display: true,
                  details: batchDetails,
                },
                { deliverAs: "steer" },
              );
              indexer.addBatch(batch, pi);
              indexer.registerSummaryRefs(summaryRefs);
            } else {
              appendSummaryMessage(summaryText, batchDetails);
              persistBatchIndex(batch, appendEntry);
              indexer.registerSummaryRefs(summaryRefs);
            }
          } else {
            oversizedBatches.push(batch);
          }
        } catch (err) {
          // Persistence error mid-loop: stop here and restore this and remaining batches.
          if (isStaleContextError(err)) {
            firstFailureIndex = i;
            firstFailureReason = "stale-context";
            break;
          }
          throw err;
        }

        if (result.usage) statsAccum.add(result.usage);
        totalRawCharCount += batchRawCharCount;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length;
        if (!shouldSkipOversized) {
          prunedRawCharCount += batchRawCharCount;
          prunedSummaryCharCount += summaryText.length;
          prunedToolCallCount += batch.toolCalls.length;
          prunedRawTexts.push(...batch.toolCalls.map((tc) => tc.resultText));
          prunedSummaryTexts.push(summaryText);
        }

        processedBatches.push(batch);
      }

      // Restore unprocessed batches (those at and after the first failure)
      if (firstFailureIndex >= 0) {
        restoreBatches(batches.slice(firstFailureIndex));
      }

      if (processedBatches.length === 0) {
        // Nothing was persisted (all calls failed or first call failed)
        setPruneStatusWidgetBestEffort(ctx, statsAccum.getStats());
        recordDiagnostic(
          delivery,
          {
            attemptedBatchCount: batches.length,
            eligibleToolCallCount: batches.reduce(
              (sum, batch) => sum + batch.toolCalls.length,
              0,
            ),
            skipReason: firstFailureReason,
          },
          delivery === "session" ? appendEntry : undefined,
        );
        return { ok: false, reason: firstFailureReason };
      }

      // Advance frontier to the last batch we actually processed.
      const lastBatch = processedBatches[processedBatches.length - 1];
      const lastTC = lastBatch.toolCalls[lastBatch.toolCalls.length - 1];
      const allOversized = oversizedBatches.length === processedBatches.length;
      const frontierSnapshot: PruneFrontier = {
        lastAttemptedToolCallId: lastTC.toolCallId,
        lastAttemptedToolName: lastTC.toolName,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: processedBatches.length,
        attemptedToolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: allOversized ? "skipped-oversized" : "summarized",
      };

      try {
        if (delivery === "runtime") {
          pi.appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          frontier.advance(frontierSnapshot);
          statsAccum.persist(pi);
          recordDiagnostic(delivery, {
            attemptedBatchCount: processedBatches.length,
            eligibleToolCallCount: totalToolCallCount,
            prunedToolCallCount,
            rawCharCount: prunedRawCharCount,
            estimatedRawTokens: estimateTexts(prunedRawTexts),
            replacementCharCount: prunedSummaryCharCount,
            estimatedReplacementTokens: estimateTexts(prunedSummaryTexts),
            skipReason: allOversized ? "summary-oversized" : undefined,
            frontierToolCallId: lastTC.toolCallId,
            frontierOutcome: frontierSnapshot.outcome,
          });
        } else {
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          frontier.advance(frontierSnapshot);
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
          recordDiagnostic(
            delivery,
            {
              attemptedBatchCount: processedBatches.length,
              eligibleToolCallCount: totalToolCallCount,
              prunedToolCallCount,
              rawCharCount: prunedRawCharCount,
              estimatedRawTokens: estimateTexts(prunedRawTexts),
              replacementCharCount: prunedSummaryCharCount,
              estimatedReplacementTokens: estimateTexts(prunedSummaryTexts),
              skipReason: allOversized ? "summary-oversized" : undefined,
              frontierToolCallId: lastTC.toolCallId,
              frontierOutcome: frontierSnapshot.outcome,
            },
            appendEntry,
          );
        }
      } catch (err) {
        recordDiagnostic(delivery, {
          attemptedBatchCount: processedBatches.length,
          eligibleToolCallCount: totalToolCallCount,
          prunedToolCallCount,
          rawCharCount: prunedRawCharCount,
          estimatedRawTokens: estimateTexts(prunedRawTexts),
          replacementCharCount: prunedSummaryCharCount,
          estimatedReplacementTokens: estimateTexts(prunedSummaryTexts),
          skipReason: isStaleContextError(err) ? "stale-context" : "failed",
        });
        return {
          ok: false,
          reason: isStaleContextError(err) ? "stale-context" : "failed",
          error: errorMessage(err),
        };
      }

      setPruneStatusWidgetBestEffort(ctx, statsAccum.getStats());

      // Notify about any oversized batches that were skipped
      for (const batch of oversizedBatches) {
        const batchRaw = batch.toolCalls.reduce(
          (s, tc) => s + tc.resultText.length,
          0,
        );
        const batchSummaryLen =
          results[batches.indexOf(batch)]?.summaryText.length ?? 0;
        safeNotify(
          ctx,
          `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${batchRaw} raw chars; frontier advanced past this range`,
          "warning",
        );
      }

      return {
        ok: true,
        reason: allOversized ? "skipped-oversized" : "flushed",
        batchCount: processedBatches.length,
        toolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
    } catch (err) {
      restoreBatches(batches);
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidgetBestEffort(ctx, statsAccum.getStats());
        recordDiagnostic(delivery, {
          attemptedBatchCount: batches.length,
          eligibleToolCallCount: batches.reduce(
            (sum, batch) => sum + batch.toolCalls.length,
            0,
          ),
          skipReason: "aborted",
        });
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) {
        recordDiagnostic(delivery, {
          attemptedBatchCount: batches.length,
          eligibleToolCallCount: batches.reduce(
            (sum, batch) => sum + batch.toolCalls.length,
            0,
          ),
          skipReason: "stale-context",
        });
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(
        ctx,
        `pruner: summarization failed: ${errorMessage(err)}`,
        "error",
      );
      recordDiagnostic(delivery, {
        attemptedBatchCount: batches.length,
        eligibleToolCallCount: batches.reduce(
          (sum, batch) => sum + batch.toolCalls.length,
          0,
        ),
        skipReason: "failed",
      });
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate =
      currentConfig.value.enabled &&
      currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(
          activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME),
        );
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load global config and optional <project>/.pi/context-prune/settings.json
    await reloadConfig(ctx);

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Rebuild append-only prune diagnostics from persisted session entries
    diagnostics.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    ctx.ui.notify(
      `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
      "info",
    );
  });

  // Rebuild config, index, and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    await reloadConfig(ctx);
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    diagnostics.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
    syncToolActivation();
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by message_end in agent-message mode.
      // In print mode, turn_end can fire after session shutdown, so do not start
      // deferred LLM work from this late lifecycle event.
      return;
    }

    const capturedBatch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now(),
    );
    const batch = trimBatchToPendingRange({
      ...capturedBatch,
      // Do not summarize the pruner's own housekeeping tool result. Otherwise
      // agentic-auto mode can queue the context_prune result and try to flush it
      // during agent_end, when Pi may already have invalidated the extension ctx.
      toolCalls: capturedBatch.toolCalls.filter(
        (tc) => tc.toolName !== CONTEXT_PRUNE_TOOL_NAME,
      ),
    });
    if (!batch) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await flushPending(ctx, { delivery: "session" });
    } else {
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_tag";
          break;
        case "agent-message":
          trigger = "agent's next text response";
          break;
        case "agentic-auto":
          trigger = "agent calling context_prune";
          break;
        default:
          trigger = "/pruner now";
          break;
      }
      if (currentConfig.value.showPruneStatusLine) {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
        safeNotify(
          ctx,
          `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
          "info",
        );
      }
    }
  });

  // ── tool_execution_end: flush when context_tag fires ─────────────────────
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "context_tag") return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await flushPending(ctx, { delivery: "runtime" });
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    await flushPending(ctx, { delivery: "session" });
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    setPruneStatusWidget(
      ctx,
      currentConfig.value,
      `prune: ${pendingBatches.length} pending`,
    );
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;

    const indexEmpty = indexer.getIndex().size === 0;
    let messages = event.messages;
    let changed = false;
    const { protectedToolCallIds } = computeProtectedTail(
      messages,
      currentConfig.value,
    );

    if (!indexEmpty) {
      const pruned = pruneMessages(messages, indexer, protectedToolCallIds);
      if (pruned.length !== messages.length) {
        messages = pruned;
        changed = true;
      }
    }

    // Append a small `<pruner-note>` to the last toolResult telling the model
    // how many unpruned tool calls are sitting in context. Only active in
    // agentic-auto mode (where the LLM itself decides when to call
    // context_prune) and only when the user has the reminder enabled.
    if (
      currentConfig.value.pruneOn === "agentic-auto" &&
      currentConfig.value.remindUnprunedCount
    ) {
      const count = countUnprunedToolCalls(
        messages,
        indexer,
        protectedToolCallIds,
        currentConfig.value.preserveToolResults,
      );
      if (count > 0) {
        const annotated = annotateWithUnprunedCount(
          messages,
          count,
          currentConfig.value.protectedTailTokens > 0,
        );
        if (annotated !== messages) {
          messages = annotated;
          changed = true;
        }
      }
    }

    if (!changed) return undefined;
    return { messages };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (
      !currentConfig.value.enabled ||
      currentConfig.value.pruneOn !== "agentic-auto"
    )
      return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, (ctx, options) =>
    flushPending(ctx, { delivery: "runtime", ...options }),
  );

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(
    pi,
    currentConfig,
    flushPending,
    capturePendingBatches,
    syncToolActivation,
    () => statsAccum.getStats(),
    () => diagnostics.getEntries(),
    indexer,
    () => configState.value,
    updateConfig,
  );
}
