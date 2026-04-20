/**
 * Context Filter — CWL eviction layer
 *
 * Dependency-aware, semantically-structured eviction that keeps context
 * utilization within the configured CWL threshold.
 *
 * All functions are pure — they return new arrays and never mutate inputs.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ChunkKind } from "./chunk.js";
import { estimateTokens } from "./compaction/compaction.js";

// ─── Tool name sets ────────────────────────────────────────────────────────────

const SEARCH_TOOLS = new Set(["grep", "glob", "find", "ls"]);
const BASH_TOOLS = new Set(["bash"]);
const READ_TOOLS = new Set(["read"]);

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ChunkSegment {
	name: string;
	kind: ChunkKind;
	dependencies: string[];
	description?: string;
	isCompleted: boolean;
	/**
	 * Inclusive message-array indices for the delimiter ToolResult messages that
	 * open/close this chunk.  endIdx equals the start delimiter index when the
	 * chunk is still open (active).
	 */
	msgRange: [number, number];
}

export interface CwlEvictionStep {
	step: "thinking" | "search_tools" | "bash_tools" | "read_tools" | "entire_chunk";
	removedAssistantMessages: number;
	removedToolCalls: number;
	removedToolResults: number;
	removedThinkingBlocks: number;
	removedFilePaths: string[];
	toolCallCounts: Record<string, number>;
	tokensBefore: number;
	tokensAfter: number;
}

export interface CwlChunkEvictionStats {
	chunkName: string;
	chunkKind: ChunkKind;
	dependencies: string[];
	fullyRemoved: boolean;
	steps: CwlEvictionStep[];
}

export interface FilterResult {
	messages: AgentMessage[];
	/** File paths collected from evicted read-tool calls, in order. */
	evictedFilePaths: string[];
	/** Chunk names evicted during this pass, in eviction order. */
	evictedChunkNames: string[];
	tokensBefore: number;
	tokensAfter: number;
	threshold: number;
	chunkStats: CwlChunkEvictionStats[];
}

export interface TokenCountOptions {
	initialTokens?: number | null;
	countTokens?: (messages: AgentMessage[]) => Promise<number | null | undefined>;
}

// ─── CWL limit ────────────────────────────────────────────────────────────────

export const DEFAULT_CWL_THRESHOLD_TOKENS = 80_000;

export type CwlLimit =
	| { type: "percent"; value: number } // e.g. 50  → keep ≤ 50% of context window
	| { type: "tokens"; value: number }; // e.g. 50000 → keep ≤ 50 000 tokens

export function getEffectiveCwlThreshold(contextWindowSize: number, limit?: CwlLimit | null): number {
	const requestedThreshold =
		limit?.type === "tokens"
			? limit.value
			: limit?.type === "percent"
				? contextWindowSize * (limit.value / 100)
				: DEFAULT_CWL_THRESHOLD_TOKENS;

	if (!Number.isFinite(requestedThreshold) || requestedThreshold <= 0) return 0;
	return Math.round(requestedThreshold);
}

/**
 * Parse a user-supplied CWL limit string.
 *
 * Accepted formats:
 *   "50%"    → { type: "percent", value: 50 }
 *   "50000"  → { type: "tokens",  value: 50000 }
 *   "50k"    → { type: "tokens",  value: 50000 }
 *   "200K"   → { type: "tokens",  value: 200000 }
 *
 * Returns null when the input cannot be parsed.
 */
export function parseCwlLimit(input: string): CwlLimit | null {
	const trimmed = input.trim();
	if (trimmed.endsWith("%")) {
		const n = parseFloat(trimmed.slice(0, -1));
		if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
		return { type: "percent", value: n };
	}
	const kMatch = trimmed.match(/^(\d+(?:\.\d+)?)[kK]$/);
	if (kMatch) {
		const n = parseFloat(kMatch[1]) * 1000;
		if (!Number.isFinite(n) || n <= 0) return null;
		return { type: "tokens", value: Math.round(n) };
	}
	const n = parseFloat(trimmed);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { type: "tokens", value: Math.round(n) };
}

// ─── Segmentation ──────────────────────────────────────────────────────────────

interface SegmentResult {
	preChunkIndices: Set<number>;
	segments: ChunkSegment[];
}

function isDelimiterResult(msg: AgentMessage): boolean {
	if (msg.role !== "toolResult") return false;
	const r = msg as ToolResultMessage;
	if (r.toolName !== "delimiter") return false;
	const details = r.details as { chunkEvent?: unknown } | undefined;
	return !!details?.chunkEvent;
}

function getChunkEvent(msg: AgentMessage): {
	action: "start" | "end";
	chunk: { name: string; type: ChunkKind; dependencies?: string[]; description?: string };
} | null {
	if (!isDelimiterResult(msg)) return null;
	const r = msg as ToolResultMessage;
	return (
		r.details as {
			chunkEvent: {
				action: "start" | "end";
				chunk: { name: string; type: ChunkKind; dependencies?: string[]; description?: string };
			};
		}
	).chunkEvent;
}

/**
 * Walk messages and group them into ChunkSegments.
 * Messages before the first start-delimiter are pre-chunk (permanent).
 */
export function segmentChunks(messages: AgentMessage[]): SegmentResult {
	const preChunkIndices = new Set<number>();
	const segments: ChunkSegment[] = [];

	// Track which chunk is currently open: name → segment index
	const openSegments = new Map<string, number>();
	let sawFirstStart = false;

	for (let i = 0; i < messages.length; i++) {
		const event = getChunkEvent(messages[i]);
		if (!event) {
			if (!sawFirstStart) preChunkIndices.add(i);
			continue;
		}

		if (event.action === "start") {
			sawFirstStart = true;
			const seg: ChunkSegment = {
				name: event.chunk.name,
				kind: event.chunk.type,
				dependencies: event.chunk.dependencies ?? [],
				description: event.chunk.description,
				isCompleted: false,
				msgRange: [i, i],
			};
			segments.push(seg);
			openSegments.set(event.chunk.name, segments.length - 1);
		} else {
			// "end" event
			const segIdx = openSegments.get(event.chunk.name);
			if (segIdx !== undefined) {
				const seg = segments[segIdx];
				seg.isCompleted = true;
				seg.msgRange[1] = i;
				// Merge description from end event if present
				if (event.chunk.description) seg.description = event.chunk.description;
				openSegments.delete(event.chunk.name);
			}
		}
	}

	// For open (uncompleted) segments, update endIdx to the last message
	for (const segIdx of openSegments.values()) {
		segments[segIdx].msgRange[1] = messages.length - 1;
	}

	return { preChunkIndices, segments };
}

// ─── Dependency graph ──────────────────────────────────────────────────────────

/**
 * Returns a map from each chunk name to the set of chunk names that depend on it.
 */
export function buildReverseDeps(segments: ChunkSegment[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const seg of segments) {
		for (const dep of seg.dependencies) {
			if (!map.has(dep)) map.set(dep, new Set());
			map.get(dep)!.add(seg.name);
		}
	}
	return map;
}

// ─── Eviction candidate selection ─────────────────────────────────────────────

export function isEvictionCandidate(
	seg: ChunkSegment,
	evictedNames: Set<string>,
	reverseDeps: Map<string, Set<string>>,
): boolean {
	if (!seg.isCompleted) return false;
	if (evictedNames.has(seg.name)) return false;
	// All reverse-dependents must already be evicted
	const dependents = reverseDeps.get(seg.name);
	if (dependents) {
		for (const dep of dependents) {
			if (!evictedNames.has(dep)) return false;
		}
	}
	return true;
}

// ─── Message mutation helpers ──────────────────────────────────────────────────

/**
 * Strip tool calls (by name set) from AssistantMessages in range.
 * Returns new messages array, removed tool-call IDs, and file paths from read calls.
 */
export function stripToolsFromRange(
	messages: AgentMessage[],
	rangeStart: number,
	rangeEnd: number,
	toolNames: Set<string>,
): {
	messages: AgentMessage[];
	removedIds: Set<string>;
	filePaths: string[];
	toolCallCounts: Record<string, number>;
	removedToolResults: number;
	removedAssistantMessages: number;
} {
	const removedIds = new Set<string>();
	const filePaths: string[] = [];
	const toolCallCounts: Record<string, number> = {};
	let removedAssistantMessages = 0;

	const newMessages = messages.map((msg, idx) => {
		if (idx < rangeStart || idx > rangeEnd) return msg;
		if (msg.role !== "assistant") return msg;

		const assistant = msg as AssistantMessage;
		const filteredContent = assistant.content.filter((block) => {
			if (block.type !== "toolCall") return true;
			if (!toolNames.has(block.name)) return true;
			toolCallCounts[block.name] = (toolCallCounts[block.name] ?? 0) + 1;
			// Collect read paths before removing
			if (block.name === "read") {
				const path = (block.arguments as { path?: string }).path;
				if (path) filePaths.push(path);
			}
			removedIds.add(block.id);
			return false;
		});

		// Drop the whole message if nothing remains
		if (filteredContent.length === 0) {
			removedAssistantMessages++;
			return null;
		}
		return { ...assistant, content: filteredContent } as AgentMessage;
	});

	// Drop ToolResult messages whose call was removed
	let removedToolResults = 0;
	const result = newMessages.filter((msg, _idx): msg is AgentMessage => {
		if (msg === null) return false;
		if (msg.role !== "toolResult") return true;
		const shouldKeep = !removedIds.has((msg as ToolResultMessage).toolCallId);
		if (!shouldKeep) removedToolResults++;
		return shouldKeep;
	});

	return { messages: result, removedIds, filePaths, toolCallCounts, removedToolResults, removedAssistantMessages };
}

interface StripThinkingResult {
	messages: AgentMessage[];
	removedThinkingBlocks: number;
	removedAssistantMessages: number;
}

function stripThinkingFromRangeWithStats(
	messages: AgentMessage[],
	rangeStart: number,
	rangeEnd: number,
): StripThinkingResult {
	let removedThinkingBlocks = 0;
	let removedAssistantMessages = 0;

	const result = messages
		.map((msg, idx) => {
			if (idx < rangeStart || idx > rangeEnd) return msg;
			if (msg.role !== "assistant") return msg;
			const assistant = msg as AssistantMessage;
			const filteredContent = assistant.content.filter((block) => {
				if (block.type !== "thinking") return true;
				removedThinkingBlocks++;
				return false;
			});
			if (filteredContent.length === assistant.content.length) return msg;
			if (filteredContent.length === 0) {
				removedAssistantMessages++;
				return null as unknown as AgentMessage;
			}
			return { ...assistant, content: filteredContent } as AgentMessage;
		})
		.filter((m): m is AgentMessage => m !== null);

	return { messages: result, removedThinkingBlocks, removedAssistantMessages };
}

/**
 * Strip thinking blocks from AssistantMessages in range.
 */
export function stripThinkingFromRange(messages: AgentMessage[], rangeStart: number, rangeEnd: number): AgentMessage[] {
	// After stripping, we need indices into the CURRENT messages array.
	// rangeStart/rangeEnd refer to the original indices, but after previous
	// strip operations the array may be shorter.  Callers are expected to
	// pass indices that are still valid in the current messages array.
	return stripThinkingFromRangeWithStats(messages, rangeStart, rangeEnd).messages;
}

/**
 * Remove all non-user messages whose index falls within [rangeStart, rangeEnd].
 * User messages are always preserved.
 * Indices refer to positions in the messages array at the time of the call.
 */
export function removeRange(messages: AgentMessage[], rangeStart: number, rangeEnd: number): AgentMessage[] {
	return messages.filter((msg, idx) => idx < rangeStart || idx > rangeEnd || msg.role === "user");
}

function countRemovableMessagesInRange(messages: AgentMessage[], rangeStart: number, rangeEnd: number): number {
	let count = 0;
	for (let idx = rangeStart; idx <= rangeEnd; idx++) {
		if (messages[idx]?.role !== "user") count++;
	}
	return count;
}

// ─── Token estimation ─────────────────────────────────────────────────────────

export function estimateTotal(messages: AgentMessage[]): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

// ─── Index mapping ─────────────────────────────────────────────────────────────

/**
 * Find the current indices of two anchor messages (by object identity).
 *
 * Delimiter ToolResult messages are never modified by `stripToolsFromRange`
 * (which only creates new objects for AssistantMessages), so they remain
 * identical objects across strip operations and can serve as stable anchors.
 *
 * Returns null if the start anchor is no longer present (already evicted).
 */
function mapRangeByAnchors(
	current: AgentMessage[],
	startAnchor: AgentMessage,
	endAnchor: AgentMessage,
): [number, number] | null {
	let start = -1;
	let end = -1;
	for (let i = 0; i < current.length; i++) {
		if (current[i] === startAnchor) start = i;
		if (current[i] === endAnchor) end = i;
	}
	if (start === -1) return null;
	// If end anchor was removed (shouldn't happen in normal flow) fall back to start
	if (end === -1) end = start;
	return [start, end];
}

// ─── Main filter ───────────────────────────────────────────────────────────────

/**
 * Evict messages from old, completed chunks until context utilization is within limit.
 *
 * @param limit  Optional CWL limit. Defaults to 80,000 tokens.
 *
 * Returns a view of the messages — the original array is never mutated.
 */
export function filterContext(messages: AgentMessage[], contextWindowSize: number, limit?: CwlLimit): FilterResult {
	if (contextWindowSize <= 0) {
		return {
			messages,
			evictedFilePaths: [],
			evictedChunkNames: [],
			tokensBefore: 0,
			tokensAfter: 0,
			threshold: 0,
			chunkStats: [],
		};
	}

	const threshold = getEffectiveCwlThreshold(contextWindowSize, limit);
	const tokensBefore = estimateTotal(messages);

	if (tokensBefore <= threshold) {
		return {
			messages,
			evictedFilePaths: [],
			evictedChunkNames: [],
			tokensBefore,
			tokensAfter: tokensBefore,
			threshold,
			chunkStats: [],
		};
	}

	const { segments } = segmentChunks(messages);
	const reverseDeps = buildReverseDeps(segments);

	const evictedNames = new Set<string>();
	const evictedFilePaths: string[] = [];
	const chunkStats: CwlChunkEvictionStats[] = [];

	// Work on a mutable copy (references, not deep clone)
	let current = [...messages];

	// Pre-compute stable anchor objects for each segment's range boundaries.
	// Delimiter ToolResult messages are never modified by stripToolsFromRange
	// (which only creates new objects for AssistantMessages), so they remain
	// identical objects across strip operations and can be used as anchors.
	const segmentAnchors: Array<{ start: AgentMessage; end: AgentMessage }> = segments.map((seg) => ({
		start: messages[seg.msgRange[0]],
		end: messages[seg.msgRange[1]],
	}));

	while (estimateTotal(current) > threshold) {
		let candidateIdx = -1;
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (!isEvictionCandidate(seg, evictedNames, reverseDeps)) continue;
			if (candidateIdx === -1 || seg.msgRange[0] < segments[candidateIdx].msgRange[0]) {
				candidateIdx = i;
			}
		}
		if (candidateIdx === -1) break;

		const seg = segments[candidateIdx];
		const anchors = segmentAnchors[candidateIdx];
		const steps: CwlEvictionStep[] = [];
		let fullyRemoved = false;

		const getRange = (): [number, number] | null => mapRangeByAnchors(current, anchors.start, anchors.end);
		const thresholdMet = (): boolean => estimateTotal(current) <= threshold;
		const recordToolStep = (step: CwlEvictionStep["step"], range: [number, number], toolNames: Set<string>): void => {
			const beforeTokens = estimateTotal(current);
			const beforeLength = current.length;
			const {
				messages: next,
				filePaths,
				toolCallCounts,
				removedIds,
				removedToolResults,
				removedAssistantMessages,
			} = stripToolsFromRange(current, range[0], range[1], toolNames);
			current = next;
			evictedFilePaths.push(...filePaths);
			const removedToolCalls = removedIds.size;
			const afterTokens = estimateTotal(current);
			if (
				removedToolCalls > 0 ||
				removedToolResults > 0 ||
				removedAssistantMessages > 0 ||
				beforeLength !== current.length
			) {
				steps.push({
					step,
					removedAssistantMessages,
					removedToolCalls,
					removedToolResults,
					removedThinkingBlocks: 0,
					removedFilePaths: filePaths,
					toolCallCounts,
					tokensBefore: beforeTokens,
					tokensAfter: afterTokens,
				});
			}
		};
		const recordThinkingStep = (range: [number, number]): void => {
			const beforeTokens = estimateTotal(current);
			const {
				messages: next,
				removedThinkingBlocks,
				removedAssistantMessages,
			} = stripThinkingFromRangeWithStats(current, range[0], range[1]);
			current = next;
			const afterTokens = estimateTotal(current);
			if (removedThinkingBlocks > 0 || removedAssistantMessages > 0) {
				steps.push({
					step: "thinking",
					removedAssistantMessages,
					removedToolCalls: 0,
					removedToolResults: 0,
					removedThinkingBlocks,
					removedFilePaths: [],
					toolCallCounts: {},
					tokensBefore: beforeTokens,
					tokensAfter: afterTokens,
				});
			}
		};
		const recordEntireChunkRemoval = (range: [number, number]): void => {
			const beforeTokens = estimateTotal(current);
			const removedMessages = countRemovableMessagesInRange(current, range[0], range[1]);
			const hadUserMessages = current.slice(range[0], range[1] + 1).some((msg) => msg.role === "user");
			current = removeRange(current, range[0], range[1]);
			const afterTokens = estimateTotal(current);
			steps.push({
				step: "entire_chunk",
				removedAssistantMessages: removedMessages,
				removedToolCalls: 0,
				removedToolResults: 0,
				removedThinkingBlocks: 0,
				removedFilePaths: [],
				toolCallCounts: {},
				tokensBefore: beforeTokens,
				tokensAfter: afterTokens,
			});
			fullyRemoved = removedMessages > 0 && !hadUserMessages;
		};

		if (seg.kind === "act") {
			const searchRange = getRange();
			if (searchRange) {
				recordToolStep("search_tools", searchRange, SEARCH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const bashRange = getRange();
			if (bashRange) {
				recordToolStep("bash_tools", bashRange, BASH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const readRange = getRange();
			if (readRange) {
				recordToolStep("read_tools", readRange, READ_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const removalRange = getRange();
			if (removalRange) {
				recordEntireChunkRemoval(removalRange);
			}
			evictedNames.add(seg.name);
			chunkStats.push({
				chunkName: seg.name,
				chunkKind: seg.kind,
				dependencies: seg.dependencies,
				fullyRemoved,
				steps,
			});
		} else {
			const thinkingRange = getRange();
			if (thinkingRange) {
				recordThinkingStep(thinkingRange);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const searchRange = getRange();
			if (searchRange) {
				recordToolStep("search_tools", searchRange, SEARCH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const bashRange = getRange();
			if (bashRange) {
				recordToolStep("bash_tools", bashRange, BASH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const readRange = getRange();
			if (readRange) {
				recordToolStep("read_tools", readRange, READ_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const removalRange = getRange();
			if (removalRange) {
				recordEntireChunkRemoval(removalRange);
			}
			evictedNames.add(seg.name);
			chunkStats.push({
				chunkName: seg.name,
				chunkKind: seg.kind,
				dependencies: seg.dependencies,
				fullyRemoved,
				steps,
			});
		}

		if (thresholdMet()) break;
	}

	return {
		messages: current,
		evictedFilePaths,
		evictedChunkNames: [...evictedNames],
		tokensBefore,
		tokensAfter: estimateTotal(current),
		threshold,
		chunkStats,
	};
}

export async function filterContextWithTokenCounter(
	messages: AgentMessage[],
	contextWindowSize: number,
	limit?: CwlLimit,
	options?: TokenCountOptions,
): Promise<FilterResult> {
	if (contextWindowSize <= 0) {
		return {
			messages,
			evictedFilePaths: [],
			evictedChunkNames: [],
			tokensBefore: 0,
			tokensAfter: 0,
			threshold: 0,
			chunkStats: [],
		};
	}

	const threshold = getEffectiveCwlThreshold(contextWindowSize, limit);
	let current = [...messages];
	const countedInitial =
		typeof options?.initialTokens === "number" && Number.isFinite(options.initialTokens) && options.initialTokens >= 0
			? options.initialTokens
			: await options?.countTokens?.(current);
	let currentTokens: number =
		typeof countedInitial === "number" && Number.isFinite(countedInitial) && countedInitial >= 0
			? countedInitial
			: estimateTotal(current);
	const tokensBefore = currentTokens;

	if (tokensBefore <= threshold) {
		return {
			messages,
			evictedFilePaths: [],
			evictedChunkNames: [],
			tokensBefore,
			tokensAfter: tokensBefore,
			threshold,
			chunkStats: [],
		};
	}

	const refreshCurrentTokens = async (): Promise<number> => {
		const counted = await options?.countTokens?.(current);
		if (typeof counted === "number" && Number.isFinite(counted) && counted >= 0) {
			currentTokens = counted;
			return currentTokens;
		}
		currentTokens = estimateTotal(current);
		return currentTokens;
	};

	const { segments } = segmentChunks(messages);
	const reverseDeps = buildReverseDeps(segments);
	const evictedNames = new Set<string>();
	const evictedFilePaths: string[] = [];
	const chunkStats: CwlChunkEvictionStats[] = [];
	const segmentAnchors: Array<{ start: AgentMessage; end: AgentMessage }> = segments.map((seg) => ({
		start: messages[seg.msgRange[0]],
		end: messages[seg.msgRange[1]],
	}));

	while (currentTokens > threshold) {
		let candidateIdx = -1;
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (!isEvictionCandidate(seg, evictedNames, reverseDeps)) continue;
			if (candidateIdx === -1 || seg.msgRange[0] < segments[candidateIdx].msgRange[0]) {
				candidateIdx = i;
			}
		}
		if (candidateIdx === -1) break;

		const seg = segments[candidateIdx];
		const anchors = segmentAnchors[candidateIdx];
		const steps: CwlEvictionStep[] = [];
		let fullyRemoved = false;

		const getRange = (): [number, number] | null => mapRangeByAnchors(current, anchors.start, anchors.end);
		const thresholdMet = (): boolean => currentTokens <= threshold;
		const recordToolStep = async (
			step: CwlEvictionStep["step"],
			range: [number, number],
			toolNames: Set<string>,
		): Promise<void> => {
			const beforeTokens = currentTokens;
			const beforeLength = current.length;
			const {
				messages: next,
				filePaths,
				toolCallCounts,
				removedIds,
				removedToolResults,
				removedAssistantMessages,
			} = stripToolsFromRange(current, range[0], range[1], toolNames);
			current = next;
			evictedFilePaths.push(...filePaths);
			const removedToolCalls = removedIds.size;
			const afterTokens = await refreshCurrentTokens();
			if (
				removedToolCalls > 0 ||
				removedToolResults > 0 ||
				removedAssistantMessages > 0 ||
				beforeLength !== current.length
			) {
				steps.push({
					step,
					removedAssistantMessages,
					removedToolCalls,
					removedToolResults,
					removedThinkingBlocks: 0,
					removedFilePaths: filePaths,
					toolCallCounts,
					tokensBefore: beforeTokens,
					tokensAfter: afterTokens,
				});
			}
		};
		const recordThinkingStep = async (range: [number, number]): Promise<void> => {
			const beforeTokens = currentTokens;
			const {
				messages: next,
				removedThinkingBlocks,
				removedAssistantMessages,
			} = stripThinkingFromRangeWithStats(current, range[0], range[1]);
			current = next;
			const afterTokens = await refreshCurrentTokens();
			if (removedThinkingBlocks > 0 || removedAssistantMessages > 0) {
				steps.push({
					step: "thinking",
					removedAssistantMessages,
					removedToolCalls: 0,
					removedToolResults: 0,
					removedThinkingBlocks,
					removedFilePaths: [],
					toolCallCounts: {},
					tokensBefore: beforeTokens,
					tokensAfter: afterTokens,
				});
			}
		};
		const recordEntireChunkRemoval = async (range: [number, number]): Promise<void> => {
			const beforeTokens = currentTokens;
			const removedMessages = countRemovableMessagesInRange(current, range[0], range[1]);
			const hadUserMessages = current.slice(range[0], range[1] + 1).some((msg) => msg.role === "user");
			current = removeRange(current, range[0], range[1]);
			const afterTokens = await refreshCurrentTokens();
			steps.push({
				step: "entire_chunk",
				removedAssistantMessages: removedMessages,
				removedToolCalls: 0,
				removedToolResults: 0,
				removedThinkingBlocks: 0,
				removedFilePaths: [],
				toolCallCounts: {},
				tokensBefore: beforeTokens,
				tokensAfter: afterTokens,
			});
			fullyRemoved = removedMessages > 0 && !hadUserMessages;
		};

		if (seg.kind === "act") {
			const searchRange = getRange();
			if (searchRange) {
				await recordToolStep("search_tools", searchRange, SEARCH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const bashRange = getRange();
			if (bashRange) {
				await recordToolStep("bash_tools", bashRange, BASH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const readRange = getRange();
			if (readRange) {
				await recordToolStep("read_tools", readRange, READ_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const removalRange = getRange();
			if (removalRange) {
				await recordEntireChunkRemoval(removalRange);
			}
			evictedNames.add(seg.name);
			chunkStats.push({
				chunkName: seg.name,
				chunkKind: seg.kind,
				dependencies: seg.dependencies,
				fullyRemoved,
				steps,
			});
		} else {
			const thinkingRange = getRange();
			if (thinkingRange) {
				await recordThinkingStep(thinkingRange);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const searchRange = getRange();
			if (searchRange) {
				await recordToolStep("search_tools", searchRange, SEARCH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const bashRange = getRange();
			if (bashRange) {
				await recordToolStep("bash_tools", bashRange, BASH_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const readRange = getRange();
			if (readRange) {
				await recordToolStep("read_tools", readRange, READ_TOOLS);
				if (thresholdMet()) {
					evictedNames.add(seg.name);
					chunkStats.push({
						chunkName: seg.name,
						chunkKind: seg.kind,
						dependencies: seg.dependencies,
						fullyRemoved,
						steps,
					});
					break;
				}
			}

			const removalRange = getRange();
			if (removalRange) {
				await recordEntireChunkRemoval(removalRange);
			}
			evictedNames.add(seg.name);
			chunkStats.push({
				chunkName: seg.name,
				chunkKind: seg.kind,
				dependencies: seg.dependencies,
				fullyRemoved,
				steps,
			});
		}

		if (thresholdMet()) break;
	}

	return {
		messages: current,
		evictedFilePaths,
		evictedChunkNames: [...evictedNames],
		tokensBefore,
		tokensAfter: currentTokens,
		threshold,
		chunkStats,
	};
}
