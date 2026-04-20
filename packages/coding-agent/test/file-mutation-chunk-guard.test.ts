import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { EXPLORATION_FILE_EDIT_DENIED_ERROR } from "../src/core/tools/chunk-access.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-guard-"));
	tempDirs.push(dir);
	return dir;
}

function explorationChunkMessages(): AgentMessage[] {
	return [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "delimiter",
			content: [{ type: "text", text: "start [expl] explore-guard" }],
			details: {
				chunkEvent: { action: "start", chunk: { name: "explore-guard", type: "expl" } },
			},
			isError: false,
			timestamp: 1,
		},
	];
}

function actionChunkMessages(): AgentMessage[] {
	return [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "delimiter",
			content: [{ type: "text", text: "start [act] patch-guard dep=explore-guard" }],
			details: {
				chunkEvent: {
					action: "start",
					chunk: { name: "patch-guard", type: "act", dependencies: ["explore-guard"] },
				},
			},
			isError: false,
			timestamp: 1,
		},
	];
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file mutation chunk guard", () => {
	it("blocks edit tool mutations during exploration chunks", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "guarded.txt");
		await writeFile(filePath, "before\n", "utf8");
		const definition = createEditToolDefinition(dir, { getMessages: explorationChunkMessages });

		await expect(
			definition.execute(
				"tool-1",
				{ path: "guarded.txt", edits: [{ oldText: "before", newText: "after" }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(EXPLORATION_FILE_EDIT_DENIED_ERROR);
		expect(await readFile(filePath, "utf8")).toBe("before\n");
	});

	it("blocks write tool mutations during exploration chunks", async () => {
		const dir = await createTempDir();
		const definition = createWriteToolDefinition(dir, { getMessages: explorationChunkMessages });

		await expect(
			definition.execute(
				"tool-1",
				{ path: "new-file.txt", content: "hello\n" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(EXPLORATION_FILE_EDIT_DENIED_ERROR);
	});

	it("allows file mutations during action chunks", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "guarded.txt");
		await writeFile(filePath, "before\n", "utf8");
		const definition = createEditToolDefinition(dir, { getMessages: actionChunkMessages });

		const result = await definition.execute(
			"tool-1",
			{ path: "guarded.txt", edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in guarded.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});
