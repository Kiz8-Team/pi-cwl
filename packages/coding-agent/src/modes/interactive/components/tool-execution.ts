import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.js";
import { allToolDefinitions } from "../../../core/tools/index.js";
import {
	getTextOutput as getRenderedTextOutput,
	getToolStatusBullet,
	shortenPath,
} from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
}

interface ToolResultContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

interface ToolExecutionResult {
	content: ToolResultContentBlock[];
	isError: boolean;
	details?: unknown;
}

interface SubagentState {
	name: string;
	colorHex?: string;
	startedAt: number;
	statusText: Text;
	nestedToolsText: Text;
	finalMessage?: string;
	toolUseCount: number;
	nestedTools: Map<string, ToolExecutionComponent>;
	nestedToolOrder: string[]; // insertion-ordered toolCallIds
	timerInterval?: NodeJS.Timeout;
	complete: boolean;
}

const SUBAGENT_VISIBLE_TOOLS = 5;

function parseHexColor(hex: string): { r: number; g: number; b: number } | undefined {
	const normalized = hex.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
		return undefined;
	}
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

function formatHexBadge(text: string, hex: string): string {
	const rgb = parseHexColor(hex);
	if (!rgb) {
		return theme.bold(text);
	}
	const luminance = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
	const fg = luminance >= 140 ? "\x1b[30m" : "\x1b[97m";
	const bg = `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
	return `${bg}${fg}${theme.bold(` ${text} `)}\x1b[39m\x1b[49m`;
}

function capitalizeFirst(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatNestedToolLine(toolName: string, args: any, _isPartial: boolean, _isError: boolean): string {
	const name = theme.fg("toolTitle", theme.bold(capitalizeFirst(toolName)));
	const arg = getNestedToolArg(toolName, args);
	const argStr = arg ? `${theme.fg("dim", "(")}${theme.fg("accent", arg)}${theme.fg("dim", ")")}` : "";
	return `${name}${argStr}`;
}

function getNestedToolArg(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	const name = toolName.toLowerCase();
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "ls": {
			const p = args.path ?? args.file_path;
			return typeof p === "string" ? shortenPath(p) : "";
		}
		case "bash": {
			const cmd = args.command;
			if (typeof cmd !== "string") return "";
			const first = cmd.split("\n")[0].trim();
			return first.length > 60 ? `${first.slice(0, 57)}…` : first;
		}
		case "grep": {
			const pat = args.pattern;
			if (typeof pat !== "string") return "";
			return pat.length > 40 ? `${pat.slice(0, 37)}…` : pat;
		}
		case "find":
		case "glob": {
			const pat = args.pattern;
			if (typeof pat !== "string") return "";
			return pat.length > 40 ? `${pat.slice(0, 37)}…` : pat;
		}
		case "subagent": {
			const n = args.name;
			return typeof n === "string" ? n : "";
		}
		default: {
			for (const v of Object.values(args as Record<string, unknown>)) {
				if (typeof v === "string" && v.trim().length > 0) {
					return v.length > 40 ? `${v.slice(0, 37)}…` : v;
				}
			}
			return "";
		}
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private pulseInterval: NodeJS.Timeout | undefined;
	private contentText: Text;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	toolName: string;
	private toolCallId: string;
	args: any;
	private expanded = false;
	private showImages: boolean;
	isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	result?: ToolExecutionResult;
	private subagentState?: SubagentState;
	private parentSubagent?: ToolExecutionComponent;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = allToolDefinitions[toolName as keyof typeof allToolDefinitions];
		this.showImages = options.showImages ?? true;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both. contentBox is used for tools with renderer-based call/result composition.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		const noBg =
			this.toolName === "delimiter"
				? (this.toolDefinition?.noBg ?? this.builtInToolDefinition?.noBg ?? false)
				: true;
		this.contentBox = new Box(1, 1, noBg ? undefined : (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, noBg ? undefined : (text: string) => theme.bg("toolPendingBg", text));

		if (this.hasRendererDefinition()) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		const bullet = getToolStatusBullet(this.isPartial, this.result?.isError ?? false);
		return new Text(`${bullet} ${theme.fg("toolTitle", theme.bold(this.toolName))}`, 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		const lines = output
			.split("\n")
			.map((line, index) => `${index === 0 ? "⎿ " : "  "}${theme.fg("toolOutput", line)}`);
		return new Text(lines.join("\n"), 0, 0);
	}

	private syncPulse(): void {
		if (this.toolName === "delimiter") return;
		if (this.isPartial) {
			if (!this.pulseInterval) {
				this.pulseInterval = setInterval(() => {
					this.invalidate();
					this.ui.requestRender();
				}, 400);
			}
		} else if (this.pulseInterval) {
			clearInterval(this.pulseInterval);
			this.pulseInterval = undefined;
		}
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
		this.parentSubagent?.updateNestedToolsText();
		this.parentSubagent?.ui.requestRender();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.parentSubagent?.updateNestedToolsText();
		this.parentSubagent?.ui.requestRender();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		this.syncPulse();
		const noBg =
			this.toolName === "delimiter"
				? (this.toolDefinition?.noBg ?? this.builtInToolDefinition?.noBg ?? false)
				: true;
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.isSubagentTool() && this.subagentState) {
			this.renderSubagentDisplay();
			hasContent = true;
		} else if (this.hasRendererDefinition()) {
			if (!noBg) this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				this.contentBox.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					this.contentBox.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					this.contentBox.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						this.contentBox.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						this.contentBox.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							this.contentBox.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			if (!noBg) this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (
			(this.hasRendererDefinition() || (this.isSubagentTool() && this.subagentState)) &&
			!hasContent &&
			this.imageComponents.length === 0
		) {
			this.hideComponent = true;
		}
	}

	private isSubagentTool(): boolean {
		return this.toolName === "Subagent";
	}

	private formatElapsedSince(startedAt: number): string {
		const elapsedMs = Math.max(0, Date.now() - startedAt);
		const totalSeconds = Math.floor(elapsedMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}

	private updateSubagentStatus(): void {
		if (!this.subagentState) {
			return;
		}
		const status = this.result?.isError ? "Failed" : this.subagentState.complete ? "Done" : "Running";
		const toolLabel = `${this.subagentState.toolUseCount} tool use${this.subagentState.toolUseCount === 1 ? "" : "s"}`;
		const elapsed = this.formatElapsedSince(this.subagentState.startedAt);
		this.subagentState.statusText.setText(theme.fg("dim", `  ${status} (${toolLabel} · ${elapsed})`));
	}

	private updateNestedToolsText(): void {
		const state = this.subagentState;
		if (!state) return;

		const order = state.nestedToolOrder;
		const visible = order.slice(-SUBAGENT_VISIBLE_TOOLS);
		const hidden = order.length - visible.length;

		const lines: string[] = [];
		if (hidden > 0) {
			lines.push(theme.fg("dim", `  ⎿  … ${hidden} earlier tool${hidden === 1 ? "" : "s"} hidden`));
		}
		for (let i = 0; i < visible.length; i++) {
			const id = visible[i];
			const nested = state.nestedTools.get(id);
			if (!nested) continue;
			const isFirst = i === 0 && hidden === 0;
			const prefix = isFirst ? "  ⎿  " : "     ";
			const label = formatNestedToolLine(
				nested.toolName,
				nested.args,
				nested.isPartial,
				nested.result?.isError ?? false,
			);
			lines.push(`${prefix}${label}`);
		}
		state.nestedToolsText.setText(lines.join("\n"));
	}

	beginSubagentRun(name: string, colorHex?: string): void {
		if (!this.isSubagentTool()) {
			return;
		}
		if (!this.subagentState) {
			this.subagentState = {
				name,
				colorHex,
				startedAt: Date.now(),
				statusText: new Text("", 0, 0),
				nestedToolsText: new Text("", 0, 0),
				finalMessage: undefined,
				toolUseCount: 0,
				nestedTools: new Map<string, ToolExecutionComponent>(),
				nestedToolOrder: [],
				timerInterval: undefined,
				complete: false,
			};
			this.subagentState.timerInterval = setInterval(() => {
				this.updateSubagentStatus();
				this.ui.requestRender();
			}, 250);
		} else {
			this.subagentState.name = name;
			this.subagentState.colorHex = colorHex;
		}
		this.subagentState.complete = false;
		this.updateSubagentStatus();
		this.updateDisplay();
		this.ui.requestRender();
	}

	private ensureSubagentState(): SubagentState | undefined {
		return this.subagentState;
	}

	getSubagentNestedTool(toolCallId: string): ToolExecutionComponent | undefined {
		return this.subagentState?.nestedTools.get(toolCallId);
	}

	ensureSubagentNestedTool(
		toolName: string,
		toolCallId: string,
		args: unknown,
		toolDefinition: ToolDefinition<any, any> | undefined,
	): ToolExecutionComponent | undefined {
		const state = this.ensureSubagentState();
		if (!state) {
			return undefined;
		}
		let component = state.nestedTools.get(toolCallId);
		if (!component) {
			// Create a lightweight proxy component for state tracking only (not added to visual tree)
			component = new ToolExecutionComponent(
				toolName,
				toolCallId,
				args,
				{ showImages: false },
				toolDefinition,
				this.ui,
				this.cwd,
			);
			component.parentSubagent = this;
			state.nestedTools.set(toolCallId, component);
			state.nestedToolOrder.push(toolCallId);
			state.toolUseCount += 1;
			this.updateSubagentStatus();
		} else {
			component.updateArgs(args);
		}
		this.updateNestedToolsText();
		this.updateDisplay();
		this.ui.requestRender();
		return component;
	}

	setSubagentFinalMessage(message: string | undefined): void {
		if (!this.subagentState) {
			return;
		}
		const trimmed = message?.trim();
		this.subagentState.finalMessage = trimmed && trimmed.length > 0 ? trimmed : undefined;
		this.updateDisplay();
		this.ui.requestRender();
	}

	completeSubagentRun(): void {
		if (!this.subagentState) {
			return;
		}
		this.subagentState.complete = true;
		if (this.subagentState.timerInterval) {
			clearInterval(this.subagentState.timerInterval);
			this.subagentState.timerInterval = undefined;
		}
		if (!this.subagentState.finalMessage) {
			const output = this.getTextOutput().trim();
			if (output.length > 0) {
				this.subagentState.finalMessage = output;
			}
		}
		this.updateSubagentStatus();
		this.updateNestedToolsText();
		this.updateDisplay();
		this.ui.requestRender();
	}

	private renderSubagentDisplay(): void {
		const state = this.subagentState;
		if (!state) {
			return;
		}
		this.contentBox.setBgFn(undefined);
		this.contentBox.clear();

		const bullet = getToolStatusBullet(this.isPartial, this.result?.isError ?? false);
		const badge = state.colorHex ? formatHexBadge(state.name, state.colorHex) : theme.bold(state.name);
		this.contentBox.addChild(new Text(`${bullet} ${badge}`, 0, 0));
		if (state.nestedToolOrder.length > 0) {
			this.contentBox.addChild(state.nestedToolsText);
		}
		this.contentBox.addChild(state.statusText);
		if (state.finalMessage) {
			this.contentBox.addChild(new Text(theme.fg("dim", "└ Final message"), 0, 0));
			this.contentBox.addChild(new Text(state.finalMessage, 2, 0));
		}
		this.hideComponent = false;
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
