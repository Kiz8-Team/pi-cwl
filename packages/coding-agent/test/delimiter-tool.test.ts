import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createDelimiterToolDefinition } from "../src/core/tools/delimiter.js";

describe("delimiter tool", () => {
	it("requires description when ending an exploration chunk", async () => {
		const definition = createDelimiterToolDefinition(() => [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "delimiter",
				content: [{ type: "text", text: "start [expl] explore-delimiter" }],
				details: {
					chunkEvent: { action: "start", chunk: { name: "explore-delimiter", type: "expl" } },
				},
				isError: false,
				timestamp: 1,
			},
		]);

		await expect(
			definition.execute("call-2", { action: "end" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow('Exploration chunks must include a non-empty "description" when ended.');
	});

	it("stores exploration descriptions on end events", async () => {
		const definition = createDelimiterToolDefinition(() => [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "delimiter",
				content: [{ type: "text", text: "start [expl] explore-delimiter" }],
				details: {
					chunkEvent: { action: "start", chunk: { name: "explore-delimiter", type: "expl" } },
				},
				isError: false,
				timestamp: 1,
			},
		]);

		const result = await definition.execute(
			"call-2",
			{
				action: "end",
				description: "Read the delimiter schema, chunk metadata model, and active chunk tracking flow.",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([
			{
				type: "text",
				text: "end [expl] explore-delimiter — Read the delimiter schema, chunk metadata model, and active chunk tracking flow.",
			},
		]);
		expect(result.details?.chunkEvent).toEqual({
			action: "end",
			chunk: {
				name: "explore-delimiter",
				type: "expl",
				description: "Read the delimiter schema, chunk metadata model, and active chunk tracking flow.",
			},
		});
	});

	it("rejects descriptions when ending an action chunk", async () => {
		const definition = createDelimiterToolDefinition(() => [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "delimiter",
				content: [{ type: "text", text: "start [act] patch-delimiter dep=explore-delimiter" }],
				details: {
					chunkEvent: {
						action: "start",
						chunk: { name: "patch-delimiter", type: "act", dependencies: ["explore-delimiter"] },
					},
				},
				isError: false,
				timestamp: 1,
			},
		]);

		await expect(
			definition.execute(
				"call-2",
				{ action: "end", description: "Should not be accepted for action chunks." },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow('Only exploration chunks accept "description" on end.');
	});
});
