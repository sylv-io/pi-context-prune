import type { CapturedToolCall, PreserveToolResultRule } from "./types.js";

const normalizeForMatch = (value: string): string => value.replace(/\\/g, "/");

const globToRegExp = (glob: string): RegExp => {
  const pattern = normalizeForMatch(glob);
  let source = "^";

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*" && next === "*") {
      const afterNext = pattern[i + 2];
      if (afterNext === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (/[$()+.=[\]^{|}]/.test(char)) {
      source += `\\${char}`;
      continue;
    }

    source += char;
  }

  source += "$";
  return new RegExp(source);
};

const matchesPattern = (value: string, pattern: string): boolean => {
  return globToRegExp(pattern).test(normalizeForMatch(value));
};

const matchesAnyPattern = (value: unknown, patterns: string | string[]): boolean => {
  if (typeof value !== "string") return false;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((pattern) => matchesPattern(value, pattern));
};

const matchesToolName = (toolName: string, ruleToolName: PreserveToolResultRule["toolName"]): boolean => {
  if (ruleToolName === undefined) return true;
  const names = Array.isArray(ruleToolName) ? ruleToolName : [ruleToolName];
  return names.includes(toolName);
};

const matchesArgs = (
  args: Record<string, unknown>,
  patterns: Record<string, string | string[]> | undefined,
): boolean => {
  if (patterns === undefined) return true;
  return Object.entries(patterns).every(([key, value]) => matchesAnyPattern(args[key], value));
};

const hasConstraint = (rule: PreserveToolResultRule): boolean => {
  return rule.toolName !== undefined || (rule.args !== undefined && Object.keys(rule.args).length > 0);
};

export function shouldPreserveToolResult(
  toolCall: CapturedToolCall,
  rules: PreserveToolResultRule[] = [],
): boolean {
  return rules.some(
    (rule) => hasConstraint(rule) && matchesToolName(toolCall.toolName, rule.toolName) && matchesArgs(toolCall.args, rule.args),
  );
}
