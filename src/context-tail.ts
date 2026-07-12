import type { ContextPruneConfig } from "./types.js";
import { estimateTokens } from "./token-estimator.js";

export interface ProtectedTailResult {
  protectedToolCallIds: Set<string>;
  estimatedTailTokens: number;
}

function estimateTextTokens(text: string, config: ContextPruneConfig): number {
  return estimateTokens(text, config).tokens;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function estimateValueTokens(value: unknown, config: ContextPruneConfig): number {
  return estimateTextTokens(stableStringify(value), config);
}

function estimateContentBlockTokens(block: unknown, config: ContextPruneConfig): number {
  if (block === undefined || block === null) return 0;
  if (typeof block === "string") return estimateTextTokens(block, config);
  if (typeof block !== "object") return estimateValueTokens(block, config);

  const record = block as Record<string, unknown>;
  const type = record.type;

  if (type === "text") return estimateTextTokens(String(record.text ?? ""), config);
  if (type === "toolCall") {
    return (
      estimateTextTokens(String(record.toolName ?? record.name ?? ""), config) +
      estimateValueTokens(record.args ?? record.input ?? {}, config)
    );
  }
  if (type === "toolResult")
    return estimateValueTokens(record.content ?? record.result ?? record.text ?? "", config);

  return estimateValueTokens(record, config);
}

function estimateMessageTokens(message: unknown, config: ContextPruneConfig): number {
  if (message === undefined || message === null) return 0;
  if (typeof message === "string") return estimateTextTokens(message, config);
  if (typeof message !== "object") return estimateValueTokens(message, config);

  const record = message as Record<string, unknown>;
  let total = estimateTextTokens(String(record.role ?? ""), config);
  const content = record.content;

  if (Array.isArray(content)) {
    for (const block of content) total += estimateContentBlockTokens(block, config);
  } else if (content !== undefined) {
    total += estimateContentBlockTokens(content, config);
  } else {
    total += estimateValueTokens(record, config);
  }

  return total;
}

function getToolResultId(message: any): string | undefined {
  if (message?.role !== "toolResult") return undefined;
  const id = message.toolCallId ?? message.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Computes which tool results are inside the newest protected final-context
 * tail. The walk counts every model-facing message, not only tool results.
 *
 * Boundary rule: include the whole message that crosses the configured budget.
 * This keeps the newest active message intact even when it is larger than the
 * tail budget by itself.
 */
export function computeProtectedTail(
  messages: any[],
  config: ContextPruneConfig,
): ProtectedTailResult {
  const budget = Number.isFinite(config.protectedTailTokens)
    ? Math.max(0, Math.floor(config.protectedTailTokens))
    : 0;
  const protectedToolCallIds = new Set<string>();
  if (budget <= 0) return { protectedToolCallIds, estimatedTailTokens: 0 };

  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const messageTokens = estimateMessageTokens(message, config);
    total += messageTokens;

    const toolCallId = getToolResultId(message);
    if (toolCallId) protectedToolCallIds.add(toolCallId);

    if (total >= budget) break;
  }

  return { protectedToolCallIds, estimatedTailTokens: total };
}
