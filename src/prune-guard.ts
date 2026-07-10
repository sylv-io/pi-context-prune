import type {
	CapturedBatch,
	ContextPruneConfig,
	PreserveToolResultRule,
} from "./types.js";
import { estimateTokens } from "./token-estimator.js";
import { shouldPreserveToolResult } from "./preserve-tool-results.js";

export interface PruneGuardEvaluation {
	shouldPrune: boolean;
	rawCharCount: number;
	estimatedRawTokens: number;
	eligibleToolCallCount: number;
	reason?: "below-threshold";
}

export interface PruneableBatchFilterOptions {
	protectedToolCallIds?: Set<string>;
	preserveToolResults?: PreserveToolResultRule[];
	isSummarized?: (toolCallId: string) => boolean;
	excludeToolNames?: string[];
}

/**
 * Keeps only tool results that can actually be removed from future context.
 * Non-pruneable results must not push the automatic threshold over the line.
 */
export function filterPruneableBatches(
	batches: CapturedBatch[],
	options: PruneableBatchFilterOptions = {},
): CapturedBatch[] {
	const excludeToolNames = new Set(options.excludeToolNames ?? []);
	return batches
		.map((batch) => {
			const toolCalls = batch.toolCalls.filter((tc) => {
				if (excludeToolNames.has(tc.toolName)) return false;
				if (options.protectedToolCallIds?.has(tc.toolCallId)) return false;
				if (options.isSummarized?.(tc.toolCallId)) return false;
				return !shouldPreserveToolResult(tc, options.preserveToolResults ?? []);
			});
			return toolCalls.length > 0 ? { ...batch, toolCalls } : null;
		})
		.filter((batch): batch is CapturedBatch => batch !== null);
}

/**
 * Simple minimum-size guard for prune attempts.
 *
 * Runs after pending batches have already been trimmed for preserve rules,
 * existing index entries, frontier state, and batching mode. A caller that gets
 * `shouldPrune: false` must leave those batches pending and must not advance
 * the frontier.
 */
export function evaluatePruneGuard(
	batches: CapturedBatch[],
	config: ContextPruneConfig,
	options: PruneableBatchFilterOptions = {},
): PruneGuardEvaluation {
	const pruneableBatches = filterPruneableBatches(batches, options);
	const resultTexts = pruneableBatches.flatMap((batch) =>
		batch.toolCalls.map((tc) => tc.resultText),
	);
	const rawCharCount = resultTexts.reduce((sum, text) => sum + text.length, 0);
	const estimatedRawTokens = resultTexts.reduce(
		(sum, text) => sum + estimateTokens(text, config).tokens,
		0,
	);
	const eligibleToolCallCount = pruneableBatches.reduce(
		(sum, batch) => sum + batch.toolCalls.length,
		0,
	);

	const toolCallThresholdReached =
		config.minPruneToolCalls > 0 &&
		eligibleToolCallCount >= config.minPruneToolCalls;
	const shouldPrune =
		estimatedRawTokens >= config.minPruneRawTokens || toolCallThresholdReached;

	return {
		shouldPrune,
		rawCharCount,
		estimatedRawTokens,
		eligibleToolCallCount,
		reason: shouldPrune ? undefined : "below-threshold",
	};
}
