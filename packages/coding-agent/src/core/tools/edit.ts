import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { countDiffChanges, parseDiffItems } from "../../modes/interactive/components/diff.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition } from "../extensions/types.js";
import { assertFileMutationAllowed } from "./chunk-access.js";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { getToolStatusBullet, indentToolBlock, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

type EditRenderState = Record<string, never>;

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Optional live message accessor used to enforce chunk-based file mutation rules. */
	getMessages?: () => AgentMessage[];
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as LegacyEditToolInput;
	if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
		return input as EditToolInput;
	}

	const edits = Array.isArray(args.edits) ? [...args.edits] : [];
	edits.push({ oldText: args.oldText, newText: args.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = args;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

function formatEditCall(
	args: RenderableEditArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isPartial: boolean,
	isError: boolean,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	const bullet = getToolStatusBullet(isPartial, isError);
	return `${bullet} ${theme.fg("toolTitle", theme.bold("Update"))}(${pathDisplay})`;
}

function buildEditResultComponent(
	_args: RenderableEditArgs | undefined,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: EditToolDetails;
	},
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isError: boolean,
): Container {
	const container = new Container();
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (errorText) {
			container.addChild(new Text(`${theme.fg("error", "⎿ ")}${theme.fg("error", errorText)}`, 0, 0));
		}
		return container;
	}

	const resultDiff = result.details?.diff;
	if (!resultDiff) return container;

	const { added, removed } = countDiffChanges(resultDiff);
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("success", `+${added}`));
	if (removed > 0) parts.push(theme.fg("error", `-${removed}`));
	const summary = parts.length > 0 ? parts.join(" ") : theme.fg("muted", "no changes");
	container.addChild(new Text(`${theme.fg("muted", "⎿")} ${summary} ${theme.fg("muted", "lines")}`, 0, 0));

	const items = parseDiffItems(resultDiff);
	for (const item of items) {
		if (item.type === "added") {
			container.addChild(
				new Text(`${theme.fg("muted", "  ")}${theme.fg("toolDiffAdded", item.text)}`, 0, 0, (t) =>
					theme.bg("toolDiffAddedBg", t),
				),
			);
		} else if (item.type === "removed") {
			container.addChild(
				new Text(`${theme.fg("muted", "  ")}${theme.fg("toolDiffRemoved", item.text)}`, 0, 0, (t) =>
					theme.bg("toolDiffRemovedBg", t),
				),
			);
		} else {
			container.addChild(new Text(`${theme.fg("muted", "  ")}${theme.fg("toolDiffContext", item.text)}`, 0, 0));
		}
	}
	return container;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			assertFileMutationAllowed(options?.getMessages);
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{
						content: Array<{ type: "text"; text: string }>;
						details: EditToolDetails | undefined;
					}>((resolve, reject) => {
						// Check if already aborted.
						if (signal?.aborted) {
							reject(new Error("Operation aborted"));
							return;
						}

						let aborted = false;

						// Set up abort handler.
						const onAbort = () => {
							aborted = true;
							reject(new Error("Operation aborted"));
						};

						if (signal) {
							signal.addEventListener("abort", onAbort, { once: true });
						}

						// Perform the edit operation.
						void (async () => {
							try {
								// Check if file exists.
								try {
									await ops.access(absolutePath);
								} catch {
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(new Error(`File not found: ${path}`));
									return;
								}

								// Check if aborted before reading.
								if (aborted) {
									return;
								}

								// Read the file.
								const buffer = await ops.readFile(absolutePath);
								const rawContent = buffer.toString("utf-8");

								// Check if aborted after reading.
								if (aborted) {
									return;
								}

								// Strip BOM before matching. The model will not include an invisible BOM in oldText.
								const { bom, text: content } = stripBom(rawContent);
								const originalEnding = detectLineEnding(content);
								const normalizedContent = normalizeToLF(content);
								const { baseContent, newContent } = applyEditsToNormalizedContent(
									normalizedContent,
									edits,
									path,
								);

								// Check if aborted before writing.
								if (aborted) {
									return;
								}

								const finalContent = bom + restoreLineEndings(newContent, originalEnding);
								await ops.writeFile(absolutePath, finalContent);

								// Check if aborted after writing.
								if (aborted) {
									return;
								}

								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								const diffResult = generateDiffString(baseContent, newContent);
								resolve({
									content: [
										{
											type: "text",
											text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
										},
									],
									details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
								});
							} catch (error: unknown) {
								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								if (!aborted) {
									reject(error instanceof Error ? error : new Error(String(error)));
								}
							}
						})();
					}),
			);
		},
		noBg: true,
		streamingVisible: true,
		renderCall(args, theme, context) {
			const renderArgs = args as RenderableEditArgs | undefined;
			const callText = formatEditCall(renderArgs, theme, context.isPartial, context.isError);

			// Once the result is in, just show the header — renderResult handles the rendered diff.
			if (!context.isPartial) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(callText);
				return text;
			}

			// While streaming: show oldText as "-" lines and newText as "+" lines, last N lines with ⎿ indent.
			const edits = Array.isArray(renderArgs?.edits) ? (renderArgs.edits as Edit[]) : [];
			const contentLines: string[] = [];
			for (const edit of edits) {
				if (edit.oldText) {
					for (const line of edit.oldText.split("\n")) contentLines.push(`-${line}`);
				}
				if (edit.newText) {
					for (const line of edit.newText.split("\n")) contentLines.push(`+${line}`);
				}
			}

			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			if (contentLines.length === 0) {
				text.setText(callText);
				return text;
			}

			const totalLines = contentLines.length;
			const maxLines = context.expanded ? totalLines : 10;
			const hiddenLines = Math.max(0, totalLines - maxLines);
			const displayLines = contentLines.slice(-maxLines);
			let output = `${callText}\n${indentToolBlock(displayLines.join("\n"))}`;
			if (hiddenLines > 0) {
				output += `\n${theme.fg("muted", "  ")}${theme.fg("muted", `... (${hiddenLines} earlier lines hidden, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
			}
			text.setText(output);
			return text;
		},
		renderResult(result, _options, theme, context) {
			return buildEditResultComponent(context.args, result as any, theme, context.isError);
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

/** Default edit tool using process.cwd() for backwards compatibility. */
export const editToolDefinition = createEditToolDefinition(process.cwd());
export const editTool = createEditTool(process.cwd());
