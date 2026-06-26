#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const tmp = mkdtempSync(join(tmpdir(), "pi-context-prune-validate-"));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		stdio: options.stdio ?? "inherit",
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with ${result.status}`,
		);
	}
	return result;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertSourceOrder() {
	const indexSource = readFileSync(join(root, "index.ts"), "utf8");
	const commandsSource = readFileSync(join(root, "src", "commands.ts"), "utf8");

	function region(label, startNeedle, endNeedle, source = indexSource) {
		const start = source.indexOf(startNeedle);
		const end = source.indexOf(endNeedle, start + startNeedle.length);
		assert(start >= 0 && end > start, `${label} region not found`);
		return source.slice(start, end);
	}

	const guardReturn = indexSource.indexOf(
		'return { ok: false, reason: "below-threshold" };',
	);
	const drain = indexSource.indexOf("pendingBatches.length = 0;");
	const firstFrontierAdvance = indexSource.indexOf(
		"frontier.advance(frontierSnapshot);",
	);

	assert(guardReturn > 0, "below-threshold return is missing");
	assert(
		drain > guardReturn,
		"below-threshold skip must return before draining pending batches",
	);
	assert(
		firstFrontierAdvance > guardReturn,
		"below-threshold skip must return before frontier advance",
	);
	assert(
		indexSource.includes("if (!options.force && !guard.shouldPrune)"),
		"force option must bypass the minimum prune guard",
	);

	assert(
		commandsSource.includes('subArgs.includes("--force")'),
		"/pruner now --force parsing is missing",
	);
	assert(
		commandsSource.includes("/pruner diagnostics"),
		"/pruner diagnostics help text is missing",
	);
	const initialStatusUpdate = indexSource.indexOf(
		"setPruneStatusWidgetBestEffort(",
	);
	const initialStatusStrategy = indexSource.indexOf(
		"usePlaceholderStrategy ?",
		initialStatusUpdate,
	);
	assert(
		initialStatusUpdate > 0 && initialStatusStrategy > initialStatusUpdate,
		"initial flush status update must be best-effort",
	);

	const sessionIndexRegion = region(
		"session index",
		"const persistBatchIndex = (",
		"};\n\n  // ── Helper: capture",
	);
	const sessionIndexAppend = sessionIndexRegion.indexOf(
		"appendEntry(CUSTOM_TYPE_INDEX",
	);
	const sessionIndexSet = sessionIndexRegion.indexOf("indexer.getIndex().set");
	assert(
		sessionIndexAppend >= 0 && sessionIndexSet > sessionIndexAppend,
		"session index memory update must happen after index append",
	);

	const runtimeSummaryRegion = region(
		"runtime summary persistence",
		'if (delivery === "runtime") {\n              pi.sendMessage',
		"} else {\n              appendSummaryMessage",
	);
	const runtimeAddBatch = runtimeSummaryRegion.indexOf(
		"indexer.addBatch(batch, pi)",
	);
	const runtimeRegisterRefs = runtimeSummaryRegion.indexOf(
		"indexer.registerSummaryRefs(summaryRefs)",
	);
	assert(
		runtimeAddBatch >= 0 && runtimeRegisterRefs > runtimeAddBatch,
		"runtime summary refs must register after index append and memory update",
	);

	const sessionSummaryRegion = region(
		"session summary persistence",
		"} else {\n              appendSummaryMessage",
		"}\n          } else {",
	);
	const sessionPersistIndex = sessionSummaryRegion.indexOf(
		"persistBatchIndex(batch, appendEntry)",
	);
	const sessionRegisterRefs = sessionSummaryRegion.indexOf(
		"indexer.registerSummaryRefs(summaryRefs)",
	);
	assert(
		sessionPersistIndex >= 0 && sessionRegisterRefs > sessionPersistIndex,
		"session summary refs must register after index append and memory update",
	);

	const runtimeFrontierRegion = region(
		"runtime frontier persistence",
		'if (delivery === "runtime") {\n          pi.appendEntry(CUSTOM_TYPE_FRONTIER',
		"} else {\n          appendEntry(CUSTOM_TYPE_FRONTIER",
	);
	const runtimeFrontierAppend = runtimeFrontierRegion.indexOf(
		"pi.appendEntry(CUSTOM_TYPE_FRONTIER",
	);
	const runtimeFrontierAdvance = runtimeFrontierRegion.indexOf(
		"frontier.advance(frontierSnapshot)",
	);
	assert(
		runtimeFrontierAppend >= 0 &&
			runtimeFrontierAdvance > runtimeFrontierAppend,
		"runtime frontier memory update must happen after frontier append",
	);

	const sessionFrontierRegion = region(
		"session frontier persistence",
		"} else {\n          appendEntry(CUSTOM_TYPE_FRONTIER",
		"try {\n            appendEntry(CUSTOM_TYPE_STATS",
	);
	const sessionFrontierAppend = sessionFrontierRegion.indexOf(
		"appendEntry(CUSTOM_TYPE_FRONTIER",
	);
	const sessionFrontierAdvance = sessionFrontierRegion.indexOf(
		"frontier.advance(frontierSnapshot)",
	);
	assert(
		sessionFrontierAppend >= 0 &&
			sessionFrontierAdvance > sessionFrontierAppend,
		"session frontier memory update must happen after frontier append",
	);

	const indexerSource = readFileSync(join(root, "src", "indexer.ts"), "utf8");
	const runtimeAppend = indexerSource.indexOf(
		"pi.appendEntry(CUSTOM_TYPE_INDEX",
	);
	const runtimeSet = indexerSource.indexOf("this.index.set", runtimeAppend);
	assert(
		runtimeAppend > 0 && runtimeSet > runtimeAppend,
		"runtime index memory update must happen after index append",
	);
}

function writeHarness() {
	const source = [
		'import { strict as assert } from "node:assert";',
		'import { readFileSync } from "node:fs";',
		`import { DEFAULT_CONFIG, CUSTOM_TYPE_DIAGNOSTIC } from ${JSON.stringify(`${root}/src/types.ts`)};`,
		`import { normalizeConfig, normalizeConfigPatch } from ${JSON.stringify(`${root}/src/config.ts`)};`,
		`import { PruneDiagnosticsStore } from ${JSON.stringify(`${root}/src/diagnostics.ts`)};`,
		`import { evaluatePruneGuard } from ${JSON.stringify(`${root}/src/prune-guard.ts`)};`,
		`import { shouldPreserveToolResult } from ${JSON.stringify(`${root}/src/preserve-tool-results.ts`)};`,
		"",
		'const config = { ...DEFAULT_CONFIG, charsPerToken: 4, tokenEstimator: "chars" };',
		"function batch(lengths) {",
		"  return {",
		"    turnIndex: 1,",
		"    timestamp: 1,",
		'    assistantText: "",',
		"    toolCalls: lengths.map((length, index) => ({",
		'      toolCallId: "tool-" + index,',
		'      toolName: "test",',
		"      args: {},",
		'      resultText: "x".repeat(length),',
		"      isError: false,",
		"    })),",
		"  };",
		"}",
		"",
		"// Config normalization accepts valid guard settings and rejects invalid ones.",
		"assert.equal(normalizeConfig({}).minPruneRawTokens, 4000);",
		"assert.equal(normalizeConfig({}).minPruneToolCalls, 8);",
		"assert.deepEqual(normalizeConfigPatch({ minPruneRawTokens: 1234, minPruneToolCalls: 3 }), {",
		"  minPruneRawTokens: 1234,",
		"  minPruneToolCalls: 3,",
		"});",
		"assert.deepEqual(normalizeConfigPatch({ minPruneRawTokens: -1, minPruneToolCalls: Number.NaN }), {});",
		"",
		"// Guard thresholds cover tiny skip, huge single output, and many small outputs.",
		"const tiny = evaluatePruneGuard([batch([100])], config);",
		"assert.equal(tiny.shouldPrune, false);",
		'assert.equal(tiny.reason, "below-threshold");',
		"assert.equal(tiny.eligibleToolCallCount, 1);",
		"const hugeSingle = evaluatePruneGuard([batch([16000])], config);",
		"assert.equal(hugeSingle.shouldPrune, true);",
		"assert.equal(hugeSingle.eligibleToolCallCount, 1);",
		"assert.equal(hugeSingle.estimatedRawTokens, 4000);",
		"const manySmall = evaluatePruneGuard([batch(Array(8).fill(10))], config);",
		"assert.equal(manySmall.shouldPrune, true);",
		"assert.equal(manySmall.eligibleToolCallCount, 8);",
		"",
		"// Diagnostics are append-only custom entries and reconstruct from session metadata.",
		"const diagnostic = {",
		"  timestamp: 1,",
		'  trigger: "agent-message",',
		'  pruneStrategy: "placeholder",',
		'  batchingMode: "turn",',
		"  protectedTailTokens: 16000,",
		'  delivery: "session",',
		"  attemptedBatchCount: 1,",
		"  eligibleToolCallCount: 2,",
		"  prunedToolCallCount: 2,",
		"  rawCharCount: 100,",
		"  estimatedRawTokens: 25,",
		"  replacementCharCount: 20,",
		"  estimatedReplacementTokens: 5,",
		'  frontierToolCallId: "tool-2",',
		'  frontierOutcome: "summarized",',
		"};",
		"const store = new PruneDiagnosticsStore();",
		"const persisted = [];",
		"store.record(diagnostic, (customType, data) => persisted.push({ customType, data }));",
		"assert.equal(store.getEntries().length, 1);",
		"assert.equal(persisted[0].customType, CUSTOM_TYPE_DIAGNOSTIC);",
		"assert.deepEqual(persisted[0].data, diagnostic);",
		"const reconstructed = new PruneDiagnosticsStore();",
		"reconstructed.reconstructFromSession({",
		"  sessionManager: {",
		"    getBranch: () => [",
		'      { type: "message", message: { role: "user", content: "not diagnostics" } },',
		'      { type: "custom", customType: CUSTOM_TYPE_DIAGNOSTIC, data: diagnostic },',
		"    ],",
		"  },",
		"});",
		"assert.deepEqual(reconstructed.getEntries(), [diagnostic]);",
		"",
		"// Preserve rules keep instruction/non-read tools and drop generic docs.",
		"const rules = [",
		'  { toolName: "read", args: { path: ["**/skills/**/*.md", "**/SKILL.md", "**/AGENTS.md"] } },',
		'  { toolName: "AskUserQuestion" },',
		'  { toolName: "context_tree_query" },',
		'  { toolName: "todo" },',
		"];",
		'assert.equal(shouldPreserveToolResult({ toolName: "read", args: { path: "/repo/AGENTS.md" } }, rules), true);',
		'assert.equal(shouldPreserveToolResult({ toolName: "read", args: { path: "/repo/foo/SKILL.md" } }, rules), true);',
		'assert.equal(shouldPreserveToolResult({ toolName: "read", args: { path: "/repo/skills/domain/SKILL.md" } }, rules), true);',
		'assert.equal(shouldPreserveToolResult({ toolName: "read", args: { path: "/repo/docs/README.md" } }, rules), false);',
		'assert.equal(shouldPreserveToolResult({ toolName: "read", args: { path: "/repo/docs/foo.md" } }, rules), false);',
		'assert.equal(shouldPreserveToolResult({ toolName: "todo", args: {} }, rules), true);',
		'assert.equal(shouldPreserveToolResult({ toolName: "context_tree_query", args: {} }, rules), true);',
		'assert.equal(shouldPreserveToolResult({ toolName: "AskUserQuestion", args: {} }, rules), true);',
		"",
	].join("\n");
	const harness = join(tmp, "validation-harness.ts");
	writeFileSync(harness, source);
	return harness;
}

assertSourceOrder();

const bundledIndex = join(tmp, "pi-context-prune-index.mjs");
run("npx", [
	"--yes",
	"esbuild",
	"index.ts",
	"--bundle",
	"--platform=node",
	"--format=esm",
	"--external:@mariozechner/*",
	"--external:@sinclair/*",
	`--outfile=${bundledIndex}`,
]);

const harness = writeHarness();
const bundledHarness = join(tmp, "validation-harness.mjs");
run("npx", [
	"--yes",
	"esbuild",
	harness,
	"--bundle",
	"--platform=node",
	"--format=esm",
	"--external:@mariozechner/*",
	`--outfile=${bundledHarness}`,
]);
run("node", [bundledHarness]);

console.log("context-prune validation passed");
