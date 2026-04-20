import { Container, Markdown, type MarkdownTheme, Spacer, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private markdown: Markdown;
	private readonly prefix = "❯ ";
	private readonly continuationPrefix = "  ";

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		this.markdown = new Markdown(text, 0, 0, markdownTheme, {
			color: (text: string) => theme.fg("userMessageText", text),
		});
		this.addChild(this.markdown);
	}

	override render(width: number): string[] {
		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const markdownLines = this.markdown.render(contentWidth);
		const spacerLines = this.children[0]?.render(width) ?? [];
		const renderedMessageLines = markdownLines.map((line, index) => {
			const trimmedLine = line.replace(/\s+$/u, "");
			const prefix = index === 0 ? this.prefix : this.continuationPrefix;
			const styledPrefix = theme.fg("userMessageText", prefix);
			const renderedLine = `${styledPrefix}${trimmedLine}`;
			const padding = " ".repeat(Math.max(0, width - visibleWidth(renderedLine)));
			return theme.bg("userMessageBg", `${renderedLine}${padding}`);
		});
		const lines = [...spacerLines, ...renderedMessageLines];
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return lines;
	}
}
