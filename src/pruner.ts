import type { ToolCallIndexer } from "./indexer.js";

/**
 * Filters the `context` event message array.
 * Removes ToolResultMessage entries where toolCallId is in the index.
 * Keeps ALL other messages including AssistantMessages with tool-call blocks.
 */
export function pruneMessages(
  messages: any[],
  indexer: ToolCallIndexer,
  protectedToolCallIds = new Set<string>(),
): any[] {
  return messages.filter((msg) => {
    // Only remove indexed toolResult messages outside the protected context tail.
    if (
      msg.role === "toolResult" &&
      indexer.isSummarized(msg.toolCallId) &&
      !protectedToolCallIds.has(msg.toolCallId)
    ) {
      return false;
    }
    return true;
  });
}
