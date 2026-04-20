import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import {
	getTextOutput,
	getToolStatusBullet,
	indentToolBlock,
	invalidArgText,
	shortenPath,
	str,
} from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const globSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type GlobToolInput = Static<typeof globSchema>;

const DEFAULT_LIMIT = 1000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the glob tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultGlobOperations: GlobOperations = {
	exists: existsSync,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface GlobToolOptions {
	/** Custom operations for glob. Default: local filesystem plus fd */
	operations?: GlobOperations;
}

function formatGlobCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isPartial: boolean,
	isError: boolean,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	const bullet = getToolStatusBullet(isPartial, isError);
	let text =
		`${bullet} ${theme.fg("toolTitle", theme.bold("Glob"))}(` +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`) +
		`)`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatGlobResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GlobToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += indentToolBlock(displayLines.map((line) => theme.fg("toolOutput", line)).join("\n"));
		if (remaining > 0) {
			text += `\n${theme.fg("muted", "  ")}${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", "  ")}${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGlobToolDefinition(
	cwd: string,
	options?: GlobToolOptions,
): ToolDefinition<typeof globSchema, GlobToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "glob",
		label: "glob",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Search for files by glob pattern (respects .gitignore)",
		parameters: globSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultGlobOperations;

						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								reject(new Error(`Path not found: ${searchPath}`));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							signal?.removeEventListener("abort", onAbort);
							if (results.length === 0) {
								resolve({
									content: [{ type: "text", text: "No files found matching pattern" }],
									details: undefined,
								});
								return;
							}

							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: GlobToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							resolve({
								content: [{ type: "text", text: resultOutput }],
								details: Object.keys(details).length > 0 ? details : undefined,
							});
							return;
						}

						const fdPath = await ensureTool("fd", true);
						if (!fdPath) {
							reject(new Error("fd is not available and could not be downloaded"));
							return;
						}

						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--max-results",
							String(effectiveLimit),
						];
						const gitignoreFiles: string[] = [];
						const rootGitignore = path.join(searchPath, ".gitignore");
						if (existsSync(rootGitignore)) gitignoreFiles.push(rootGitignore);
						try {
							// Use fd to find nested .gitignore files so it respects the root
							// .gitignore and won't descend into gitignored directories like .claude/.
							const igArgs: string[] = [
								"--glob",
								"--color=never",
								"--hidden",
								"--exclude",
								"node_modules",
								"--exclude",
								".git",
							];
							if (existsSync(rootGitignore)) igArgs.push("--ignore-file", rootGitignore);
							igArgs.push("**/.gitignore", searchPath);
							const igResult = spawnSync(fdPath, igArgs, { encoding: "utf-8", maxBuffer: 1024 * 1024 });
							if (igResult.status === 0 && igResult.stdout) {
								for (const line of igResult.stdout.split("\n")) {
									const p = line.trim();
									if (p && p !== rootGitignore) gitignoreFiles.push(p);
								}
							}
						} catch {
							// ignore
						}
						for (const gitignorePath of gitignoreFiles) args.push("--ignore-file", gitignorePath);
						args.push(pattern, searchPath);

						const result = spawnSync(fdPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
						signal?.removeEventListener("abort", onAbort);
						if (result.error) {
							reject(new Error(`Failed to run fd: ${result.error.message}`));
							return;
						}

						const output = result.stdout?.trim() || "";
						if (result.status !== 0) {
							const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
							if (!output) {
								reject(new Error(errorMsg));
								return;
							}
						}
						if (!output) {
							resolve({
								content: [{ type: "text", text: "No files found matching pattern" }],
								details: undefined,
							});
							return;
						}

						const lines = output.split("\n");
						const relativized: string[] = [];
						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) continue;
							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}
							if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
							relativized.push(toPosixPath(relativePath));
						}

						const resultLimitReached = relativized.length >= effectiveLimit;
						const rawOutput = relativized.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let resultOutput = truncation.content;
						const details: GlobToolDetails = {};
						const notices: string[] = [];
						if (resultLimitReached) {
							notices.push(
								`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
							);
							details.resultLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							resultOutput += `\n\n[${notices.join(". ")}]`;
						}
						resolve({
							content: [{ type: "text", text: resultOutput }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (error: unknown) {
						signal?.removeEventListener("abort", onAbort);
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				})();
			});
		},
		noBg: true,
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobCall(args, theme, context.isPartial, context.isError));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGlobResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGlobTool(cwd: string, options?: GlobToolOptions): AgentTool<typeof globSchema> {
	return wrapToolDefinition(createGlobToolDefinition(cwd, options));
}

/** Default glob tool using process.cwd() for backwards compatibility. */
export const globToolDefinition = createGlobToolDefinition(process.cwd());
export const globTool = createGlobTool(process.cwd());
