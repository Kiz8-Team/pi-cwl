import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import type { SessionScheduler } from "../scheduler.js";

const cronListSchema = Type.Object({});

export function createCronListToolDefinition(scheduler: SessionScheduler): ToolDefinition<typeof cronListSchema> {
	return defineTool({
		name: "CronList",
		label: "CronList",
		description: "List all scheduled tasks for this interactive session.",
		promptSnippet: "List scheduled session tasks",
		promptGuidelines: ["Use CronList before deleting tasks when the target schedule is ambiguous."],
		parameters: cronListSchema,
		async execute() {
			const tasks = scheduler.listTasks();
			const text =
				tasks.length === 0
					? "No scheduled tasks."
					: tasks
							.map((task) => {
								const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toISOString() : "waiting";
								const expires = task.expiresAt ? new Date(task.expiresAt).toISOString() : "never";
								return `${task.id} | ${task.kind} | ${task.schedule ?? "dynamic"} | next=${nextRun} | expires=${expires} | ${task.label}`;
							})
							.join("\n");
			return {
				content: [{ type: "text", text }],
				details: { tasks },
			};
		},
	});
}
