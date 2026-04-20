import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage, AgentState } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, ToolCall, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { getCwlTracesDir } from "../config.js";
import type { ChunkDetails, ChunkEvent } from "./chunk.js";
import { type CwlChunkEvictionStats, DEFAULT_CWL_THRESHOLD_TOKENS } from "./context-filter.js";
import {
	type BashExecutionMessage,
	bashExecutionToText,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.js";
import type { SessionEntry, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

interface TraceMessageRecord {
	id: string;
	message: AgentMessage;
}

interface TraceBoundary extends ChunkEvent {
	msg: string;
	part: number;
}

export interface CwlCleanupTraceRecord {
	sequence: number;
	timestamp: number;
	time: string;
	evictedChunks: number;
	notedFilePaths: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensRemoved: number;
	threshold: number;
	evictedMessageIds: string[];
	utilization: {
		before: number | null;
		after: number | null;
	};
	stats: {
		chunks: CwlChunkEvictionStats[];
		steps: number;
		removed: {
			assistantMessages: number;
			toolCalls: number;
			toolResults: number;
			thinkingBlocks: number;
		};
		toolCallCounts: Record<string, number>;
		filePaths: string[];
		stepBreakdown: Record<CwlChunkEvictionStats["steps"][number]["step"], number>;
	};
}

interface PreviousTrace {
	trace?: {
		cleanups?: {
			history?: CwlCleanupTraceRecord[];
		};
	};
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			if ((item as { type?: string }).type === "text") return String((item as { text?: string }).text ?? "");
			if ((item as { type?: string }).type === "image") {
				const mimeType = (item as { mimeType?: string }).mimeType ?? "image";
				return `[image:${mimeType}]`;
			}
			return "";
		})
		.join("\n");
}

function getTracePath(sessionFile: string, cwd: string): string {
	return join(getCwlTracesDir(cwd), `${basename(sessionFile, ".jsonl")}.json`);
}

function pct(numerator: number, denominator: number): number | null {
	return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function summarizeCleanup(
	cleanup: Pick<
		CwlCleanupTraceRecord,
		"evictedChunks" | "notedFilePaths" | "tokensBefore" | "tokensAfter" | "threshold" | "evictedMessageIds"
	> & {
		chunkStats: CwlChunkEvictionStats[];
		sequence?: number;
		timestamp?: number;
	},
): CwlCleanupTraceRecord {
	const toolCallCounts = new Map<string, number>();
	const filePaths = new Set<string>();
	const stepBreakdown: CwlCleanupTraceRecord["stats"]["stepBreakdown"] = {
		thinking: 0,
		search_tools: 0,
		bash_tools: 0,
		read_tools: 0,
		entire_chunk: 0,
	};
	let steps = 0;
	let removedAssistantMessages = 0;
	let removedToolCalls = 0;
	let removedToolResults = 0;
	let removedThinkingBlocks = 0;
	for (const chunk of cleanup.chunkStats) {
		for (const step of chunk.steps) {
			steps += 1;
			stepBreakdown[step.step] += 1;
			removedAssistantMessages += step.removedAssistantMessages;
			removedToolCalls += step.removedToolCalls;
			removedToolResults += step.removedToolResults;
			removedThinkingBlocks += step.removedThinkingBlocks;
			for (const path of step.removedFilePaths) filePaths.add(path);
			for (const [toolName, count] of Object.entries(step.toolCallCounts)) {
				toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + count);
			}
		}
	}
	const timestamp = cleanup.timestamp ?? Date.now();
	return {
		sequence: cleanup.sequence ?? 0,
		timestamp,
		time: new Date(timestamp).toISOString(),
		evictedChunks: cleanup.evictedChunks,
		notedFilePaths: cleanup.notedFilePaths,
		tokensBefore: cleanup.tokensBefore,
		tokensAfter: cleanup.tokensAfter,
		tokensRemoved: Math.max(0, cleanup.tokensBefore - cleanup.tokensAfter),
		threshold: cleanup.threshold,
		evictedMessageIds: cleanup.evictedMessageIds ?? [],
		utilization: {
			before: pct(cleanup.tokensBefore, cleanup.threshold),
			after: pct(cleanup.tokensAfter, cleanup.threshold),
		},
		stats: {
			chunks: cleanup.chunkStats,
			steps,
			removed: {
				assistantMessages: removedAssistantMessages,
				toolCalls: removedToolCalls,
				toolResults: removedToolResults,
				thinkingBlocks: removedThinkingBlocks,
			},
			toolCallCounts: Object.fromEntries([...toolCallCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
			filePaths: [...filePaths],
			stepBreakdown,
		},
	};
}

function getToolResultMap(messages: TraceMessageRecord[]): Map<string, ToolResultMessage> {
	const results = new Map<string, ToolResultMessage>();
	for (const item of messages) {
		if (item.message.role === "toolResult") {
			results.set(item.message.toolCallId, item.message as ToolResultMessage);
		}
	}
	return results;
}

function buildTraceMessages(entries: SessionEntry[], mode: "full" | "active"): TraceMessageRecord[] {
	const records: TraceMessageRecord[] = [];

	const appendEntryMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			records.push({ id: entry.id, message: entry.message });
			return;
		}
		if (entry.type === "custom_message") {
			records.push({
				id: entry.id,
				message: createCustomMessage(
					entry.customType,
					entry.content,
					entry.display,
					entry.details,
					entry.timestamp,
				),
			});
			return;
		}
		if (entry.type === "branch_summary" && entry.summary) {
			records.push({
				id: entry.id,
				message: createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
			});
			return;
		}
		if (entry.type === "compaction") {
			records.push({
				id: entry.id,
				message: createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			});
		}
	};

	if (mode === "full") {
		for (const entry of entries) appendEntryMessage(entry);
		return records;
	}

	let compaction: SessionEntry | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") {
			compaction = entries[i];
			break;
		}
	}
	if (!compaction || compaction.type !== "compaction") {
		for (const entry of entries) appendEntryMessage(entry);
		return records;
	}

	records.push({
		id: compaction.id,
		message: createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp),
	});

	const compactionIndex = entries.findIndex((entry) => entry.id === compaction.id);
	let foundFirstKept = false;
	for (let i = 0; i < compactionIndex; i++) {
		const entry = entries[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) appendEntryMessage(entry);
	}
	for (let i = compactionIndex + 1; i < entries.length; i++) {
		appendEntryMessage(entries[i]);
	}
	return records;
}

function serializeMessages(records: TraceMessageRecord[]) {
	const toolResults = getToolResultMap(records);
	const serialized: Array<Record<string, unknown>> = [];

	for (const item of records) {
		const message = item.message;
		if (message.role === "toolResult") continue;

		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			serialized.push({
				info: {
					id: item.id,
					role: "assistant",
					modelID: assistant.model,
					time: { created: assistant.timestamp, completed: assistant.timestamp },
					finish: assistant.stopReason,
					tokens: {
						total: assistant.usage.totalTokens,
						input: assistant.usage.input,
						output: assistant.usage.output,
						reasoning: assistant.content
							.filter((part) => part.type === "thinking")
							.map((part) => (part.type === "thinking" ? part.thinking.length : 0))
							.reduce((sum, value) => sum + value, 0),
						cache: {
							read: assistant.usage.cacheRead,
							write: assistant.usage.cacheWrite,
						},
					},
				},
				parts: assistant.content.map((part) => {
					if (part.type === "text") return { type: "text", text: part.text };
					if (part.type === "thinking") return { type: "reasoning", text: part.thinking };

					const toolCall = part as ToolCall;
					const result = toolResults.get(toolCall.id);
					const metadata: Record<string, unknown> = {};
					if (result?.details !== undefined) metadata.details = result.details;
					if (toolCall.name === "delimiter") {
						const details = result?.details as ChunkDetails | undefined;
						if (details?.chunkEvent) metadata.event = details.chunkEvent;
					}
					return {
						type: "tool",
						tool: toolCall.name,
						callID: toolCall.id,
						state: {
							status: result ? (result.isError ? "error" : "completed") : "pending",
							input: toolCall.arguments,
							output: result ? contentToText(result.content) : "",
							metadata,
							time: { start: assistant.timestamp, end: result?.timestamp ?? assistant.timestamp },
						},
					};
				}),
			});
			continue;
		}

		let text = "";
		let role = "user";
		if (message.role === "user") {
			text = contentToText((message as UserMessage).content);
		} else if (message.role === "bashExecution") {
			text = bashExecutionToText(message as BashExecutionMessage);
		} else if (message.role === "custom") {
			text = contentToText(message.content);
		} else if (message.role === "branchSummary") {
			text = message.summary;
		} else if (message.role === "compactionSummary") {
			text = message.summary;
		} else {
			role = String((message as { role: string }).role ?? "user");
			text = contentToText((message as { content?: unknown }).content);
		}

		serialized.push({
			info: {
				id: item.id,
				role,
				time: { created: message.timestamp, completed: message.timestamp },
			},
			parts: text ? [{ type: "text", text }] : [],
		});
	}

	return serialized;
}

function extractBoundaries(serializedMessages: Array<Record<string, unknown>>): TraceBoundary[] {
	const boundaries: TraceBoundary[] = [];
	for (const message of serializedMessages) {
		const info = (message.info ?? {}) as { id?: string };
		const parts = Array.isArray(message.parts) ? message.parts : [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i] as { type?: string; tool?: string; state?: { metadata?: { event?: ChunkEvent } } };
			if (part.type !== "tool" || part.tool !== "delimiter") continue;
			const event = part.state?.metadata?.event;
			if (!event) continue;
			boundaries.push({ ...event, msg: info.id ?? "", part: i });
		}
	}
	return boundaries;
}

function getCurrentBoundaries(boundaries: TraceBoundary[]): TraceBoundary[] {
	let current: TraceBoundary | undefined;
	for (const boundary of boundaries) {
		if (boundary.action === "start") current = boundary;
		if (boundary.action === "end") current = undefined;
	}
	return current ? [current] : [];
}

function readPreviousTrace(tracePath: string): PreviousTrace | null {
	if (!existsSync(tracePath)) return null;
	try {
		return JSON.parse(readFileSync(tracePath, "utf8")) as PreviousTrace;
	} catch {
		return null;
	}
}

function getLatestAssistantUsage(messages: TraceMessageRecord[]) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]?.message;
		if (message?.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") continue;
		return assistant;
	}
	return undefined;
}

function resolveTraceModel(currentModel: Model<any> | undefined, branchEntries: SessionEntry[]) {
	if (currentModel) {
		return {
			id: currentModel.id,
			providerID: currentModel.provider,
			name: currentModel.name,
			limit: {
				context: currentModel.contextWindow ?? 0,
				input: currentModel.contextWindow ?? 0,
				usable: currentModel.contextWindow ?? 0,
			},
		};
	}

	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type === "model_change") {
			return {
				id: entry.modelId,
				providerID: entry.provider,
				name: entry.modelId,
				limit: { context: 0, input: 0, usable: 0 },
			};
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			return {
				id: entry.message.model,
				providerID: entry.message.provider,
				name: entry.message.model,
				limit: { context: 0, input: 0, usable: 0 },
			};
		}
	}

	return {
		id: "",
		providerID: "",
		name: "",
		limit: { context: 0, input: 0, usable: 0 },
	};
}

export function writeCwlTrace(input: {
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	state: AgentState;
	cleanupHistory?: CwlCleanupTraceRecord[];
}): string | undefined {
	const sessionFile = input.sessionManager.getSessionFile();
	if (!sessionFile || !input.sessionManager.isPersisted()) return undefined;

	const branchEntries = input.sessionManager.getBranch();
	const fullRecords = buildTraceMessages(branchEntries, "full");
	const activeRecords = buildTraceMessages(branchEntries, "active");
	const activeMessages = serializeMessages(activeRecords);
	const fullMessages = serializeMessages(fullRecords);
	const activeIds = new Set(activeMessages.map((message) => String((message.info as { id?: string }).id ?? "")));
	const evictedIds = fullMessages
		.map((message) => String((message.info as { id?: string }).id ?? ""))
		.filter((id) => id && !activeIds.has(id));
	const fullBoundaries = extractBoundaries(fullMessages);
	const activeBoundaries = extractBoundaries(activeMessages);
	const evictedBoundaryIds = new Set(evictedIds);
	const evictedBoundaries = fullBoundaries.filter((boundary) => evictedBoundaryIds.has(boundary.msg));
	const previousTrace = readPreviousTrace(getTracePath(sessionFile, input.sessionManager.getCwd()));
	const previousCleanupHistory = Array.isArray(previousTrace?.trace?.cleanups?.history)
		? previousTrace.trace.cleanups.history.map((cleanup, index) =>
				summarizeCleanup({
					...cleanup,
					chunkStats: cleanup.stats?.chunks ?? [],
					sequence: cleanup.sequence || index + 1,
					timestamp: cleanup.timestamp,
				}),
			)
		: [];
	const cleanupHistory = Array.isArray(input.cleanupHistory)
		? input.cleanupHistory.length > 0 || previousCleanupHistory.length === 0
			? input.cleanupHistory.map((cleanup, index) => ({ ...cleanup, sequence: cleanup.sequence || index + 1 }))
			: previousCleanupHistory
		: previousCleanupHistory;
	const latestCleanup = cleanupHistory.at(-1) ?? null;
	const recentEvictedIds = latestCleanup?.evictedMessageIds ?? [];
	const cleanupTotals = cleanupHistory.reduce(
		(acc, cleanup) => {
			acc.runs += 1;
			acc.evictedChunks += cleanup.evictedChunks;
			acc.notedFilePaths += cleanup.notedFilePaths;
			acc.tokensRemoved += cleanup.tokensRemoved;
			acc.steps += cleanup.stats.steps;
			acc.removed.assistantMessages += cleanup.stats.removed.assistantMessages;
			acc.removed.toolCalls += cleanup.stats.removed.toolCalls;
			acc.removed.toolResults += cleanup.stats.removed.toolResults;
			acc.removed.thinkingBlocks += cleanup.stats.removed.thinkingBlocks;
			for (const [toolName, count] of Object.entries(cleanup.stats.toolCallCounts)) {
				acc.toolCallCounts[toolName] = (acc.toolCallCounts[toolName] ?? 0) + count;
			}
			for (const filePath of cleanup.stats.filePaths) {
				if (!acc.filePaths.includes(filePath)) acc.filePaths.push(filePath);
			}
			for (const [step, count] of Object.entries(cleanup.stats.stepBreakdown)) {
				acc.stepBreakdown[step as keyof typeof acc.stepBreakdown] += count;
			}
			return acc;
		},
		{
			runs: 0,
			evictedChunks: 0,
			notedFilePaths: 0,
			tokensRemoved: 0,
			steps: 0,
			removed: {
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				thinkingBlocks: 0,
			},
			toolCallCounts: {} as Record<string, number>,
			filePaths: [] as string[],
			stepBreakdown: {
				thinking: 0,
				search_tools: 0,
				bash_tools: 0,
				read_tools: 0,
				entire_chunk: 0,
			},
		},
	);
	const settings = input.settingsManager.getCompactionSettings();
	const model = resolveTraceModel(input.state.model, branchEntries);
	const reserved = settings.reserveTokens;
	if (model.limit.context > 0) {
		model.limit.usable = Math.max(0, model.limit.context - reserved);
		model.limit.input = model.limit.context;
	}
	const thresholdMax = model.limit.usable || model.limit.context || 0;
	const lastAssistant = getLatestAssistantUsage(activeRecords);
	const exactUsage = lastAssistant?.usage.totalTokens ?? 0;
	const usageSource = lastAssistant ? "last-finished-assistant" : "none";
	const usagePct = (limit: number) => pct(exactUsage, limit);
	const lastUser = [...activeRecords].reverse().find((item) => item.message.role === "user");
	const tracePath = getTracePath(sessionFile, input.sessionManager.getCwd());
	const trace = {
		sessionID: input.sessionManager.getSessionId(),
		messages: {
			full: fullMessages,
			active: activeMessages,
		},
		model,
		usage: {
			exact: exactUsage,
			source: usageSource,
			tokens: lastAssistant
				? {
						total: lastAssistant.usage.totalTokens,
						input: lastAssistant.usage.input,
						output: lastAssistant.usage.output,
						reasoning: lastAssistant.content
							.filter((part) => part.type === "thinking")
							.map((part) => (part.type === "thinking" ? part.thinking.length : 0))
							.reduce((sum, value) => sum + value, 0),
						cache: {
							read: lastAssistant.usage.cacheRead,
							write: lastAssistant.usage.cacheWrite,
						},
					}
				: undefined,
			pct: {
				context: usagePct(model.limit.context),
				input: usagePct(model.limit.input),
				usable: usagePct(model.limit.usable),
			},
		},
		compaction: {
			auto: settings.enabled,
			max: thresholdMax,
			reserved,
		},
		last: {
			...(lastUser
				? {
						user: {
							status: "completed",
							time: { created: lastUser.message.timestamp },
						},
					}
				: {}),
			...(lastAssistant
				? {
						finished: {
							status: lastAssistant.stopReason,
							model: { modelID: lastAssistant.model },
							time: { created: lastAssistant.timestamp, completed: lastAssistant.timestamp },
						},
					}
				: {}),
		},
		trace: {
			threshold: {
				default: DEFAULT_CWL_THRESHOLD_TOKENS,
				max: thresholdMax,
				source: "config",
			},
			transcript: fullMessages,
			todos: {
				current: [],
				history: [],
				recent: [],
				evicted: [],
			},
			chunks: {
				current: getCurrentBoundaries(activeBoundaries),
				history: fullBoundaries,
				recent: fullBoundaries.filter((boundary) => recentEvictedIds.includes(boundary.msg)),
				evicted: evictedBoundaries,
			},
			cleanups: {
				current: latestCleanup,
				recent: latestCleanup,
				history: cleanupHistory,
				totals: {
					runs: cleanupTotals.runs,
					evictedChunks: cleanupTotals.evictedChunks,
					notedFilePaths: cleanupTotals.notedFilePaths,
					tokensRemoved: cleanupTotals.tokensRemoved,
					steps: cleanupTotals.steps,
					removed: cleanupTotals.removed,
					toolCallCounts: Object.fromEntries(
						Object.entries(cleanupTotals.toolCallCounts).sort(([a], [b]) => a.localeCompare(b)),
					),
					filePaths: cleanupTotals.filePaths,
					stepBreakdown: cleanupTotals.stepBreakdown,
				},
			},
			evictions: {
				msgs: evictedIds,
				recent: recentEvictedIds,
			},
		},
	};

	const traceDir = getCwlTracesDir(input.sessionManager.getCwd());
	if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
	writeFileSync(tracePath, JSON.stringify(trace, null, 2));
	return tracePath;
}
