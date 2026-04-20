/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { getToolStatusBullet, indentToolBlock } from "../../../core/tools/render-utils.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.js";
import { theme } from "../theme/theme.js";
import { keyHint, keyText } from "./keybinding-hints.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private pulseInterval: NodeJS.Timeout | undefined;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;
	private excludeFromContext: boolean;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;
		this.excludeFromContext = excludeFromContext;

		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.loader = new Loader(
			ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`,
		);

		this.updateDisplay();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	private syncPulse(): void {
		if (this.status === "running") {
			if (!this.pulseInterval) {
				this.pulseInterval = setInterval(() => this.invalidate(), 400);
			}
		} else if (this.pulseInterval) {
			clearInterval(this.pulseInterval);
			this.pulseInterval = undefined;
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		this.loader.stop();
		this.syncPulse();
		this.updateDisplay();
	}

	private buildHeader(): Text {
		const bullet = getToolStatusBullet(this.status === "running", this.status === "error", this.excludeFromContext);
		return new Text(`${bullet} ${theme.fg("toolTitle", theme.bold("Run"))}(${this.command})`, 0, 0);
	}

	private updateDisplay(): void {
		this.syncPulse();
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.contentContainer.clear();
		this.contentContainer.addChild(this.buildHeader());

		if (availableLines.length > 0) {
			if (this.expanded) {
				const displayText = availableLines.map((line) => theme.fg("toolOutput", line)).join("\n");
				this.contentContainer.addChild(new Text(indentToolBlock(displayText), 0, 0));
			} else {
				const styledOutput = previewLogicalLines.map((line) => theme.fg("toolOutput", line)).join("\n");
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						const prefixLine = (line: string, prefix: string) => {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= width) {
								return truncateToWidth(prefix, width, "...");
							}
							return prefix + truncateToWidth(line, width - prefixWidth, "...");
						};
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledOutput, PREVIEW_LINES, width - 2);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return (cachedLines ?? []).map((line, index) =>
							prefixLine(line, theme.fg("muted", index === 0 ? "⎿ " : "  ")),
						);
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(`(${keyHint("app.tools.expand", "to collapse")})`);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines`)} (${keyHint("app.tools.expand", "to expand")})`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(
					new Text(
						indentToolBlock(statusParts.join("\n"), {
							firstPrefix: theme.fg("muted", "  "),
							restPrefix: theme.fg("muted", "  "),
						}),
						0,
						0,
					),
				);
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
