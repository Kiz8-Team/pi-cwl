import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import type { SessionScheduler } from "../scheduler.js";

const cronDeleteSchema = Type.Object({
	id: Type.String({ description: "Scheduled task ID" }),
});

export function createCronDeleteToolDefinition(scheduler: SessionScheduler): ToolDefinition<typeof cronDeleteSchema> {
	return defineTool({
		name: "CronDelete",
		label: "CronDelete",
		description: "Delete a scheduled task by ID.",
		promptSnippet: "Delete scheduled session tasks",
		promptGuidelines: ["Use CronDelete with a task ID returned by CronList."],
		parameters: cronDeleteSchema,
		async execute(_toolCallId, params) {
			const deleted = scheduler.deleteTask(params.id);
			return {
				content: [
					{
						type: "text",
						text: deleted ? `Deleted scheduled task ${params.id}.` : `Task ${params.id} was not found.`,
					},
				],
				details: { id: params.id, deleted },
			};
		},
	});
}
