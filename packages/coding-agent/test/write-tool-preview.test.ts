import type { TUI } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("write tool preview", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the latest lines in collapsed previews", () => {
		const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const component = new ToolExecutionComponent(
			"write",
			"tool-write-preview-1",
			{ path: "README.md", content },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).not.toMatch(/\bline 2\b/);
		expect(rendered).toMatch(/\bline 3\b/);
		expect(rendered).toMatch(/\bline 12\b/);
		expect(rendered).toContain("2 earlier lines hidden, 12 total");
	});
});
