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
		'import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
		'import { tmpdir } from "node:os";',
		'import { join } from "node:path";',
		`import { DEFAULT_CONFIG, CUSTOM_TYPE_DIAGNOSTIC } from ${JSON.stringify(`${root}/src/types.ts`)};`,
		`import { loadConfigState, normalizeConfig, normalizeConfigPatch } from ${JSON.stringify(`${root}/src/config.ts`)};`,
		`import { PruneDiagnosticsStore } from ${JSON.stringify(`${root}/src/diagnostics.ts`)};`,
		`import { evaluatePruneGuard } from ${JSON.stringify(`${root}/src/prune-guard.ts`)};`,
		`import { computeProtectedTail } from ${JSON.stringify(`${root}/src/context-tail.ts`)};`,
		`import { shouldPreserveToolResult } from ${JSON.stringify(`${root}/src/preserve-tool-results.ts`)};`,
		"",
		'const config = { ...DEFAULT_CONFIG, charsPerToken: 4, tokenEstimator: "chars" };',
		"function batch(lengths, options = {}) {",
		"  return {",
		"    turnIndex: 1,",
		"    timestamp: 1,",
		'    assistantText: "",',
		"    toolCalls: lengths.map((length, index) => ({",
		'      toolCallId: (options.prefix ?? "tool") + "-" + index,',
		'      toolName: options.toolName ?? "test",',
		"      args: options.args ?? {},",
		'      resultText: "x".repeat(length),',
		"      isError: false,",
		"    })),",
		"  };",
		"}",
		"function resultMessage(toolCallId, length) {",
		'  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "x".repeat(length) }] };',
		"}",
		"",
		"// Config normalization accepts valid guard settings and rejects invalid ones.",
		"assert.equal(normalizeConfig({}).minPruneRawTokens, 8000);",
		"assert.equal(normalizeConfig({}).minPruneToolCalls, 8);",
		"assert.deepEqual(normalizeConfigPatch({ minPruneRawTokens: 1234, minPruneToolCalls: 3 }), {",
		"  minPruneRawTokens: 1234,",
		"  minPruneToolCalls: 3,",
		"});",
		"assert.deepEqual(normalizeConfigPatch({ minPruneRawTokens: -1, minPruneToolCalls: Number.NaN }), {});",
		"",
		"// Guard thresholds count only pruneable raw tokens and keep batches queued below threshold.",
		"const below = evaluatePruneGuard([batch([20000])], config);",
		"assert.equal(below.shouldPrune, false);",
		'assert.equal(below.reason, "below-threshold");',
		"assert.equal(below.eligibleToolCallCount, 1);",
		"assert.equal(below.estimatedRawTokens, 5000);",
		"const hugeSingle = evaluatePruneGuard([batch([32000])], config);",
		"assert.equal(hugeSingle.shouldPrune, true);",
		"assert.equal(hugeSingle.eligibleToolCallCount, 1);",
		"assert.equal(hugeSingle.estimatedRawTokens, 8000);",
		"const manySmall = evaluatePruneGuard([batch(Array(100).fill(10))], config);",
		"assert.equal(manySmall.shouldPrune, false);",
		"assert.equal(manySmall.eligibleToolCallCount, 100);",
		"",
		"// Protected tail tokens do not count toward the automatic threshold.",
		"const protectedBatch = batch([32000]);",
		'const protectedTail = computeProtectedTail([resultMessage("tool-0", 32000)], { ...config, protectedTailTokens: 1 });',
		"const protectedOnly = evaluatePruneGuard([protectedBatch], config, { protectedToolCallIds: protectedTail.protectedToolCallIds });",
		"assert.equal(protectedOnly.shouldPrune, false);",
		"assert.equal(protectedOnly.eligibleToolCallCount, 0);",
		"assert.equal(protectedOnly.estimatedRawTokens, 0);",
		"",
		"// preserveToolResults matches do not count toward the automatic threshold.",
		'const preservedOnly = evaluatePruneGuard([batch([32000], { toolName: "read", args: { path: "/repo/AGENTS.md" } })], config, {',
		'  preserveToolResults: [{ toolName: "read", args: { path: "**/AGENTS.md" } }],',
		"});",
		"assert.equal(preservedOnly.shouldPrune, false);",
		"assert.equal(preservedOnly.eligibleToolCallCount, 0);",
		"assert.equal(preservedOnly.estimatedRawTokens, 0);",
		"",
		"// Already summarized and excluded tools do not count toward the automatic threshold.",
		'const summarizedOnly = evaluatePruneGuard([batch([32000])], config, { isSummarized: (id) => id === "tool-0" });',
		"assert.equal(summarizedOnly.shouldPrune, false);",
		"assert.equal(summarizedOnly.eligibleToolCallCount, 0);",
		'const excludedOnly = evaluatePruneGuard([batch([32000], { toolName: "context_prune" })], config, { excludeToolNames: ["context_prune"] });',
		"assert.equal(excludedOnly.shouldPrune, false);",
		"assert.equal(excludedOnly.eligibleToolCallCount, 0);",
		"",
		"// Mixed batches count only pruneable raw tokens.",
		"const mixedBatch = batch([32000, 20000]);",
		'const mixed = evaluatePruneGuard([mixedBatch], config, { protectedToolCallIds: new Set(["tool-0"]) });',
		"assert.equal(mixed.shouldPrune, false);",
		"assert.equal(mixed.eligibleToolCallCount, 1);",
		"assert.equal(mixed.estimatedRawTokens, 5000);",
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
		"// Project settings are loaded only for trusted projects.",
		'const trustRoot = mkdtempSync(join(tmpdir(), "pi-context-prune-trust-"));',
		'const trustProject = join(trustRoot, "workspace", "nested");',
		'mkdirSync(join(trustRoot, ".pi", "context-prune"), { recursive: true });',
		'mkdirSync(trustProject, { recursive: true });',
		'const trustSettingsPath = join(trustRoot, ".pi", "context-prune", "settings.json");',
		'writeFileSync(trustSettingsPath, JSON.stringify({ enabled: false }));',
		"const untrustedState = await loadConfigState(trustProject, false);",
		"assert.equal(untrustedState.projectPath, undefined);",
		"assert.equal(untrustedState.project, undefined);",
		"const trustedState = await loadConfigState(trustProject, true);",
		"assert.equal(trustedState.projectPath, trustSettingsPath);",
		"assert.equal(trustedState.project?.enabled, false);",
		"assert.equal(trustedState.effective.enabled, false);",
		"rmSync(trustRoot, { recursive: true, force: true });",
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
