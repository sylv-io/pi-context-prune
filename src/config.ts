import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ContextPruneConfig, PreserveToolResultRule, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

/** Path to the extension's own settings file, independent of any project. */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-prune", "settings.json");

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
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

/** Reads ~/.pi/agent/context-prune/settings.json and returns the config (or defaults). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const existing = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...existing };
    return {
      ...merged,
      enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_CONFIG.enabled,
      showPruneStatusLine:
        typeof merged.showPruneStatusLine === "boolean"
          ? merged.showPruneStatusLine
          : DEFAULT_CONFIG.showPruneStatusLine,
      pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
      summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
        ? merged.summarizerThinking
        : DEFAULT_CONFIG.summarizerThinking,
      remindUnprunedCount:
        typeof merged.remindUnprunedCount === "boolean"
          ? merged.remindUnprunedCount
          : DEFAULT_CONFIG.remindUnprunedCount,
      protectedTailTokens: normalizeNonNegativeNumber(merged.protectedTailTokens, DEFAULT_CONFIG.protectedTailTokens),
      charsPerToken: normalizePositiveNumber(merged.charsPerToken, DEFAULT_CONFIG.charsPerToken),
      preserveToolResults: normalizePreserveToolResults(merged.preserveToolResults),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Writes the full config to ~/.pi/agent/context-prune/settings.json. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
