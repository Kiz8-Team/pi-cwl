import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode slash command history", () => {
	test("adds built-in slash commands to editor history before handling them", async () => {
		const addToHistory = vi.fn();
		const setText = vi.fn();
		const showSettingsSelector = vi.fn();
		const fakeThis: any = {
			defaultEditor: {},
			editor: {
				addToHistory,
				setText,
			},
			showSettingsSelector,
		};

		(InteractiveMode as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/settings");

		expect(addToHistory).toHaveBeenCalledWith("/settings");
		expect(showSettingsSelector).toHaveBeenCalledOnce();
		expect(setText).toHaveBeenCalledWith("");
	});
});
