/**
 * Unit tests for context-filter.ts
 *
 * All tests use a small fake contextWindowSize so we can control exactly when
 * eviction kicks in without needing huge message arrays.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildReverseDeps,
	type ChunkSegment,
	DEFAULT_CWL_THRESHOLD_TOKENS,
	estimateTotal,
	filterContext,
	filterContextWithTokenCounter,
	getEffectiveCwlThreshold,
	isEvictionCandidate,
	parseCwlLimit,
	removeRange,
	segmentChunks,
	stripThinkingFromRange,
	stripToolsFromRange,
} from "../src/core/context-filter.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(text: string, ts = 1): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: ts,
	} as AgentMessage;
}

function assistantMsg(content: AssistantMessage["content"], ts = 2): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		content,
		usage: USAGE,
		stopReason: "stop",
		timestamp: ts,
	} as AssistantMessage;
}

function toolCallBlock(id: string, name: string, args: Record<string, unknown> = {}) {
	return { type: "toolCall" as const, id, name, arguments: args };
}

function thinkingBlock(text = "thinking...") {
	return { type: "thinking" as const, thinking: text };
}

function textBlock(text: string) {
	return { type: "text" as const, text };
}

function toolResult(toolCallId: string, toolName: string, text: string, details?: unknown, ts = 3): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: ts,
	} as ToolResultMessage;
}

function delimiterStart(
	id: string,
	name: string,
	type: "expl" | "act",
	dependencies: string[] = [],
	ts = 3,
): ToolResultMessage {
	return toolResult(
		id,
		"delimiter",
		`start [${type}] ${name}`,
		{ chunkEvent: { action: "start", chunk: { name, type, dependencies } } },
		ts,
	);
}

function delimiterEnd(id: string, name: string, type: "expl" | "act", description = "done", ts = 4): ToolResultMessage {
	return toolResult(
		id,
		"delimiter",
		`end [${type}] ${name}`,
		{ chunkEvent: { action: "end", chunk: { name, type, description } } },
		ts,
	);
}

// ─── estimateTotal ─────────────────────────────────────────────────────────────

describe("estimateTotal", () => {
	it("sums token estimates across messages", () => {
		const msgs: AgentMessage[] = [userMsg("hello"), userMsg("world")];
		const total = estimateTotal(msgs);
		expect(total).toBeGreaterThan(0);
		expect(total).toBe(estimateTotal([msgs[0]]) + estimateTotal([msgs[1]]));
	});
});

describe("parseCwlLimit", () => {
	it("accepts token thresholds above the default threshold", () => {
		expect(parseCwlLimit("150001")).toEqual({ type: "tokens", value: 150001 });
		expect(parseCwlLimit("151k")).toEqual({ type: "tokens", value: 151000 });
		expect(parseCwlLimit(`${DEFAULT_CWL_THRESHOLD_TOKENS}`)).toEqual({ type: "tokens", value: 80000 });
	});
});

describe("getEffectiveCwlThreshold", () => {
	it("defaults to 80,000 tokens and does not cap explicit limits", () => {
		expect(getEffectiveCwlThreshold(400_000)).toBe(DEFAULT_CWL_THRESHOLD_TOKENS);
		expect(getEffectiveCwlThreshold(400_000, { type: "percent", value: 90 })).toBe(360_000);
		expect(getEffectiveCwlThreshold(400_000, { type: "tokens", value: 200_000 })).toBe(200_000);
	});
});

// ─── segmentChunks ─────────────────────────────────────────────────────────────

describe("segmentChunks", () => {
	it("marks pre-chunk messages", () => {
		const msgs: AgentMessage[] = [userMsg("pre"), delimiterStart("s1", "expl1", "expl", [], 2)];
		const { preChunkIndices, segments } = segmentChunks(msgs);
		expect(preChunkIndices.has(0)).toBe(true);
		expect(preChunkIndices.has(1)).toBe(false);
		expect(segments).toHaveLength(1);
	});

	it("detects completed segments", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("s1", "expl1", "expl", [], 1),
			userMsg("mid", 2),
			delimiterEnd("e1", "expl1", "expl", "desc", 3),
		];
		const { segments } = segmentChunks(msgs);
		expect(segments).toHaveLength(1);
		expect(segments[0].isCompleted).toBe(true);
		expect(segments[0].msgRange).toEqual([0, 2]);
	});

	it("handles open (uncompleted) segments", () => {
		const msgs: AgentMessage[] = [delimiterStart("s1", "act1", "act", ["expl1"], 1), userMsg("inside", 2)];
		const { segments } = segmentChunks(msgs);
		expect(segments[0].isCompleted).toBe(false);
		expect(segments[0].msgRange[1]).toBe(msgs.length - 1);
	});

	it("captures dependencies on act segments", () => {
		const msgs: AgentMessage[] = [delimiterStart("s1", "act1", "act", ["expl-a", "expl-b"], 1)];
		const { segments } = segmentChunks(msgs);
		expect(segments[0].dependencies).toEqual(["expl-a", "expl-b"]);
	});
});

// ─── buildReverseDeps ─────────────────────────────────────────────────────────

describe("buildReverseDeps", () => {
	it("maps each dependency to its dependents", () => {
		const segments: ChunkSegment[] = [
			{ name: "expl1", kind: "expl", dependencies: [], isCompleted: true, msgRange: [0, 1] },
			{ name: "act1", kind: "act", dependencies: ["expl1"], isCompleted: true, msgRange: [2, 5] },
		];
		const rev = buildReverseDeps(segments);
		expect(rev.get("expl1")).toEqual(new Set(["act1"]));
	});

	it("returns empty map when no deps", () => {
		const segments: ChunkSegment[] = [
			{ name: "expl1", kind: "expl", dependencies: [], isCompleted: true, msgRange: [0, 1] },
		];
		expect(buildReverseDeps(segments).size).toBe(0);
	});
});

// ─── isEvictionCandidate ──────────────────────────────────────────────────────

describe("isEvictionCandidate", () => {
	const seg: ChunkSegment = {
		name: "expl1",
		kind: "expl",
		dependencies: [],
		isCompleted: true,
		msgRange: [0, 2],
	};

	it("completed segment with no dependents is a candidate", () => {
		expect(isEvictionCandidate(seg, new Set(), new Map())).toBe(true);
	});

	it("not a candidate if already evicted", () => {
		expect(isEvictionCandidate(seg, new Set(["expl1"]), new Map())).toBe(false);
	});

	it("not a candidate if incomplete", () => {
		const open = { ...seg, isCompleted: false };
		expect(isEvictionCandidate(open, new Set(), new Map())).toBe(false);
	});

	it("not a candidate while dependents are live", () => {
		const rev = new Map([["expl1", new Set(["act1"])]]);
		expect(isEvictionCandidate(seg, new Set(), rev)).toBe(false);
	});

	it("candidate once all dependents are evicted", () => {
		const rev = new Map([["expl1", new Set(["act1"])]]);
		expect(isEvictionCandidate(seg, new Set(["act1"]), rev)).toBe(true);
	});
});

// ─── stripToolsFromRange ──────────────────────────────────────────────────────

describe("stripToolsFromRange", () => {
	it("removes matching tool calls and their results", () => {
		const msgs: AgentMessage[] = [
			assistantMsg([toolCallBlock("g1", "grep", { pattern: "foo" })]),
			toolResult("g1", "grep", "match"),
		];
		const { messages, removedIds } = stripToolsFromRange(msgs, 0, 1, new Set(["grep"]));
		expect(messages).toHaveLength(0);
		expect(removedIds.has("g1")).toBe(true);
	});

	it("keeps tool calls outside the range", () => {
		const msgs: AgentMessage[] = [
			assistantMsg([toolCallBlock("g1", "grep", {})]), // idx 0 — in range
			toolResult("g1", "grep", "r"), // idx 1 — in range
			assistantMsg([toolCallBlock("g2", "grep", {})]), // idx 2 — outside
			toolResult("g2", "grep", "r"), // idx 3 — outside
		];
		const { messages } = stripToolsFromRange(msgs, 0, 1, new Set(["grep"]));
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe("assistant");
	});

	it("collects file paths from read tool calls", () => {
		const msgs: AgentMessage[] = [
			assistantMsg([toolCallBlock("r1", "read", { path: "/src/foo.ts" })]),
			toolResult("r1", "read", "content"),
		];
		const { filePaths } = stripToolsFromRange(msgs, 0, 1, new Set(["read"]));
		expect(filePaths).toEqual(["/src/foo.ts"]);
	});

	it("drops assistant message entirely if all content removed", () => {
		const msgs: AgentMessage[] = [assistantMsg([toolCallBlock("g1", "grep", {})]), toolResult("g1", "grep", "r")];
		const { messages } = stripToolsFromRange(msgs, 0, 1, new Set(["grep"]));
		expect(messages).toHaveLength(0);
	});

	it("keeps assistant message if non-tool content remains", () => {
		const msgs: AgentMessage[] = [
			assistantMsg([textBlock("text"), toolCallBlock("g1", "grep", {})]),
			toolResult("g1", "grep", "r"),
		];
		const { messages } = stripToolsFromRange(msgs, 0, 1, new Set(["grep"]));
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		const a = messages[0] as AssistantMessage;
		expect(a.content).toHaveLength(1);
		expect(a.content[0].type).toBe("text");
	});
});

// ─── stripThinkingFromRange ───────────────────────────────────────────────────

describe("stripThinkingFromRange", () => {
	it("removes thinking blocks from assistant messages in range", () => {
		const msgs: AgentMessage[] = [assistantMsg([thinkingBlock(), textBlock("answer")])];
		const result = stripThinkingFromRange(msgs, 0, 0);
		expect(result).toHaveLength(1);
		const a = result[0] as AssistantMessage;
		expect(a.content).toHaveLength(1);
		expect(a.content[0].type).toBe("text");
	});

	it("drops message if only thinking remains", () => {
		const msgs: AgentMessage[] = [assistantMsg([thinkingBlock()])];
		const result = stripThinkingFromRange(msgs, 0, 0);
		expect(result).toHaveLength(0);
	});

	it("leaves messages outside range unchanged", () => {
		const msgs: AgentMessage[] = [assistantMsg([thinkingBlock()]), assistantMsg([thinkingBlock()])];
		const result = stripThinkingFromRange(msgs, 1, 1);
		expect(result).toHaveLength(1); // idx 0 dropped, idx 1 has no text either but… wait
		// Actually idx 0 is outside range so it stays; idx 1 is in range and only thinking → dropped
		// Wait, stripThinkingFromRange leaves outside range unchanged.
		// msgs[0] (idx 0) is outside range [1,1] → stays
		// msgs[1] (idx 1) is inside range → only thinking → dropped
		// So result has msgs[0] only
		expect((result[0] as AssistantMessage).content[0].type).toBe("thinking");
	});
});

// ─── removeRange ──────────────────────────────────────────────────────────────

describe("removeRange", () => {
	it("preserves user messages even when they fall inside the removal range", () => {
		const msgs = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
		const result = removeRange(msgs, 1, 2);
		expect(result).toEqual(msgs);
	});
});

// ─── filterContext ─────────────────────────────────────────────────────────────

describe("filterContext", () => {
	it("returns messages unchanged when under 50% threshold", () => {
		const msgs: AgentMessage[] = [userMsg("hi")];
		// Very large window → well under 50%
		const result = filterContext(msgs, 1_000_000);
		expect(result.messages).toBe(msgs); // same reference
		expect(result.evictedFilePaths).toHaveLength(0);
	});

	it("returns messages unchanged when contextWindowSize is 0", () => {
		const msgs: AgentMessage[] = [userMsg("hi")];
		const result = filterContext(msgs, 0);
		expect(result.messages).toBe(msgs);
	});

	it("evicts act chunk in step order: search tools removed before bash tools", () => {
		// Each tool call gets its own assistant message so token accounting is precise.
		const msgs: AgentMessage[] = [
			userMsg("start", 1),
			delimiterStart("ds1", "act1", "act", [], 2),
			// grep call + result (search step)
			assistantMsg([toolCallBlock("g1", "grep", { pattern: "foo" })], 3),
			toolResult("g1", "grep", "grep output", undefined, 4),
			// bash call + result (bash step)
			assistantMsg([toolCallBlock("b1", "bash", { command: "ls" })], 5),
			toolResult("b1", "bash", "bash output", undefined, 6),
			// read call + result (read step)
			assistantMsg([toolCallBlock("r1", "read", { path: "/x.ts" })], 7),
			toolResult("r1", "read", "file content", undefined, 8),
			delimiterEnd("de1", "act1", "act", "done", 9),
			userMsg("done", 10),
		];

		const totalTokens = estimateTotal(msgs);

		// Compute token cost of grep pair precisely
		const grepPairTokens = estimateTotal([
			assistantMsg([toolCallBlock("g1", "grep", { pattern: "foo" })]),
			toolResult("g1", "grep", "grep output"),
		]);

		// Set token threshold so removing the grep pair is just enough to satisfy CWL.
		const threshold = totalTokens - grepPairTokens;

		// Only meaningful to test if grep tokens are large enough to tip the balance
		if (threshold <= 0) {
			// Degenerate case — skip arithmetic check, just ensure no crash
			const result = filterContext(msgs, 1, { type: "tokens", value: 1 });
			expect(result.messages).toBeDefined();
			return;
		}

		const result = filterContext(msgs, 1, { type: "tokens", value: threshold });
		const toolResultIds = result.messages
			.filter((m) => m.role === "toolResult")
			.map((m) => (m as ToolResultMessage).toolCallId);

		// grep call+result should be gone (search step)
		expect(toolResultIds).not.toContain("g1");
		// bash and read should still be present (threshold met after search step)
		expect(toolResultIds).toContain("b1");
		expect(toolResultIds).toContain("r1");
		// grep doesn't produce file paths
		expect(result.evictedFilePaths).toHaveLength(0);
	});

	it("collects file paths when read tools are evicted", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "act1", "act", [], 1),
			assistantMsg([toolCallBlock("r1", "read", { path: "/foo.ts" })], 2),
			toolResult("r1", "read", "content", undefined, 3),
			delimiterEnd("de1", "act1", "act", "done", 4),
			userMsg("done", 5),
		];

		// Threshold so small that everything must be evicted (full removal)
		const result = filterContext(msgs, 1, { type: "tokens", value: 1 });

		// The act chunk should be fully evicted
		expect(result.messages.length).toBeLessThan(msgs.length);
		// And we should have the path
		expect(result.evictedFilePaths).toContain("/foo.ts");
	});

	it("does not evict expl chunk while act dependent is active", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "expl1", "expl", [], 1),
			assistantMsg([toolCallBlock("g1", "grep", { pattern: "x" })], 2),
			toolResult("g1", "grep", "grep out", undefined, 3),
			delimiterEnd("de1", "expl1", "expl", "expl desc", 4),
			// act chunk that depends on expl1 — NOT completed
			delimiterStart("ds2", "act1", "act", ["expl1"], 5),
			assistantMsg([textBlock("working...")], 6),
			userMsg("continue", 7),
		];

		// Force eviction pressure
		const result = filterContext(msgs, 1, { type: "tokens", value: 1 });

		// expl1 should NOT be evicted because act1 depends on it and act1 is not completed
		const delimiterResults = result.messages.filter(
			(m) => m.role === "toolResult" && (m as ToolResultMessage).toolName === "delimiter",
		);
		// Should still have the expl1 start and end delimiters
		const eventNames = delimiterResults.map(
			(m) =>
				((m as ToolResultMessage).details as { chunkEvent: { action: string; chunk: { name: string } } })
					.chunkEvent,
		);
		const explStartPresent = eventNames.some((e) => e.action === "start" && e.chunk.name === "expl1");
		expect(explStartPresent).toBe(true);
	});

	it("evicts expl chunk after all act dependents are evicted", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "expl1", "expl", [], 1),
			assistantMsg(
				[toolCallBlock("g1", "grep", { pattern: "x" }), toolCallBlock("r1", "read", { path: "/expl.ts" })],
				2,
			),
			toolResult("g1", "grep", "grep out", undefined, 3),
			toolResult("r1", "read", "file", undefined, 4),
			delimiterEnd("de1", "expl1", "expl", "desc", 5),
			// completed act chunk depending on expl1
			delimiterStart("ds2", "act1", "act", ["expl1"], 6),
			assistantMsg([toolCallBlock("b1", "bash", { command: "echo" })], 7),
			toolResult("b1", "bash", "out", undefined, 8),
			delimiterEnd("de2", "act1", "act", "done", 9),
			userMsg("final", 10),
		];

		// Threshold so tiny that both chunks must be fully evicted
		const result = filterContext(msgs, 1, { type: "tokens", value: 1 });

		// Both act1 and expl1 should be gone (delimiter results removed)
		const delimiterResults = result.messages.filter(
			(m) => m.role === "toolResult" && (m as ToolResultMessage).toolName === "delimiter",
		);
		expect(delimiterResults).toHaveLength(0);
		expect(result.messages.filter((m) => m.role === "user")).toEqual([userMsg("final", 10)]);

		// File path from expl1's read call should be captured
		expect(result.evictedFilePaths).toContain("/expl.ts");
	});

	it("strips thinking from expl chunk before other steps", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "expl1", "expl", [], 1),
			assistantMsg([thinkingBlock("deep thought"), textBlock("summary")], 2),
			delimiterEnd("de1", "expl1", "expl", "done", 3),
			userMsg("ok", 4),
		];

		const totalTokens = estimateTotal(msgs);
		// Thinking block is relatively large; set threshold to trigger eviction
		// but resolve after thinking removal
		const thinkingTokens = estimateTotal([assistantMsg([thinkingBlock("deep thought")])]);
		// Threshold where removing thinking is enough
		const threshold = totalTokens - thinkingTokens - 1;

		if (threshold <= 0) {
			// Skip if the thinking tokens already dominate — just verify it doesn't crash
			const result = filterContext(msgs, 1, { type: "tokens", value: 1 });
			expect(result.messages).toBeDefined();
			return;
		}

		const result = filterContext(msgs, 1, { type: "tokens", value: threshold });
		// The delimiter results and text should survive; thinking should be gone
		const assistantMessages = result.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
		for (const am of assistantMessages) {
			expect(am.content.every((b) => b.type !== "thinking")).toBe(true);
		}
	});

	it("uses the async token counter for threshold checks after eviction steps", async () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "act1", "act", [], 1),
			assistantMsg([toolCallBlock("g1", "grep", { pattern: "foo" })], 2),
			toolResult("g1", "grep", "grep output", undefined, 3),
			assistantMsg([toolCallBlock("b1", "bash", { command: "ls" })], 4),
			toolResult("b1", "bash", "bash output", undefined, 5),
			delimiterEnd("de1", "act1", "act", "done", 6),
			userMsg("done", 7),
		];

		const baseline = estimateTotal(msgs);
		const searchRemoved = stripToolsFromRange(msgs, 0, msgs.length - 1, new Set(["grep"])).messages;
		const afterSearchEstimate = estimateTotal(searchRemoved);
		const afterSearchCount = Math.max(1, afterSearchEstimate - 50);
		const threshold = afterSearchCount + 1;
		const countTokens = async (candidateMessages: AgentMessage[]): Promise<number> => {
			const toolResultIds = candidateMessages
				.filter((message) => message.role === "toolResult")
				.map((message) => (message as ToolResultMessage).toolCallId);
			if (toolResultIds.includes("g1")) return baseline;
			if (toolResultIds.includes("b1")) return afterSearchCount;
			return estimateTotal(candidateMessages);
		};

		const result = await filterContextWithTokenCounter(
			msgs,
			1,
			{ type: "tokens", value: threshold },
			{
				initialTokens: baseline,
				countTokens,
			},
		);

		const toolResultIds = result.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message as ToolResultMessage).toolCallId);
		const readStep = result.chunkStats[0]?.steps.find((step) => step.step === "search_tools");
		expect(toolResultIds).not.toContain("g1");
		expect(toolResultIds).toContain("b1");
		expect(result.tokensAfter).toBe(afterSearchCount);
		expect(readStep?.tokensAfter).toBe(afterSearchCount);
	});

	it("reports detailed per-chunk eviction stats for partial and full cleanup", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "expl1", "expl", [], 1),
			assistantMsg([thinkingBlock("deep thought"), toolCallBlock("g1", "grep", { pattern: "x" })], 2),
			toolResult("g1", "grep", "grep out", undefined, 3),
			delimiterEnd("de1", "expl1", "expl", "done", 4),
			delimiterStart("ds2", "act1", "act", ["expl1"], 5),
			assistantMsg([toolCallBlock("r1", "read", { path: "/tmp/foo.ts" })], 6),
			toolResult("r1", "read", "file", undefined, 7),
			userMsg("inside chunk", 7.5),
			delimiterEnd("de2", "act1", "act", "done", 8),
			userMsg("ok", 9),
		];

		const result = filterContext(msgs, 1, { type: "tokens", value: 1 });
		expect(result.chunkStats).toHaveLength(2);
		expect(result.chunkStats[0]).toMatchObject({
			chunkName: "act1",
			chunkKind: "act",
			fullyRemoved: false,
		});
		expect(result.chunkStats[0].steps.some((step) => step.step === "read_tools")).toBe(true);
		expect(result.chunkStats[0].steps.some((step) => step.step === "entire_chunk")).toBe(true);
		const readStep = result.chunkStats[0].steps.find((step) => step.step === "read_tools");
		expect(readStep?.toolCallCounts).toEqual({ read: 1 });
		expect(readStep?.removedFilePaths).toEqual(["/tmp/foo.ts"]);
		expect(result.chunkStats[1]).toMatchObject({
			chunkName: "expl1",
			chunkKind: "expl",
			fullyRemoved: true,
		});
		expect(result.chunkStats[1].steps.some((step) => step.step === "thinking")).toBe(true);
		const thinkingStep = result.chunkStats[1].steps.find((step) => step.step === "thinking");
		expect(thinkingStep?.removedThinkingBlocks).toBe(1);
		expect(result.messages.filter((m) => m.role === "user")).toEqual([
			userMsg("inside chunk", 7.5),
			userMsg("ok", 9),
		]);
		expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
		expect(result.threshold).toBeGreaterThan(0);
	});

	it("always preserves user messages even when their completed chunk is evicted", () => {
		const msgs: AgentMessage[] = [
			delimiterStart("ds1", "act1", "act", [], 1),
			userMsg("keep me", 2),
			assistantMsg([toolCallBlock("b1", "bash", { command: "echo hi" })], 3),
			toolResult("b1", "bash", "hi", undefined, 4),
			delimiterEnd("de1", "act1", "act", "done", 5),
		];

		const result = filterContext(msgs, 1, { type: "tokens", value: 1 });
		expect(result.messages).toEqual([userMsg("keep me", 2)]);
	});
});
