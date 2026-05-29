import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import type { SummaryToolCallRef } from "./summary-refs.js";

function estimateTokens(text: string, config: ContextPruneConfig): number {
  const charsPerToken = Number.isFinite(config.charsPerToken) && config.charsPerToken > 0 ? config.charsPerToken : 4;
  return Math.ceil(text.length / charsPerToken);
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  return entries
    .slice(0, 3)
    .map(([key, value]) => {
      const formatted = formatArgValue(value);
      const compact = formatted.length > 80 ? `${formatted.slice(0, 77)}…` : formatted;
      return `${key}: ${compact}`;
    })
    .join(", ");
}

function toolHint(toolName: string): string {
  if (toolName === "read" || toolName === "fetch_content" || toolName === "get_search_content") {
    return " Reread before relying on exact content.";
  }
  return "";
}

export function renderPlaceholderSummary(batch: CapturedBatch, refs: SummaryToolCallRef[], config: ContextPruneConfig): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  const lines = [
    `**Pruned tool refs**: ${refList}`,
    "Use `context_tree_query` with these refs to retrieve the original full outputs.",
    "",
  ];

  for (const [index, toolCall] of batch.toolCalls.entries()) {
    const ref = refs[index];
    const args = summarizeArgs(toolCall.args);
    const argsText = args ? ` — ${args}` : "";
    const status = toolCall.isError ? "Error" : "Success";
    const tokens = estimateTokens(toolCall.resultText, config);
    lines.push(
      `- **${toolCall.toolName}** \`${ref.shortId}\`${argsText} (${tokens} estimated tokens) — ${status}.${toolHint(toolCall.toolName)}`,
    );
  }

  return lines.join("\n");
}
