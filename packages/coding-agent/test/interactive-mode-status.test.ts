import { Container } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function createShowLoadedResourcesThis(options: {
	quietStartup: boolean;
	verbose?: boolean;
	contextFiles?: Array<{ path: string }>;
	skills?: Array<{ filePath: string }>;
	skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
}) {
	const fakeThis: any = {
		options: { verbose: options.verbose ?? false },
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		settingsManager: {
			getQuietStartup: () => options.quietStartup,
		},
		session: {
			promptTemplates: [],
			commandTemplates: [],
			extensionRunner: undefined,
			resourceLoader: {
				getPathMetadata: () => new Map(),
				getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
				getSkills: () => ({
					skills: options.skills ?? [],
					diagnostics: options.skillDiagnostics ?? [],
				}),
				getCommands: () => ({ commands: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getSubagents: () => ({ subagents: [], diagnostics: [] }),
			},
		},
		formatDisplayPath: (p: string) => p,
		buildScopeGroups: () => [],
		formatScopeGroups: () => "resource-list",
		getShortPath: (p: string) => p,
		formatDiagnostics: () => "diagnostics",
		getBuiltInCommandConflictDiagnostics: () => [],
	};

	return fakeThis;
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode cwl_cleanup formatting", () => {
	const event = {
		type: "cwl_cleanup" as const,
		evictedChunks: 1,
		notedFilePaths: 2,
		tokensBefore: 96823,
		tokensAfter: 45636,
		threshold: 50000,
		evictedMessageIds: [],
		chunkStats: [
			{
				chunkName: "patch-cwl-transient-banner",
				chunkKind: "act" as const,
				dependencies: ["explore-cwl-cleanup-message"],
				fullyRemoved: false,
				steps: [
					{
						step: "search_tools" as const,
						removedAssistantMessages: 1,
						removedToolCalls: 2,
						removedToolResults: 2,
						removedThinkingBlocks: 0,
						removedFilePaths: [],
						toolCallCounts: { grep: 1, find: 1 },
						tokensBefore: 96823,
						tokensAfter: 70000,
					},
					{
						step: "read_tools" as const,
						removedAssistantMessages: 1,
						removedToolCalls: 1,
						removedToolResults: 1,
						removedThinkingBlocks: 0,
						removedFilePaths: ["packages/coding-agent/src/core/cwl.ts", "packages/coding-agent/src/core/sdk.ts"],
						toolCallCounts: { read: 1 },
						tokensBefore: 70000,
						tokensAfter: 45636,
					},
				],
			},
		],
	};

	test("shows the concise cleanup summary outside debug mode", () => {
		initTheme("dark");
		const text = Reflect.get(InteractiveMode.prototype, "formatCwlCleanupMessage").call(
			{ debugModeEnabled: false },
			event,
		) as string;

		expect(text).toContain("CWL cleanup applied");
		expect(text).toContain("Tokens 96,823 -> 45,636 (removed 51,187, target <= 50,000)");
		expect(text).not.toContain("partially evicted");
		expect(text).not.toContain("grep×1");
	});

	test("shows detailed cleanup information in debug mode", () => {
		initTheme("dark");
		const text = Reflect.get(InteractiveMode.prototype, "formatCwlCleanupMessage").call(
			{ debugModeEnabled: true },
			event,
		) as string;

		expect(text).toContain("CWL cleanup applied");
		expect(text).toContain("Tokens 96,823 -> 45,636 (removed 51,187, target <= 50,000)");
		expect(text).toContain("partially evicted");
		expect(text).toContain("grep×1");
		expect(text).toContain("read×1");
		expect(text).toContain("2 file paths");
	});
});

describe("InteractiveMode.showCwlCleanupMessage", () => {
	const firstEvent = {
		type: "cwl_cleanup" as const,
		evictedChunks: 1,
		notedFilePaths: 0,
		tokensBefore: 60000,
		tokensAfter: 48000,
		threshold: 50000,
		evictedMessageIds: [],
		chunkStats: [],
	};

	const secondEvent = {
		...firstEvent,
		tokensBefore: 52000,
		tokensAfter: 47000,
	};

	beforeAll(() => {
		initTheme("dark");
	});

	test("appends a separate cleanup notification for each cleanup event", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			rebuildChatFromCwlState: vi.fn(),
			formatCwlCleanupMessage: vi.fn().mockReturnValueOnce("FIRST CLEANUP").mockReturnValueOnce("SECOND CLEANUP"),
		};

		(InteractiveMode as any).prototype.showCwlCleanupMessage.call(fakeThis, firstEvent);
		(InteractiveMode as any).prototype.showCwlCleanupMessage.call(fakeThis, secondEvent);

		expect(fakeThis.chatContainer.children).toHaveLength(4);
		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("FIRST CLEANUP");
		expect(output).toContain("SECOND CLEANUP");
	});

	test("preserves other chat content between cleanup notifications", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			rebuildChatFromCwlState: vi.fn(),
			formatCwlCleanupMessage: vi.fn().mockReturnValueOnce("FIRST CLEANUP").mockReturnValueOnce("SECOND CLEANUP"),
		};

		(InteractiveMode as any).prototype.showCwlCleanupMessage.call(fakeThis, firstEvent);
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		(InteractiveMode as any).prototype.showCwlCleanupMessage.call(fakeThis, secondEvent);

		expect(fakeThis.chatContainer.children).toHaveLength(5);
		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("FIRST CLEANUP");
		expect(output).toContain("OTHER");
		expect(output).toContain("SECOND CLEANUP");
	});
});

describe("built-in slash commands", () => {
	test("registers /debug as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "debug")).toBe(true);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});

describe("InteractiveMode.handleStatusCommand", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows loaded resources and hotkeys even when quiet startup is enabled", () => {
		const fakeThis: any = createShowLoadedResourcesThis({
			quietStartup: true,
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});
		fakeThis.showLoadedResources = (InteractiveMode as any).prototype.showLoadedResources;
		fakeThis.handleHotkeysCommand = (InteractiveMode as any).prototype.handleHotkeysCommand;
		fakeThis.getEditorKeyDisplay = () => "Key";
		fakeThis.getAppKeyDisplay = () => "Key";
		fakeThis.getMarkdownThemeWithSettings = () => getMarkdownTheme();
		fakeThis.keybindings = { getEffectiveConfig: () => ({}) };

		(InteractiveMode as any).prototype.handleStatusCommand.call(fakeThis);

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Context]");
		expect(output).toContain("/tmp/AGENTS.md");
		expect(output).toContain("[Skills]");
		expect(output).toContain("Keyboard Shortcuts");
	});
});
