import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import { parseHumanDuration } from "../loop.js";

const sleepSchema = Type.Object({
	duration: Type.String({ description: "How long to wait before the loop runs again, for example 5m, 1h, or 1d." }),
	reason: Type.Optional(Type.String({ description: "Why the loop should wait this long before checking again." })),
});

export interface SleepToolCallbacks {
	arm: (durationMs: number, durationText: string, reason?: string) => Promise<{ taskId: string; nextRunAt: number }>;
}

export function createSleepToolDefinition(callbacks: SleepToolCallbacks): ToolDefinition<typeof sleepSchema> {
	return defineTool({
		name: "Sleep",
		label: "Sleep",
		description:
			"Re-arm the currently running dynamic /loop task to wake up later. Use it after deciding how long the loop should wait before checking again.",
		promptSnippet: "Re-arm a dynamic /loop task to wake up later",
		promptGuidelines: [
			"During dynamic /loop turns, call Sleep when you want the loop to wait before running the same loop prompt again.",
		],
		parameters: sleepSchema,
		async execute(_toolCallId, params) {
			const parsed = parseHumanDuration(params.duration);
			if (!parsed) {
				throw new Error("Invalid sleep duration. Use values like 5m, 1h, or 1d.");
			}
			const result = await callbacks.arm(parsed.milliseconds, parsed.normalized, params.reason);
			return {
				content: [
					{
						type: "text",
						text: `Dynamic loop ${result.taskId} sleeping for ${parsed.normalized} until ${new Date(result.nextRunAt).toISOString()}.`,
					},
				],
				details: {
					taskId: result.taskId,
					duration: parsed.normalized,
					nextRunAt: result.nextRunAt,
					reason: params.reason,
				},
			};
		},
	});
}
