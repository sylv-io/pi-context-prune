import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ContextPruneConfig, PreserveToolResultRule, PruneOn, PruneStrategy, SummarizerThinking, TokenEstimator, TokenizerEncoding } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, PRUNE_STRATEGY_MODES, SUMMARIZER_THINKING_LEVELS, TOKEN_ESTIMATOR_MODES, TOKENIZER_ENCODINGS } from "./types.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

function isPruneStrategy(value: unknown): value is PruneStrategy {
  return typeof value === "string" && PRUNE_STRATEGY_MODES.some((mode) => mode.value === value);
}

function isTokenEstimator(value: unknown): value is TokenEstimator {
  return typeof value === "string" && TOKEN_ESTIMATOR_MODES.some((mode) => mode.value === value);
}

function isTokenizerEncoding(value: unknown): value is TokenizerEncoding {
  return typeof value === "string" && TOKENIZER_ENCODINGS.some((encoding) => encoding.value === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringOrStringArray(value: unknown): value is string | string[] {
  return isNonEmptyString(value) || (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString));
}

function isPreserveToolResultRule(value: unknown): value is PreserveToolResultRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const rule = value as Record<string, unknown>;
  if (rule.toolName === undefined && rule.args === undefined) return false;
  if (rule.toolName !== undefined && !isStringOrStringArray(rule.toolName)) return false;
  if (rule.args !== undefined) {
    if (!rule.args || typeof rule.args !== "object" || Array.isArray(rule.args)) return false;
    const argPatterns = Object.values(rule.args);
    if (argPatterns.length === 0 || !argPatterns.every(isStringOrStringArray)) return false;
  }

  return true;
}

function normalizePreserveToolResults(value: unknown): PreserveToolResultRule[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.preserveToolResults;
  return value.filter(isPreserveToolResultRule);
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** Normalizes parsed config data. */
export function normalizeConfig(existing: unknown): ContextPruneConfig {
  const input = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const merged = { ...DEFAULT_CONFIG, ...(input as Record<string, unknown>) };
  return {
    ...merged,
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
    showPruneStatusLine:
      typeof merged.showPruneStatusLine === "boolean"
        ? merged.showPruneStatusLine
        : DEFAULT_CONFIG.showPruneStatusLine,
    pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
    pruneStrategy: isPruneStrategy(merged.pruneStrategy) ? merged.pruneStrategy : DEFAULT_CONFIG.pruneStrategy,
    summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
      ? merged.summarizerThinking
      : DEFAULT_CONFIG.summarizerThinking,
    remindUnprunedCount:
      typeof merged.remindUnprunedCount === "boolean"
        ? merged.remindUnprunedCount
        : DEFAULT_CONFIG.remindUnprunedCount,
    protectedTailTokens: normalizeNonNegativeNumber(merged.protectedTailTokens, DEFAULT_CONFIG.protectedTailTokens),
    tokenEstimator: isTokenEstimator(merged.tokenEstimator) ? merged.tokenEstimator : DEFAULT_CONFIG.tokenEstimator,
    tokenizerEncoding: isTokenizerEncoding(merged.tokenizerEncoding)
      ? merged.tokenizerEncoding
      : DEFAULT_CONFIG.tokenizerEncoding,
    charsPerToken: normalizePositiveNumber(merged.charsPerToken, DEFAULT_CONFIG.charsPerToken),
    preserveToolResults: normalizePreserveToolResults(merged.preserveToolResults),
  };
}

export function configForSave(config: ContextPruneConfig): Record<string, unknown> {
  const saved: Record<string, unknown> = { ...config };
  if (config.tokenEstimator === DEFAULT_CONFIG.tokenEstimator) delete saved.tokenEstimator;
  if (config.tokenizerEncoding === DEFAULT_CONFIG.tokenizerEncoding) delete saved.tokenizerEncoding;
  return saved;
}

/** Reads ~/.pi/agent/context-prune/settings.json and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes the config to ~/.pi/agent/context-prune/settings.json. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(configForSave(config), null, 2)}\n`);
}
