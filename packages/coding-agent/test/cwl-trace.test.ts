import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentState } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { writeCwlTrace } from "../src/core/cwl-trace.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { SettingsManager } from "../src/core/settings-manager.js";

const cleanupPaths: string[] = [];

function tempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	cleanupPaths.push(dir);
	return dir;
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
	delete process.env.PI_CODING_AGENT_DIR;
});

it("stores session files and CWL traces under the configured global agent dir", () => {
	const agentDir = tempDir("pi-local-storage-agent");
	const cwd = tempDir("pi-local-storage-cwd");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const session = SessionManager.create(cwd);

	const sessionFile = session.getSessionFile();
	expect(sessionFile).toBeTruthy();
	expect(sessionFile!).toContain(join(agentDir, "sessions"));
	expect(existsSync(sessionFile!)).toBe(true);

	session.appendMessage({ role: "user", content: "trace this", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "done" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});

	const state = {
		messages: session.buildSessionContext().messages,
		model: {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		},
		thinkingLevel: "off",
		isStreaming: false,
		systemPrompt: "",
		tools: [],
		pendingToolCalls: new Set<string>(),
	} as AgentState;
	const settingsManager = {
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
	} as SettingsManager;

	const tracePath = writeCwlTrace({ sessionManager: session, settingsManager, state });
	expect(tracePath).toBeTruthy();
	expect(tracePath!).toBe(join(agentDir, "cwl", `${basename(sessionFile!, ".jsonl")}.json`));
	expect(existsSync(tracePath!)).toBe(true);
});

describe("passive session persistence", () => {
	it("writes a session file immediately before the first assistant message", () => {
		const agentDir = tempDir("pi-cwl-agent");
		const cwd = tempDir("pi-cwl-cwd");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const session = SessionManager.create(cwd);

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();
		expect(existsSync(sessionFile!)).toBe(true);

		session.appendThinkingLevelChange("high");
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const lines = readFileSync(sessionFile!, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[1]).type).toBe("thinking_level_change");
		expect(JSON.parse(lines[2]).message.role).toBe("user");
	});
});

describe("passive CWL trace writing", () => {
	it("writes opencode-shaped JSON traces with delimiter history", () => {
		const agentDir = tempDir("pi-cwl-agent");
		const cwd = tempDir("pi-cwl-cwd");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const session = SessionManager.create(cwd);

		session.appendModelChange("anthropic", "claude-sonnet-4-5");
		session.appendThinkingLevelChange("high");
		session.appendMessage({ role: "user", content: "trace this", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [
				{ type: "text", text: "working" },
				{
					type: "toolCall",
					id: "call-1",
					name: "delimiter",
					arguments: { action: "start", name: "explore", type: "expl" },
				},
			],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "delimiter",
			content: [{ type: "text", text: "start [expl] explore" }],
			details: { chunkEvent: { action: "start", chunk: { name: "explore", type: "expl" } } },
			isError: false,
			timestamp: 3,
		});
		session.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [
				{
					type: "toolCall",
					id: "call-2",
					name: "delimiter",
					arguments: {
						action: "end",
						description: "Read the delimiter implementation, chunk model, system prompt, and CWL trace flow.",
					},
				},
				{
					type: "toolCall",
					id: "call-3",
					name: "delimiter",
					arguments: { action: "start", name: "patch", type: "act", dependencies: ["explore"] },
				},
			],
			usage: {
				input: 12,
				output: 6,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 18,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 4,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "delimiter",
			content: [
				{
					type: "text",
					text: "end [expl] explore — Read the delimiter implementation, chunk model, system prompt, and CWL trace flow.",
				},
			],
			details: {
				chunkEvent: {
					action: "end",
					chunk: {
						name: "explore",
						type: "expl",
						description: "Read the delimiter implementation, chunk model, system prompt, and CWL trace flow.",
					},
				},
			},
			isError: false,
			timestamp: 5,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-3",
			toolName: "delimiter",
			content: [{ type: "text", text: "start [act] patch dep=explore" }],
			details: {
				chunkEvent: {
					action: "start",
					chunk: { name: "patch", type: "act", dependencies: ["explore"] },
				},
			},
			isError: false,
			timestamp: 6,
		});

		const state = {
			messages: session.buildSessionContext().messages,
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				baseUrl: "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
			thinkingLevel: "high",
			isStreaming: false,
			systemPrompt: "",
			tools: [],
			pendingToolCalls: new Set<string>(),
		} as AgentState;
		const settingsManager = {
			getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
		} as SettingsManager;

		const tracePath = writeCwlTrace({ sessionManager: session, settingsManager, state });
		expect(tracePath).toBeTruthy();
		expect(existsSync(tracePath!)).toBe(true);

		const data = JSON.parse(readFileSync(tracePath!, "utf8"));
		expect(data.sessionID).toBe(session.getSessionId());
		expect(data.trace.threshold.default).toBe(80000);
		expect(data.trace.threshold.max).toBe(183616);
		expect(data.trace.chunks.history).toHaveLength(3);
		expect(data.trace.chunks.current).toHaveLength(1);
		expect(data.trace.chunks.history[1].chunk.description).toBe(
			"Read the delimiter implementation, chunk model, system prompt, and CWL trace flow.",
		);
		expect(data.trace.sticky).toBeUndefined();
		expect(
			data.messages.active.some((msg: { parts: Array<{ type?: string }> }) =>
				msg.parts.some((part: { type?: string }) => part.type === "tool"),
			),
		).toBe(true);
	});

	it("stores latest eviction ids from the current cleanup instead of all historical evictions", () => {
		const agentDir = tempDir("pi-cwl-agent");
		const cwd = tempDir("pi-cwl-cwd");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const session = SessionManager.create(cwd);

		session.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const evictedMessageId = session.appendMessage({ role: "user", content: "evict me", timestamp: 2 });
		session.appendMessage({ role: "user", content: "after", timestamp: 3 });

		const state = {
			messages: session.buildSessionContext().messages,
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				baseUrl: "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
			thinkingLevel: "off",
			isStreaming: false,
			systemPrompt: "",
			tools: [],
			pendingToolCalls: new Set<string>(),
		} as AgentState;
		const settingsManager = {
			getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }),
		} as SettingsManager;

		const tracePath = writeCwlTrace({
			sessionManager: session,
			settingsManager,
			state,
			cleanupHistory: [
				{
					sequence: 1,
					timestamp: 4,
					time: new Date(4).toISOString(),
					evictedChunks: 1,
					notedFilePaths: 0,
					tokensBefore: 1000,
					tokensAfter: 800,
					tokensRemoved: 200,
					threshold: 900,
					evictedMessageIds: [evictedMessageId],
					utilization: { before: 111.1, after: 88.9 },
					stats: {
						chunks: [],
						steps: 0,
						removed: { assistantMessages: 0, toolCalls: 0, toolResults: 0, thinkingBlocks: 0 },
						toolCallCounts: {},
						filePaths: [],
						stepBreakdown: { thinking: 0, search_tools: 0, bash_tools: 0, read_tools: 0, entire_chunk: 0 },
					},
				},
			],
		});
		const data = JSON.parse(readFileSync(tracePath!, "utf8"));
		expect(data.trace.evictions.recent).toEqual([evictedMessageId]);
		expect(data.trace.cleanups.recent.evictedMessageIds).toEqual([evictedMessageId]);
	});
});
