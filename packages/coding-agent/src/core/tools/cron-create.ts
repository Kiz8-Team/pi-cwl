import { Type } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import type { SessionScheduler } from "../scheduler.js";

const cronCreateSchema = Type.Object({
	schedule: Type.String({ description: "Five-field cron schedule (minute hour day-of-month month day-of-week)" }),
	prompt: Type.String({ description: "Prompt to run when the schedule fires" }),
	recur: Type.Boolean({ description: "Whether the task should recur after the first run" }),
});

export function createCronCreateToolDefinition(scheduler: SessionScheduler): ToolDefinition<typeof cronCreateSchema> {
	return defineTool({
		name: "CronCreate",
		label: "CronCreate",
		description:
			"Create a scheduled task for this interactive session. Use it for one-time reminders and recurring checks. Tasks run only while this session exists.",
		promptSnippet: "Create session-scoped scheduled tasks and reminders",
		promptGuidelines: [
			"Use CronCreate for one-time reminders and recurring scheduled work during the current interactive session.",
		],
		parameters: cronCreateSchema,
		async execute(_toolCallId, params) {
			const task = scheduler.createCronTask({
				schedule: params.schedule,
				prompt: params.prompt,
				recur: params.recur,
				source: "tool:CronCreate",
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Created scheduled task ${task.id}.\n` +
							`Type: ${task.kind}\n` +
							`Schedule: ${task.schedule ?? "(dynamic)"}\n` +
							`Next run: ${task.nextRunAt ? new Date(task.nextRunAt).toISOString() : "waiting"}`,
					},
				],
				details: task,
			};
		},
	});
}
