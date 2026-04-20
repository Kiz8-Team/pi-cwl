/**
 * Delimiter tool – marks semantic chunk boundaries in agent sessions.
 *
 * Agents call this tool to open/close named work chunks of two flavours:
 *   - expl: exploration work that gathers context
 *   - act:  execution work that applies changes or validation
 *
 * Action chunks must declare which exploration chunks they depend on.
 * Only one chunk may be active at a time.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type Component, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import { active, type ChunkDetails, type ChunkEvent, type ChunkInfo, entries, line } from "../chunk.js";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const delimiterSchema = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("end")], {
		description: 'Either "start" or "end"',
	}),
	name: Type.Optional(Type.String({ description: "The chunk name (required when action is start)" })),
	type: Type.Optional(
		Type.Union([Type.Literal("expl"), Type.Literal("act")], {
			description: 'Chunk type: "expl" for exploration, "act" for action (required when action is start)',
		}),
	),
	dependencies: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exploration chunks this action chunk depends on (required when type is act)",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"Short 1-2 sentence summary of what the chunk contains. Required when ending an exploration chunk.",
		}),
	),
});

export type DelimiterToolInput = Static<typeof delimiterSchema>;

const DELIMITER_DESCRIPTION = `Use this tool to mark semantic chunk boundaries for the current task.

Call this tool with a JSON object. Use {"action":"start","name":"chunk-name","type":"expl"} when you begin an exploration chunk, {"action":"start","name":"chunk-name","type":"act","dependencies":["earlier-exploration"]} when you begin an action chunk, and {"action":"end","description":"short summary"} when you finish an exploration chunk.

Chunk types:
- \`expl\`: exploration work that gathers context
- \`act\`: execution work that applies changes or validation

Rules:
- Keep only one active chunk at a time.
- End the current chunk before starting another one.
- For end calls, omit name/type/dependencies. When ending an exploration chunk, include \`description\`.
- \`description\` should briefly summarize the information gathered in that exploration chunk.
- Each dependencies entry may only point from an act chunk to an earlier expl chunk.
- Keep names broad and outcome-based so they remain meaningful in later context.`;

function chunkTypeLabel(type: ChunkInfo["type"]): string {
	return type === "expl" ? "exploration" : "action";
}

function chunkTypeColor(type: ChunkInfo["type"]): "accent" | "warning" {
	return type === "expl" ? "accent" : "warning";
}

function boundaryLine(label: string, styledLabel: string, width: number, theme: Theme): string {
	const safeWidth = Math.max(1, width);
	if (safeWidth <= label.length + 2) {
		return styledLabel;
	}
	const remaining = safeWidth - label.length - 2;
	const left = Math.max(1, Math.floor(remaining / 2));
	const right = Math.max(1, remaining - left);
	const line = theme.fg("muted", "─");
	return `${line.repeat(left)} ${styledLabel} ${line.repeat(right)}`;
}

class DelimiterBoundary implements Component {
	constructor(
		private label: string,
		private styledLabel: string,
		private details: string[],
		private theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return [
			boundaryLine(this.label, this.styledLabel, width, this.theme),
			...this.details.map((detail) => truncateToWidth(`${this.theme.fg("muted", "  · ")}${detail}`, safeWidth)),
		];
	}
}

/**
 * Create a delimiter tool definition with access to the current message history.
 * The getMessages callback should return agent.state.messages.
 */
export function createDelimiterToolDefinition(
	getMessages: () => AgentMessage[],
): ToolDefinition<typeof delimiterSchema, ChunkDetails | null> {
	return {
		name: "delimiter",
		label: "delimiter",
		description: DELIMITER_DESCRIPTION,
		noBg: true,
		parameters: delimiterSchema,
		promptSnippet: "Mark semantic chunk boundaries (start/end expl or act chunks)",
		promptGuidelines: [
			"Use the delimiter tool to structure your work into named chunks before starting any non-trivial task.",
			"Open an expl chunk when gathering context, reading files, or understanding the codebase.",
			"Open an act chunk (with dependencies on your expl chunks) when making changes, running commands, or validating results.",
			"Only one chunk may be active at a time — end the current one before starting the next.",
			"Keep chunk names broad and outcome-based (e.g. 'explore-auth-flow', 'patch-login-handler') so they remain meaningful later.",
			"End every chunk you open. Unclosed chunks leave stale context in the conversation window.",
		],

		renderCall(args, t) {
			const input = args as DelimiterToolInput;
			if (input.action === "end") {
				// renderResult shows the finalized boundary with chunk metadata once the tool completes.
				return new Text("", 0, 0);
			}

			const chunkType = input.type ?? "expl";
			const typeColor = chunkTypeColor(chunkType);
			const typeLabel = chunkTypeLabel(chunkType);
			const chunkName = input.name?.trim() || "unnamed-chunk";
			const details: string[] = [];
			if (chunkType === "act" && input.dependencies?.length) {
				details.push(`${t.fg("muted", "depends on ")}${t.fg("toolOutput", input.dependencies.join(", "))}`);
			}

			return new DelimiterBoundary(
				`begin ${typeLabel}: ${chunkName}`,
				`${t.fg("muted", "Begin")} ${t.fg(typeColor, typeLabel)}${t.fg("muted", ":")} ${t.fg("toolTitle", t.bold(chunkName))}`,
				details,
				t,
			);
		},

		renderResult(result, _options, t) {
			const details = result.details;
			if (!details) {
				const errText = (result.content[0] as { text?: string })?.text ?? "error";
				return new Text(t.fg("error", errText), 0, 0);
			}
			const event = details.chunkEvent;
			const typeColor = chunkTypeColor(event.chunk.type);
			const typeLabel = chunkTypeLabel(event.chunk.type);
			const detailLines: string[] = [];
			if (event.chunk.dependencies?.length) {
				detailLines.push(
					`${t.fg("muted", "depends on ")}${t.fg("toolOutput", event.chunk.dependencies.join(", "))}`,
				);
			}
			if (event.chunk.description) {
				detailLines.push(`${t.fg("muted", "summary ")}${t.fg("toolOutput", event.chunk.description)}`);
			}

			if (event.action === "end") {
				return new DelimiterBoundary(
					`end ${typeLabel}: ${event.chunk.name}`,
					`${t.fg("muted", "End")} ${t.fg(typeColor, typeLabel)}${t.fg("muted", ":")} ${t.fg("toolTitle", t.bold(event.chunk.name))}`,
					detailLines,
					t,
				);
			}

			// renderCall already shows the begin boundary; suppress duplicate here
			return new Text("", 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const messages = getMessages();
			const allEntries = entries(messages);
			const currentActive = active(messages);
			const seen = new Map(allEntries.map((e) => [e.chunk.name, e.chunk]));

			if (params.action === "end") {
				if (!currentActive) {
					throw new Error("No active chunk to end.");
				}

				if (currentActive.type === "expl") {
					const description = params.description?.trim();
					if (!description) {
						throw new Error('Exploration chunks must include a non-empty "description" when ended.');
					}
					const event: ChunkEvent = {
						action: "end",
						chunk: { ...currentActive, description },
					};
					return {
						content: [{ type: "text", text: line(event) }],
						details: { chunkEvent: event },
					};
				}

				if (params.description?.trim()) {
					throw new Error('Only exploration chunks accept "description" on end.');
				}

				const event: ChunkEvent = { action: "end", chunk: currentActive };
				return {
					content: [{ type: "text", text: line(event) }],
					details: { chunkEvent: event },
				};
			}

			// action === "start"
			const name = params.name?.trim();
			const chunkType = params.type;

			if (!name) throw new Error('Chunk "name" is required when action is "start".');
			if (!chunkType) throw new Error('Chunk "type" is required when action is "start".');

			if (currentActive) {
				throw new Error(`Chunk "${currentActive.name}" is already active. End it before starting another chunk.`);
			}
			if (seen.has(name)) {
				throw new Error(`Chunk "${name}" already exists in this session.`);
			}

			let chunk: ChunkInfo;

			if (chunkType === "act") {
				if (!params.dependencies?.length) {
					throw new Error('Action chunks must declare at least one "dependencies" entry.');
				}
				const deps = [...new Set(params.dependencies.map((d) => d.trim()).filter(Boolean))];
				if (deps.includes(name)) {
					throw new Error(`Chunk "${name}" cannot depend on itself.`);
				}
				for (const dep of deps) {
					const item = seen.get(dep);
					if (!item) throw new Error(`Chunk dependency "${dep}" was not found in this session.`);
					if (item.type !== "expl") {
						throw new Error(`Chunk dependency "${dep}" must reference an exploration chunk.`);
					}
				}
				chunk = { name, type: "act", dependencies: deps };
			} else {
				chunk = { name, type: "expl" };
			}

			const event: ChunkEvent = { action: "start", chunk };
			return {
				content: [{ type: "text", text: line(event) }],
				details: { chunkEvent: event },
			};
		},
	};
}

/** Pre-built delimiter tool definition (getMessages returns empty – use createDelimiterToolDefinition for live message access). */
export const delimiterToolDefinition = createDelimiterToolDefinition(() => []);

/** Pre-built delimiter AgentTool (wraps delimiterToolDefinition). */
export const delimiterTool = wrapToolDefinition(delimiterToolDefinition);
