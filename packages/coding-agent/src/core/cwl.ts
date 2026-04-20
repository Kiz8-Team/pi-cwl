/**
 * CWL – Context Window Layer
 *
 * A lightweight context-optimization layer for pi's coding agent.
 *
 * processContext():
 *  1. Runs the dependency-aware eviction filter to keep utilization within the configured CWL threshold.
 *
 * This is called inside the agent's transformContext hook (before each LLM call).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type CwlChunkEvictionStats,
	type CwlLimit,
	filterContext,
	filterContextWithTokenCounter,
	type TokenCountOptions,
} from "./context-filter.js";

export type { CwlLimit } from "./context-filter.js";

export interface ProcessContextResult {
	messages: AgentMessage[];
	evictedChunkNames: string[];
	notedFilePaths: string[];
	tokensBefore: number;
	tokensAfter: number;
	threshold: number;
	chunkStats: CwlChunkEvictionStats[];
}

/**
 * Full CWL pipeline: eviction.
 *
 * @param messages  Current agent message list (from transformContext).
 * @param contextWindowSize  Model context window token count (0 = skip eviction).
 * @param limit  Optional CWL limit (percent or raw token count). Defaults to 150,000 tokens.
 * @returns Filtered message list ready for the LLM.
 */
export function processContextWithStats(
	messages: AgentMessage[],
	contextWindowSize: number,
	limit?: CwlLimit,
): ProcessContextResult {
	const {
		messages: filtered,
		evictedChunkNames,
		tokensBefore,
		tokensAfter,
		threshold,
		chunkStats,
	} = filterContext(messages, contextWindowSize, limit);

	return {
		messages: filtered,
		evictedChunkNames,
		notedFilePaths: [],
		tokensBefore,
		tokensAfter,
		threshold,
		chunkStats,
	};
}

export async function processContextWithStatsAsync(
	messages: AgentMessage[],
	contextWindowSize: number,
	limit?: CwlLimit,
	tokenCountOptions?: TokenCountOptions,
): Promise<ProcessContextResult> {
	const {
		messages: filtered,
		evictedChunkNames,
		tokensBefore,
		tokensAfter,
		threshold,
		chunkStats,
	} = await filterContextWithTokenCounter(messages, contextWindowSize, limit, tokenCountOptions);

	return {
		messages: filtered,
		evictedChunkNames,
		notedFilePaths: [],
		tokensBefore,
		tokensAfter,
		threshold,
		chunkStats,
	};
}

export function processContext(messages: AgentMessage[], contextWindowSize: number, limit?: CwlLimit): AgentMessage[] {
	return processContextWithStats(messages, contextWindowSize, limit).messages;
}
