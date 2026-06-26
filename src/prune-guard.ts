import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import { estimateTokens } from "./token-estimator.js";

export interface PruneGuardEvaluation {
	shouldPrune: boolean;
	rawCharCount: number;
	estimatedRawTokens: number;
	eligibleToolCallCount: number;
	reason?: "below-threshold";
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
): PruneGuardEvaluation {
	const resultTexts = batches.flatMap((batch) =>
		batch.toolCalls.map((tc) => tc.resultText),
	);
	const rawCharCount = resultTexts.reduce((sum, text) => sum + text.length, 0);
	const estimatedRawTokens = resultTexts.reduce(
		(sum, text) => sum + estimateTokens(text, config).tokens,
		0,
	);
	const eligibleToolCallCount = batches.reduce(
		(sum, batch) => sum + batch.toolCalls.length,
		0,
	);

	const shouldPrune =
		estimatedRawTokens >= config.minPruneRawTokens ||
		eligibleToolCallCount >= config.minPruneToolCalls;

	return {
		shouldPrune,
		rawCharCount,
		estimatedRawTokens,
		eligibleToolCallCount,
		reason: shouldPrune ? undefined : "below-threshold",
	};
}
