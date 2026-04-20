import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadSubagents } from "../src/core/subagents.js";
import { createTestSession } from "./utilities.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
	process.env.HOME = originalHome;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadSubagents", () => {
	test("ignores deprecated model frontmatter and still loads color/tools", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
		tempDirs.push(root);
		process.env.HOME = root;

		const projectRoot = join(root, "project");
		const agentsDir = join(projectRoot, ".claude", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---
name: reviewer
description: Reviews changes
tools: Read, Bash
model: claude-sonnet-4-5
color: red
---

Review the requested changes.
`,
		);

		const result = loadSubagents({ cwd: projectRoot });
		expect(result.diagnostics).toEqual([]);
		expect(result.subagents).toHaveLength(1);

		const subagent = result.subagents[0];
		expect(subagent).toMatchObject({
			name: "reviewer",
			description: "Reviews changes",
			prompt: "Review the requested changes.",
			tools: ["Read", "Bash"],
			color: "red",
		});
		expect(Object.hasOwn(subagent, "model")).toBe(false);
	});
});

describe("Subagent tool", () => {
	test("delegates through the invoker without runtime permission gating", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const invoke = vi.fn(async () => "weather response");

		try {
			session.setSubagentInvoker(invoke);
			const tool = session.getToolDefinition("Subagent");
			expect(tool).toBeDefined();

			const result = await tool!.execute(
				"call-1",
				{
					name: "weather-agent",
					instruction: "Current weather in San Francisco",
				},
				undefined,
				undefined,
				{} as never,
			);

			expect(invoke).toHaveBeenCalledWith({
				name: "weather-agent",
				instruction: "Current weather in San Francisco",
				signal: undefined,
			});
			expect(result).toEqual({
				content: [{ type: "text", text: "weather response" }],
				details: undefined,
			});
		} finally {
			cleanup();
		}
	});

	test("forwards abort signals to the subagent invoker", async () => {
		const { session, cleanup } = createTestSession({ inMemory: true });
		const invoke = vi.fn(async () => "weather response");
		const controller = new AbortController();

		try {
			session.setSubagentInvoker(invoke);
			const tool = session.getToolDefinition("Subagent");
			expect(tool).toBeDefined();

			await tool!.execute(
				"call-1",
				{
					name: "weather-agent",
					instruction: "Current weather in San Francisco",
				},
				controller.signal,
				undefined,
				{} as never,
			);

			expect(invoke).toHaveBeenCalledWith({
				name: "weather-agent",
				instruction: "Current weather in San Francisco",
				signal: controller.signal,
			});
		} finally {
			cleanup();
		}
	});
});
