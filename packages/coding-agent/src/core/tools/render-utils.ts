import * as os from "node:os";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
	getCapabilities,
	getImageDimensions,
	imageFallback,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../../modes/interactive/theme/theme.js";
import { sanitizeBinaryOutput } from "../../utils/shell.js";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Render a centered boundary line with muted dashes around a styled label. */
export function renderBoundaryLine(
	styledLabel: string,
	width: number,
	theme: { fg: (name: "muted", text: string) => string },
): string {
	const safeWidth = Math.max(1, width);
	const styledWidth = visibleWidth(styledLabel);
	if (styledWidth >= safeWidth) {
		return truncateToWidth(styledLabel, safeWidth);
	}
	const remaining = safeWidth - styledWidth - 2;
	if (remaining < 0) {
		return truncateToWidth(styledLabel, safeWidth);
	}
	if (remaining === 0) {
		return ` ${styledLabel} `;
	}
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	const dash = theme.fg("muted", "─");
	return `${dash.repeat(left)} ${styledLabel} ${dash.repeat(right)}`;
}

export function indentToolBlock(text: string, options?: { firstPrefix?: string; restPrefix?: string }): string {
	if (!text) return "";
	const firstPrefix = options?.firstPrefix ?? "⎿ ";
	const restPrefix = options?.restPrefix ?? "  ";
	const lines = text.split("\n");
	return lines.map((line, index) => `${index === 0 ? firstPrefix : restPrefix}${line}`).join("\n");
}

export function getToolStatusBullet(isPartial: boolean, isError: boolean, excludeFromContext = false): string {
	if (excludeFromContext) return theme.fg("dim", "●");
	if (isError) return theme.fg("error", "●");
	if (!isPartial) return theme.fg("success", "●");
	const phase = Math.floor(Date.now() / 400) % 2;
	return phase === 0 ? theme.fg("dim", "●") : theme.fg("text", "●");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}
