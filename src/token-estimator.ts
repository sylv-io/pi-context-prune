import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { ContextPruneConfig, TokenizerEncoding } from "./types.js";

type TokenEstimateMethod = "tiktoken" | "chars";

export interface TokenEstimate {
  tokens: number;
  method: TokenEstimateMethod;
  encoding?: TokenizerEncoding;
}

const encoders = new Map<TokenizerEncoding, Tiktoken>();

function estimateChars(text: string, config: ContextPruneConfig): TokenEstimate {
  const charsPerToken = Number.isFinite(config.charsPerToken) && config.charsPerToken > 0 ? config.charsPerToken : 4;
  return {
    tokens: text.length === 0 ? 0 : Math.ceil(text.length / charsPerToken),
    method: "chars",
  };
}

function getEncoder(encoding: TokenizerEncoding): Tiktoken {
  const cached = encoders.get(encoding);
  if (cached) return cached;

  const ranks = encoding === "cl100k_base" ? cl100kBase : encoding === "o200k_base" ? o200kBase : undefined;
  if (!ranks) throw new Error(`Unsupported tokenizer encoding: ${encoding}`);

  const encoder = new Tiktoken(ranks);
  encoders.set(encoding, encoder);
  return encoder;
}

export function estimateTokens(text: string, config: ContextPruneConfig): TokenEstimate {
  if (config.tokenEstimator === "chars") return estimateChars(text, config);

  try {
    const encoding = config.tokenizerEncoding;
    const encoder = getEncoder(encoding);
    return {
      tokens: encoder.encode(text).length,
      method: "tiktoken",
      encoding,
    };
  } catch {
    return estimateChars(text, config);
  }
}
