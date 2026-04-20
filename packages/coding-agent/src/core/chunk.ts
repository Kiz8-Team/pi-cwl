/**
 * Chunk utilities for the delimiter tool.
 *
 * Chunks are semantic work boundaries that agents can mark using the delimiter tool.
 * Two types:
 * - "expl" (exploration): gathers context
 * - "act" (action): applies changes or validation; must depend on exploration chunks
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

export type ChunkKind = "expl" | "act";

export interface ChunkInfo {
	name: string;
	type: ChunkKind;
	dependencies?: string[];
	description?: string;
}

export interface ChunkEvent {
	action: "start" | "end";
	chunk: ChunkInfo;
}

/** Stored in ToolResultMessage.details for delimiter tool calls. */
export interface ChunkDetails {
	chunkEvent: ChunkEvent;
}

function isDelimiterResult(msg: AgentMessage): boolean {
	if (msg.role !== "toolResult") return false;
	const result = msg as ToolResultMessage;
	if (result.toolName !== "delimiter") return false;
	const details = result.details as ChunkDetails | undefined;
	if (!details || typeof details !== "object") return false;
	const event = (details as ChunkDetails).chunkEvent;
	return !!event && typeof event === "object" && "action" in event && "chunk" in event;
}

/** Extract all chunk events from the message history in order. */
export function entries(messages: AgentMessage[]): ChunkEvent[] {
	return messages
		.filter(isDelimiterResult)
		.map((msg) => ((msg as ToolResultMessage).details as ChunkDetails).chunkEvent);
}

/** Get the currently active chunk (last started but not yet ended). */
export function active(messages: AgentMessage[]): ChunkInfo | undefined {
	const events = entries(messages);
	const last = events.at(-1);
	if (!last || last.action === "end") return undefined;
	return last.chunk;
}

/** Get the latest known metadata for each chunk name. */
export function catalog(messages: AgentMessage[]): Map<string, ChunkInfo> {
	const chunks = new Map<string, ChunkInfo>();
	for (const event of entries(messages)) {
		chunks.set(event.chunk.name, event.chunk);
	}
	return chunks;
}

/** Format a chunk event as a short one-liner. */
export function line(event: ChunkEvent): string {
	const dep = event.chunk.dependencies?.length ? ` dep=${event.chunk.dependencies.join(",")}` : "";
	const description = event.chunk.description ? ` — ${event.chunk.description}` : "";
	return `${event.action} [${event.chunk.type}] ${event.chunk.name}${dep}${description}`;
}
