/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import type {
	AutocompleteItem,
	EditorComponent,
	EditorTheme,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@mariozechner/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, spawnSync } from "child_process";
import notifier from "node-notifier";
import { getAuthPath, getDebugLogPath, TERMINAL_TITLE, TUI_VERSION, VERSION } from "../../config.js";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
	type ReasoningEffort,
	type SubagentInvocationRequest,
} from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { ChunkDetails, ChunkInfo, ChunkKind } from "../../core/chunk.js";
import { active as getActiveChunk, entries as getChunkEntries } from "../../core/chunk.js";
import { estimateContextTokens, estimateTokens } from "../../core/compaction/compaction.js";
import { DEFAULT_CWL_THRESHOLD_TOKENS, getEffectiveCwlThreshold, parseCwlLimit } from "../../core/context-filter.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.js";
import { loadPersistentGlobalConfig, updatePersistentGlobalConfig } from "../../core/persistent-global-config.js";
import { DefaultResourceLoader, type ResourceDiagnostic } from "../../core/resource-loader.js";
import { createAgentSession } from "../../core/sdk.js";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { SourceInfo } from "../../core/source-info.js";
import type { SubagentColor, SubagentDefinition, SubagentToolName } from "../../core/subagents.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import type { AgentPromptMode } from "../../prompts/index.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { keyText } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party usage now draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

const TUI_APP_NAME = "Pi with CWL";

const SUBAGENT_MAIN_SELECTOR = "Main";
const SUBAGENT_BORDER_COLORS: Record<SubagentColor, string> = {
	red: "#e06c75",
	blue: "#61afef",
	green: "#98c379",
	yellow: "#e5c07b",
	purple: "#c678dd",
	orange: "#d87757",
	pink: "#ff79c6",
	cyan: "#56b6c2",
};
const SUBAGENT_TOOL_NAME_MAP: Record<SubagentToolName, string> = {
	Read: "read",
	Bash: "bash",
	Edit: "edit",
	Write: "write",
	Grep: "grep",
	Find: "find",
	Ls: "ls",
	Delimiter: "delimiter",
	Subagent: "Subagent",
};

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: CombinedAutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;
	private turnReadyNotificationTimer: NodeJS.Timeout | undefined = undefined;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private subagentRenderStack: ToolExecutionComponent[] = [];

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Debug mode controls whether CWL cleanup messages show full details or a concise summary.
	private debugModeEnabled: boolean;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;
	private promptMode: AgentPromptMode = "default";
	private lastPlanText: string | undefined = undefined;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private activeSessionOverride: AgentSession | undefined = undefined;
	private activeSubagentName: string | undefined = undefined;
	private subagentSessions = new Map<string, AgentSession>();
	private subagentInvocationStack: Array<{ name: string; session: AgentSession }> = [];

	// Convenience accessors
	private get session(): AgentSession {
		return this.activeSessionOverride ?? this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get isSubagentActive(): boolean {
		return this.activeSubagentName !== undefined;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		runtimeHost: AgentSessionRuntime,
		private options: InteractiveModeOptions = {},
	) {
		this.runtimeHost = runtimeHost;
		this.version = TUI_VERSION;
		this.debugModeEnabled = loadPersistentGlobalConfig().debugModeEnabled ?? false;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			prompt: "❯ ",
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private bindSubagentInvoker(session: AgentSession): void {
		session.setSubagentInvoker((request) => this.invokeSubagent(request));
	}

	private ensureMainSessionSubagentTool(): void {
		const subagents = this.runtimeHost.session.resourceLoader.getSubagents().subagents;
		if (subagents.length === 0) {
			return;
		}

		const activeToolNames = this.runtimeHost.session.getActiveToolNames();
		if (activeToolNames.includes("Subagent")) {
			return;
		}

		this.runtimeHost.session.setActiveToolsByName([...activeToolNames, "Subagent"]);
	}

	private disposeSubagentSessions(): void {
		for (const session of this.subagentSessions.values()) {
			session.dispose();
		}
		this.subagentSessions.clear();
		this.activeSessionOverride = undefined;
		this.activeSubagentName = undefined;
	}

	private getActiveSubagentDefinition(): SubagentDefinition | undefined {
		if (!this.activeSubagentName) {
			return undefined;
		}
		return this.runtimeHost.session.resourceLoader
			.getSubagents()
			.subagents.find((subagent) => subagent.name === this.activeSubagentName);
	}

	private getSubagentColorizer(): ((text: string) => string) | undefined {
		const subagent = this.getActiveSubagentDefinition();
		if (!subagent?.color) {
			return undefined;
		}
		const hex = SUBAGENT_BORDER_COLORS[subagent.color];
		return theme.fgHex(hex);
	}

	private getSubagentBorderColor(): ((text: string) => string) | undefined {
		return this.getSubagentColorizer();
	}

	private getSubagentColorHexByName(name: string): string | undefined {
		const subagent = this.runtimeHost.session.resourceLoader
			.getSubagents()
			.subagents.find((candidate) => candidate.name === name);
		if (!subagent?.color) {
			return undefined;
		}
		return SUBAGENT_BORDER_COLORS[subagent.color];
	}

	private removeSubagentRenderComponent(component: ToolExecutionComponent): void {
		const index = this.subagentRenderStack.lastIndexOf(component);
		if (index !== -1) {
			this.subagentRenderStack.splice(index, 1);
		}
	}

	private clearSubagentRenderStack(): void {
		for (const component of this.subagentRenderStack) {
			component.completeSubagentRun();
		}
		this.subagentRenderStack = [];
	}

	private hasActiveSubagentInvocation(): boolean {
		return this.subagentInvocationStack.length > 0;
	}

	private abortActiveSubagentInvocations(): void {
		const activeSessions = new Set(this.subagentInvocationStack.map((invocation) => invocation.session));
		for (const session of activeSessions) {
			void session.abort();
		}
	}

	private getAssistantTextContent(message: AssistantMessage): string | undefined {
		const text = message.content
			.filter((item): item is Extract<AssistantMessage["content"][number], { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n\n")
			.trim();
		return text.length > 0 ? text : undefined;
	}

	private getSubagentNameFromArgs(args: unknown): string | undefined {
		if (typeof args !== "object" || args === null || !("name" in args)) {
			return undefined;
		}
		const name = args.name;
		return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
	}

	private async forwardSubagentEvent(component: ToolExecutionComponent, event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "tool_execution_start": {
				const nested = component.ensureSubagentNestedTool(
					event.toolName,
					event.toolCallId,
					event.args,
					this.getRegisteredToolDefinition(event.toolName),
				);
				nested?.markExecutionStarted();
				if (nested && event.toolName === "Subagent") {
					const nestedName = this.getSubagentNameFromArgs(event.args) ?? "subagent";
					nested.beginSubagentRun(nestedName, this.getSubagentColorHexByName(nestedName));
					this.subagentRenderStack.push(nested);
				}
				this.ui.requestRender();
				break;
			}
			case "tool_execution_update": {
				const nested = component.getSubagentNestedTool(event.toolCallId);
				nested?.updateResult({ ...event.partialResult, isError: false }, true);
				this.ui.requestRender();
				break;
			}
			case "tool_execution_end": {
				const nested = component.getSubagentNestedTool(event.toolCallId);
				if (nested) {
					nested.updateResult({ ...event.result, isError: event.isError });
					if (event.toolName === "Subagent") {
						nested.completeSubagentRun();
						this.removeSubagentRenderComponent(nested);
					}
					this.ui.requestRender();
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
						component.setSubagentFinalMessage(event.message.errorMessage || "Subagent failed");
					} else {
						component.setSubagentFinalMessage(this.getAssistantTextContent(event.message));
					}
				}
				break;
			}
			case "agent_end":
				component.completeSubagentRun();
				this.ui.requestRender();
				break;
		}
	}

	private async createSubagentSession(definition: SubagentDefinition): Promise<AgentSession> {
		const cwd = this.runtimeHost.cwd;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.runtimeHost.services.agentDir,
			settingsManager: this.settingsManager,
			appendSystemPromptOverride: (base) => [...base, definition.prompt],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir: this.runtimeHost.services.agentDir,
			authStorage: this.session.modelRegistry.authStorage,
			modelRegistry: this.session.modelRegistry,
			settingsManager: this.settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		});

		this.bindSubagentInvoker(session);
		session.setPromptMode(this.promptMode);
		session.setSessionName(`subagent:${definition.name}`);

		if (definition.tools && definition.tools.length > 0) {
			const activeToolNames = definition.tools.map((tool) => SUBAGENT_TOOL_NAME_MAP[tool]);
			session.setActiveToolsByName(activeToolNames);
		}

		return session;
	}

	private async getOrCreateSubagentSession(name: string): Promise<AgentSession> {
		const existing = this.subagentSessions.get(name);
		if (existing) {
			return existing;
		}

		const definition = this.runtimeHost.session.resourceLoader
			.getSubagents()
			.subagents.find((subagent) => subagent.name === name);
		if (!definition) {
			throw new Error(`Unknown subagent: ${name}`);
		}

		const session = await this.createSubagentSession(definition);
		this.subagentSessions.set(name, session);
		return session;
	}

	private async invokeSubagent(request: SubagentInvocationRequest): Promise<string> {
		const name = request.name.trim();
		const instruction = request.instruction.trim();
		const { signal } = request;
		if (!name) {
			throw new Error("Subagent name is required");
		}
		if (!instruction) {
			throw new Error("Subagent instruction is required");
		}
		if (this.subagentInvocationStack.some((invocation) => invocation.name === name)) {
			throw new Error(`Recursive subagent invocation is not allowed: ${name}`);
		}

		const session = await this.getOrCreateSubagentSession(name);
		if (signal?.aborted) {
			void session.abort();
			throw new Error("Subagent was aborted");
		}
		const component = this.subagentRenderStack.at(-1);
		component?.beginSubagentRun(name, this.getSubagentColorHexByName(name));
		const unsubscribe = component
			? session.subscribe(async (event) => {
					await this.forwardSubagentEvent(component, event);
				})
			: undefined;
		const abortSubagent = () => {
			void session.abort();
		};
		signal?.addEventListener("abort", abortSubagent, { once: true });
		this.subagentInvocationStack.push({ name, session });
		try {
			await session.prompt(instruction);
			const text = session.getLastAssistantText();
			component?.setSubagentFinalMessage(text);
			component?.completeSubagentRun();
			return text ?? `Subagent ${name} completed without a text response.`;
		} finally {
			signal?.removeEventListener("abort", abortSubagent);
			unsubscribe?.();
			component?.completeSubagentRun();
			this.subagentInvocationStack.pop();
		}
	}

	private async switchToSubagent(name: string | undefined): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;

		if (!name) {
			this.activeSessionOverride = undefined;
			this.activeSubagentName = undefined;
			this.bindSubagentInvoker(this.runtimeHost.session);
		} else {
			const session = await this.getOrCreateSubagentSession(name);
			this.activeSessionOverride = session;
			this.activeSubagentName = name;
		}

		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.session.setPromptMode(this.promptMode);
		this.applyPromptModeUi();
		this.subscribeToAgent();
		this.renderCurrentSessionState();
		this.updateTerminalTitle();
	}

	private async showSubagentSelector(): Promise<void> {
		const subagents = this.runtimeHost.session.resourceLoader.getSubagents().subagents;
		if (subagents.length === 0) {
			this.showStatus("No subagents found");
			return;
		}

		const options = [
			SUBAGENT_MAIN_SELECTOR,
			...subagents.map((subagent) =>
				subagent.description.trim().length > 0 ? `${subagent.name} — ${subagent.description}` : subagent.name,
			),
		];
		const selected = await this.showExtensionSelector("Select agent", options);
		if (!selected) {
			return;
		}

		if (selected === SUBAGENT_MAIN_SELECTOR) {
			await this.switchToSubagent(undefined);
			this.showStatus("Switched to main agent");
			return;
		}

		const name = selected.split(" — ")[0] ?? selected;
		await this.switchToSubagent(name);
		this.showStatus(`Switched to subagent: ${name}`);
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(
		description: string | undefined,
		sourceInfo?: SourceInfo,
		overrideTag?: string,
	): string | undefined {
		const sourceTag = overrideTag ?? this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner | undefined): ResourceDiagnostic[] {
		if (!extensionRunner) {
			return [];
		}

		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private setupAutocomplete(fdPath: string | undefined): void {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const effortCommand = slashCommands.find((command) => command.name === "effort");
		if (effortCommand) {
			effortCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const efforts = this.session.getAvailableReasoningEfforts();
				const filtered = fuzzyFilter(efforts, prefix, (effort) => effort);
				if (filtered.length === 0) return null;
				return filtered.map((effort) => ({
					value: effort,
					label: effort,
					description: effort === "none" ? "Disable reasoning" : `Set reasoning effort to ${effort}`,
				}));
			};
		}

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert command templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.commandTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo, "c"),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands().filter((cmd) => !builtinCommandNames.has(cmd.name)) ?? []
		).map((cmd) => ({
			name: cmd.invocationName,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		// Setup autocomplete
		this.autocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			fdPath,
		);
		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		const logo = theme.bold(theme.fg("accent", TUI_APP_NAME)) + theme.fg("dim", ` v ${this.version}`);
		const hello = theme.fg("dim", "Hello. Ask Pi to inspect, explain, or edit your code.");
		const statusHint = `${theme.fg("dim", "Use")} ${theme.bold("/status")} ${theme.fg("dim", "for shortcuts and loaded resources.")}`;
		this.builtInHeader = new Text(`${logo}\n${hello}\n${statusHint}`, 1, 0);
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(this.builtInHeader);
		this.headerContainer.addChild(new Spacer(1));

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		// Initialize extensions first so resources are shown before messages
		await this.bindCurrentSessionExtensions();
		this.bindSubagentInvoker(this.session);
		this.ensureMainSessionSubagentTool();
		this.session.setPromptMode(this.promptMode);
		this.applyPromptModeUi();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set terminal title
		this.updateTerminalTitle();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		const agentLabel = this.activeSubagentName ? ` - ${this.activeSubagentName}` : "";
		if (sessionName) {
			this.ui.terminal.setTitle(`${TERMINAL_TITLE}${agentLabel} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${TERMINAL_TITLE}${agentLabel} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const commandsResult = this.session.resourceLoader.getCommands();
		const themesResult = this.session.resourceLoader.getThemes();
		const subagentsResult = this.session.resourceLoader.getSubagents();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of commandsResult.commands) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				this.chatContainer.addChild(new Text(`${sectionHeader("Context")}\n${contextList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const subagents = subagentsResult.subagents;
			if (subagents.length > 0) {
				const groups = this.buildScopeGroups(
					subagents.map((subagent) => ({ path: subagent.filePath, sourceInfo: subagent.sourceInfo })),
				);
				const subagentByPath = new Map(subagents.map((subagent) => [subagent.filePath, subagent]));
				const subagentList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const subagent = subagentByPath.get(item.path);
						return subagent ? `${subagent.name} (${subagent.description})` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const subagent = subagentByPath.get(item.path);
						return subagent
							? `${subagent.name} (${subagent.description})`
							: this.getShortPath(item.path, item.sourceInfo);
					},
				});
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader("Agents")}
${subagentList}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}\n${skillList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const templates = this.session.commandTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Commands")}\n${templateList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}\n${extList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}\n${themeList}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = commandsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();
					try {
						const result = await this.runtimeHost.newSession(options);
						if (!result.cancelled) {
							await this.handleRuntimeSessionChange();
							this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (!result.cancelled) {
							await this.handleRuntimeSessionChange();
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					return { cancelled: false };
				},
				switchSession: async (sessionPath) => {
					await this.handleResumeSession(sessionPath);
					return { cancelled: false };
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete(this.fdPath);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showStartupNoticesIfNeeded();
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showStartupNoticesIfNeeded();
	}

	private applyRuntimeSettings(): void {
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async handleRuntimeSessionChange(): Promise<void> {
		this.disposeSubagentSessions();
		this.resetExtensionUI();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.lastPlanText = undefined;
		this.applyRuntimeSettings();
		await this.bindCurrentSessionExtensions();
		this.bindSubagentInvoker(this.session);
		this.ensureMainSessionSubagentTool();
		this.session.setPromptMode(this.promptMode);
		this.applyPromptModeUi();
		this.subscribeToAgent();
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.clearSubagentRenderStack();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			signal: this.session.agent.signal,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				if (this.loadingAnimation) {
					if (message) {
						this.loadingAnimation.setMessage(message);
					} else {
						this.loadingAnimation.setMessage(
							`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
						);
					}
				} else {
					// Queue message for when loadingAnimation is created (handles agent_start race)
					this.pendingWorkingMessage = message;
				}
			},
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setPrompt !== undefined) {
				newEditor.setPrompt(this.defaultEditor.getPrompt());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	private scheduleTurnReadyNotification(): void {
		if (this.turnReadyNotificationTimer) {
			clearTimeout(this.turnReadyNotificationTimer);
		}

		this.turnReadyNotificationTimer = setTimeout(() => {
			this.turnReadyNotificationTimer = undefined;
			if (this.shutdownRequested || this.isShuttingDown) {
				return;
			}
			if (
				this.session.isStreaming ||
				this.session.isCompacting ||
				this.session.isRetrying ||
				this.session.isBashRunning
			) {
				return;
			}

			const { steering, followUp } = this.getAllQueuedMessages();
			if (steering.length > 0 || followUp.length > 0) {
				return;
			}

			try {
				notifier.notify({
					title: TUI_APP_NAME,
					message: "Agent finished its turn and is waiting for your next prompt.",
				});
			} catch {
				// Ignore notification backend errors.
			}
		}, 0);
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.loadingAnimation) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.hasActiveSubagentInvocation()) {
				this.abortActiveSubagentInvocations();
				void this.session.abort();
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.mode.cycle", () => this.cyclePromptMode());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.writeDebugLog();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			if (text.startsWith("/")) {
				this.editor.addToHistory?.(text);
			}

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/effort" || text.startsWith("/effort ")) {
				this.editor.setText("");
				this.handleEffortCommand(text);
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/status") {
				this.handleStatusCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/context") {
				this.handleContextCommand();
				this.editor.setText("");
				return;
			}
			if (text.startsWith("/cwl-mode")) {
				this.handleCwlModeCommand(text.slice(9).trim());
				this.editor.setText("");
				return;
			}
			if (text.startsWith("/cwl")) {
				this.handleCwlCommand(text.slice(4).trim());
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/clear") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.toggleDebugMode();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/agents") {
				this.editor.setText("");
				await this.showSubagentSelector();
				return;
			}
			if (text === "/execute-plan") {
				this.editor.setText("");
				await this.executeCurrentPlan();
				return;
			}
			if (text === "/loop" || text.startsWith("/loop ")) {
				this.editor.setText("");
				await this.handleLoopCommand(text);
				return;
			}
			if (text === "/exit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), command template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					this.defaultWorkingMessage,
					{ showElapsed: true },
				);
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "assistant" && this.promptMode === "plan") {
					const planText = this.session.getLastAssistantText();
					if (planText) {
						this.lastPlanText = planText;
					}
				}
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				if (event.toolName === "Subagent") {
					const subagentName = this.getSubagentNameFromArgs(event.args) ?? "subagent";
					component.beginSubagentRun(subagentName, this.getSubagentColorHexByName(subagentName));
					this.subagentRenderStack.push(component);
				}
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					if (event.toolName === "Subagent") {
						component.completeSubagentRun();
						this.removeSubagentRenderComponent(component);
					}
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.loadingAnimation) {
					this.loadingAnimation.complete();
					this.loadingAnimation = undefined;
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.clearSubagentRenderStack();
				this.pendingTools.clear();

				await this.checkShutdownRequested();
				this.scheduleTurnReadyNotification();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				if (event.reason !== "manual") {
					this.scheduleTurnReadyNotification();
				}
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${keyText("app.interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "scheduler_status":
				this.showStatus(event.message);
				break;

			case "cwl_cleanup":
				this.showCwlCleanupMessage(event);
				break;

			case "cwl_measurement":
				this.ui.requestRender();
				break;
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private formatCwlCleanupMessage(event: Extract<AgentSessionEvent, { type: "cwl_cleanup" }>): string {
		const removedTokens = Math.max(0, event.tokensBefore - event.tokensAfter);
		const summaryLine = `Tokens ${event.tokensBefore.toLocaleString()} -> ${event.tokensAfter.toLocaleString()} (removed ${removedTokens.toLocaleString()}, target <= ${event.threshold.toLocaleString()})`;
		if (!this.debugModeEnabled) {
			return [theme.bold(theme.fg("warning", "CWL cleanup applied")), theme.fg("muted", summaryLine)].join("\n");
		}

		const lines = [
			theme.bold(theme.fg("warning", "CWL cleanup applied")),
			theme.fg("muted", summaryLine),
			theme.fg("muted", `Chunks touched: ${event.evictedChunks} · noted file paths: ${event.notedFilePaths}`),
		];

		for (const chunk of event.chunkStats) {
			const stepParts = chunk.steps.map((step) => {
				const details: string[] = [];
				if (step.removedThinkingBlocks > 0) details.push(`${step.removedThinkingBlocks} thinking`);
				if (step.removedToolCalls > 0) details.push(`${step.removedToolCalls} tool calls`);
				if (step.removedToolResults > 0) details.push(`${step.removedToolResults} results`);
				if (step.removedAssistantMessages > 0) details.push(`${step.removedAssistantMessages} msgs`);
				if (step.removedFilePaths.length > 0) {
					const preview = step.removedFilePaths.slice(0, 4).join(", ");
					const overflow = step.removedFilePaths.length > 4 ? ` (+${step.removedFilePaths.length - 4} more)` : "";
					details.push(`${step.removedFilePaths.length} file paths: ${preview}${overflow}`);
				}
				const tools = Object.entries(step.toolCallCounts)
					.map(([toolName, count]) => `${toolName}×${count}`)
					.join(", ");
				const label =
					step.step === "entire_chunk"
						? "entire chunk"
						: step.step === "thinking"
							? "thinking"
							: step.step === "search_tools"
								? "search tools"
								: step.step === "bash_tools"
									? "bash tools"
									: "read tools";
				const tokenDelta = Math.max(0, step.tokensBefore - step.tokensAfter).toLocaleString();
				return `${label}: ${details.join(", ") || "no-op"}${tools ? ` [${tools}]` : ""} (-${tokenDelta} tok)`;
			});
			const chunkSummary = chunk.fullyRemoved ? "fully evicted" : "partially evicted";
			lines.push(
				theme.fg(
					"warning",
					`- ${chunk.chunkName} [${chunk.chunkKind}] ${chunkSummary}${chunk.dependencies.length > 0 ? ` dep=${chunk.dependencies.join(",")}` : ""}`,
				),
			);
			for (const part of stepParts) {
				lines.push(theme.fg("muted", `  ${part}`));
			}
		}

		return lines.join("\n");
	}

	private showCwlCleanupMessage(event: Extract<AgentSessionEvent, { type: "cwl_cleanup" }>): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(this.formatCwlCleanupMessage(event), 1, 0));
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderMessageList(messages: AgentMessage[], options: { populateHistory?: boolean } = {}): void {
		this.pendingTools.clear();

		for (const message of messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		this.renderMessageList(sessionContext.messages, {
			populateHistory: options.populateHistory,
		});
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		if (this.loadingAnimation) {
			this.restoreQueuedMessagesToEditor({ abort: true });
			return;
		}
		if (this.hasActiveSubagentInvocation()) {
			this.abortActiveSubagentInvocations();
			void this.session.abort();
			return;
		}
		if (this.session.isStreaming) {
			void this.session.abort();
			return;
		}
		if (this.session.isBashRunning) {
			this.session.abortBash();
			return;
		}

		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		await this.runtimeHost.dispose();

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), command template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private getEditorBorderColor(): (text: string) => string {
		const subagentBorderColor = this.getSubagentBorderColor();
		if (subagentBorderColor) {
			return subagentBorderColor;
		}
		if (this.isBashMode) {
			return theme.getBashModeBorderColor();
		}
		if (this.promptMode === "plan") {
			return theme.getPlanModeBorderColor();
		}
		return theme.getThinkingBorderColor("medium");
	}

	private updateEditorBorderColor(): void {
		const borderColor = this.getEditorBorderColor();
		this.defaultEditor.borderColor = borderColor;
		this.editor.borderColor = borderColor;
		this.ui.requestRender();
	}

	private applyPromptModeUi(): void {
		const promptText = this.promptMode === "plan" ? "Plan ❯ " : "❯ ";
		const subagentColorizer = this.getSubagentColorizer();
		const prompt = subagentColorizer ? subagentColorizer(promptText) : promptText;
		this.defaultEditor.setPrompt(prompt);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPrompt?.(prompt);
		}
		const subagentStatus =
			this.activeSubagentName && subagentColorizer
				? subagentColorizer(`Agent: ${this.activeSubagentName}`)
				: this.activeSubagentName
					? theme.fg("accent", `Agent: ${this.activeSubagentName}`)
					: undefined;
		this.setExtensionStatus("agent", subagentStatus);
		this.setExtensionStatus("agent-mode", this.promptMode === "plan" ? theme.fg("warning", "Plan Mode") : undefined);
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	private cyclePromptMode(): void {
		if (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.session.isRetrying ||
			this.session.isBashRunning
		) {
			this.showWarning("Wait for the current activity to finish before switching modes.");
			return;
		}

		const nextMode = this.promptMode === "default" ? "plan" : "default";
		this.setPromptMode(nextMode);
		this.showStatus(this.promptMode === "plan" ? "Plan Mode enabled" : "Default mode enabled");
	}

	private setPromptMode(mode: AgentPromptMode): void {
		this.promptMode = mode;
		this.session.setPromptMode(mode);
		this.applyPromptModeUi();
	}

	private getPlanExecutionPrompt(planText: string): string {
		return `Implement the following plan. Carry it out directly, making the necessary code changes and validations.

Plan:
${planText}`;
	}

	private async executeCurrentPlan(): Promise<void> {
		if (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.session.isRetrying ||
			this.session.isBashRunning
		) {
			this.showWarning("Wait for the current activity to finish before executing the plan.");
			return;
		}

		const planText = this.lastPlanText?.trim();
		if (!planText) {
			this.showWarning("No plan is available yet. Ask the agent for a plan first.");
			return;
		}

		const executionPrompt = this.getPlanExecutionPrompt(planText);
		this.setPromptMode("default");
		this.lastPlanText = undefined;

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			await this.handleRuntimeSessionChange();
			this.renderCurrentSessionState();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("accent", "✓ Plan execution session started"), 1, 1));
			this.ui.requestRender();
			await this.session.prompt(executionPrompt);
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to execute plan", error);
		}
	}

	private cycleThinkingLevel(): void {
		const newEffort = this.session.cycleReasoningEffort();
		if (newEffort === undefined) {
			this.showStatus("Current model does not support reasoning effort");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Reasoning effort: ${newEffort}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const reasoningEffort = this.session.getReasoningEffort();
				const effortStr = result.model.reasoning ? ` (effort: ${reasoningEffort})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${effortStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					reasoningEffort: this.session.getReasoningEffort(),
					availableReasoningEfforts: this.session.getAvailableReasoningEfforts(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocomplete(this.fdPath);
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onReasoningEffortChange: (effort) => {
						this.session.setReasoningEffort(effort);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private parseReasoningEffort(value: string): ReasoningEffort | undefined {
		const normalized = value.trim().toLowerCase();
		if (
			normalized === "none" ||
			normalized === "low" ||
			normalized === "medium" ||
			normalized === "high" ||
			normalized === "xhigh"
		) {
			return normalized;
		}
		return undefined;
	}

	private handleEffortCommand(text: string): void {
		if (!this.session.supportsThinking()) {
			this.showStatus("Current model does not support reasoning effort");
			return;
		}

		const rawEffort = text.startsWith("/effort ") ? text.slice(8).trim() : "";
		if (!rawEffort) {
			const available = this.session.getAvailableReasoningEfforts().join(", ");
			this.showStatus(`Reasoning effort: ${this.session.getReasoningEffort()} (available: ${available})`);
			return;
		}

		const effort = this.parseReasoningEffort(rawEffort);
		if (!effort) {
			this.showError("Usage: /effort <none|low|medium|high|xhigh>");
			return;
		}

		if (!this.session.getAvailableReasoningEfforts().includes(effort)) {
			const available = this.session.getAvailableReasoningEfforts().join(", ");
			this.showError(`Reasoning effort "${effort}" is not available for the current model. Available: ${available}`);
			return;
		}

		this.session.setReasoningEffort(effort);
		this.footer.invalidate();
		this.updateEditorBorderColor();
		this.showStatus(`Reasoning effort: ${effort}`);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			return;
		}

		try {
			const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		if (this.isSubagentActive) {
			this.showWarning("Forking is not available while a subagent is active. Switch back to Main first.");
			return;
		}

		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.runtimeHost.fork(entryId);
					if (result.cancelled) {
						done();
						this.ui.requestRender();
						return;
					}
					await this.handleRuntimeSessionChange();
					this.renderCurrentSessionState();
					this.editor.setText(result.selectedText ?? "");
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		if (this.isSubagentActive) {
			this.showWarning("Tree navigation is not available while a subagent is active. Switch back to Main first.");
			return;
		}

		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		if (this.isSubagentActive) {
			this.showWarning("Session resume is not available while a subagent is active. Switch back to Main first.");
			return;
		}

		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath);
			if (result.cancelled) {
				return;
			}
			await this.handleRuntimeSessionChange();
			this.renderCurrentSessionState();
			this.showStatus("Resumed session");
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return;
				}
				const result = await this.runtimeHost.switchSession(sessionPath, selectedCwd);
				if (result.cancelled) {
					return;
				}
				await this.handleRuntimeSessionChange();
				this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return;
			}
			await this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter(
				(p) => this.session.modelRegistry.authStorage.get(p)?.type === "oauth",
			);
			if (loggedInProviders.length === 0) {
				this.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (providerId: string) => {
					done();

					if (mode === "login") {
						await this.showLoginDialog(providerId);
					} else {
						// Logout flow
						const providerInfo = this.session.modelRegistry.authStorage
							.getOAuthProviders()
							.find((p) => p.id === providerId);
						const providerName = providerInfo?.name || providerId;

						try {
							this.session.modelRegistry.authStorage.logout(providerId);
							this.session.modelRegistry.refresh();
							await this.updateAvailableProviderCount();
							this.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerInfo?.name || providerId;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					} else if (providerId === "github-copilot") {
						// GitHub Copilot polls after onAuth
						dialog.showWaiting("Waiting for browser authentication...");
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			this.session.modelRegistry.refresh();
			await this.updateAvailableProviderCount();
			this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleLoopCommand(text: string): Promise<void> {
		if (!this.session.isSchedulerEnabled()) {
			this.showWarning("Scheduling is disabled. Unset PI_DISABLE_CRON to use /loop.");
			return;
		}
		if (this.isSubagentActive) {
			this.showWarning("/loop is only available on the main agent session.");
			return;
		}
		if (
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.session.isRetrying ||
			this.session.isBashRunning
		) {
			this.showWarning("Wait for the current activity to finish before starting a loop.");
			return;
		}

		try {
			const created = await this.session.createLoop(text);
			if (created.mode === "fixed") {
				const note = created.normalizationNote ? ` ${created.normalizationNote}` : "";
				this.showStatus(`Loop ${created.task.id} created (${created.intervalDisplay}).${note}`);
				return;
			}
			this.showStatus(`Dynamic loop ${created.task.id} started.`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(
			this.ui,
			theme,
			"Reloading keybindings, extensions, skills, commands, themes...",
			{
				cancellable: false,
			},
		);
		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			this.disposeSubagentSessions();
			this.bindSubagentInvoker(this.session);
			this.keybindings.reload();
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocomplete(this.fdPath);
			const runner = this.session.extensionRunner;
			if (runner) {
				this.setupExtensionShortcuts(runner);
			}
			this.rebuildChatFromMessages();
			this.applyPromptModeUi();
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, commands, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.sessionManager.appendSessionInfo(name);
		this.updateTerminalTitle();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleStatusCommand(): void {
		this.showLoadedResources({
			force: true,
			showDiagnosticsWhenQuiet: true,
		});
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private formatTokenCount(value: number | null | undefined): string {
		if (value === null || value === undefined) return "?";
		return value.toLocaleString();
	}

	private renderAsciiBar(value: number, max: number, width = 28): string {
		if (width <= 0) return "";
		if (max <= 0) return "░".repeat(width);
		const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
		return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
	}

	private getHealthLabel(percent: number | null | undefined): {
		label: string;
		color: "success" | "warning" | "error" | "muted";
	} {
		if (percent === null || percent === undefined) return { label: "unknown", color: "muted" };
		if (percent >= 90) return { label: "critical", color: "error" };
		if (percent >= 75) return { label: "high", color: "warning" };
		return { label: "healthy", color: "success" };
	}

	private getContextTypeEntries(message: AgentMessage): Array<{ key: string; label: string; tokens: number }> {
		switch (message.role) {
			case "user":
				return [{ key: "user", label: "user message", tokens: estimateTokens(message) }];
			case "assistant":
				return message.content.flatMap((item) => {
					if (item.type === "text") {
						return [{ key: "assistant-text", label: "assistant text", tokens: Math.ceil(item.text.length / 4) }];
					}
					if (item.type === "thinking") {
						return [
							{
								key: "assistant-reasoning",
								label: "assistant reasoning",
								tokens: Math.ceil(item.thinking.length / 4),
							},
						];
					}
					if (item.type === "toolCall") {
						const text = `${item.name}${JSON.stringify(item.arguments)}`;
						return [{ key: "tool-call", label: "tool call", tokens: Math.ceil(text.length / 4) }];
					}
					return [];
				});
			case "toolResult":
				return [{ key: "tool-result", label: "tool result", tokens: estimateTokens(message) }];
			case "bashExecution":
				return [{ key: "bash", label: "bash context", tokens: estimateTokens(message) }];
			case "custom":
				return [{ key: "custom", label: "custom context", tokens: estimateTokens(message) }];
			case "branchSummary":
				return [{ key: "branch-summary", label: "branch summary", tokens: estimateTokens(message) }];
			case "compactionSummary":
				return [{ key: "compaction-summary", label: "compaction summary", tokens: estimateTokens(message) }];
		}
	}

	private handleContextCommand(): void {
		const contextUsage = this.session.getContextUsage();
		const context = this.sessionManager.buildSessionContext();
		const rawMessages = this.session.messages;
		const systemPrompt = this.session.systemPrompt;
		const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
		const estimatedContext = estimateContextTokens(context.messages);
		const approxPromptTokens = systemPromptTokens + estimatedContext.tokens;
		const modelContextWindow = contextUsage?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		const contextWindow = getEffectiveCwlThreshold(modelContextWindow, this.session.cwlLimit);
		const usedTokens = contextUsage?.tokens ?? approxPromptTokens;
		const percent = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : null;
		const health = this.getHealthLabel(percent);
		const activeChunk = getActiveChunk(rawMessages);
		const chunkEvents = getChunkEntries(rawMessages);

		// --- type breakdown ---
		const typeBreakdown = new Map<string, { label: string; count: number; tokens: number }>();
		const addType = (key: string, label: string, tokens: number) => {
			const current = typeBreakdown.get(key) ?? { label, count: 0, tokens: 0 };
			current.count += 1;
			current.tokens += tokens;
			typeBreakdown.set(key, current);
		};
		addType("system", "system prompt", systemPromptTokens);
		for (const message of context.messages) {
			for (const entry of this.getContextTypeEntries(message)) {
				addType(entry.key, entry.label, entry.tokens);
			}
		}

		// --- tool output breakdown by name ---
		const toolOutputByName = new Map<string, { count: number; tokens: number }>();
		for (const message of context.messages) {
			if (message.role === "toolResult") {
				const name = message.toolName ?? "unknown";
				const tokens = estimateTokens(message);
				const current = toolOutputByName.get(name) ?? { count: 0, tokens: 0 };
				current.count += 1;
				current.tokens += tokens;
				toolOutputByName.set(name, current);
			}
		}

		// --- chunk breakdown ---
		const chunkTypeCounts = new Map<ChunkKind, number>();
		const chunkByName = new Map<string, ChunkInfo>();
		for (const event of chunkEvents) {
			if (event.action !== "start") continue;
			chunkByName.set(event.chunk.name, event.chunk);
			chunkTypeCounts.set(event.chunk.type, (chunkTypeCounts.get(event.chunk.type) ?? 0) + 1);
		}

		const chunkStats = new Map<
			string,
			{
				type: ChunkKind | "none";
				messages: number;
				tokens: number;
				types: Map<string, { label: string; tokens: number }>;
			}
		>();
		const ensureChunkStat = (name: string, type: ChunkKind | "none") => {
			const current = chunkStats.get(name) ?? { type, messages: 0, tokens: 0, types: new Map() };
			chunkStats.set(name, current);
			return current;
		};
		let currentChunk: ChunkInfo | undefined;
		for (const message of rawMessages) {
			const isDelimiterResult =
				message.role === "toolResult" &&
				message.toolName === "delimiter" &&
				typeof message.details === "object" &&
				message.details !== null &&
				"chunkEvent" in message.details;
			const event = isDelimiterResult ? (message.details as ChunkDetails).chunkEvent : undefined;
			if (event?.action === "start") {
				currentChunk = event.chunk;
			}
			const bucket = ensureChunkStat(currentChunk?.name ?? "(outside chunks)", currentChunk?.type ?? "none");
			bucket.messages += 1;
			bucket.tokens += estimateTokens(message);
			for (const entry of this.getContextTypeEntries(message)) {
				const currentType = bucket.types.get(entry.key) ?? { label: entry.label, tokens: 0 };
				currentType.tokens += entry.tokens;
				bucket.types.set(entry.key, currentType);
			}
			if (event?.action === "end") {
				currentChunk = undefined;
			}
		}

		// --- helpers ---
		const divider = theme.fg("dim", "─".repeat(56));
		const sectionHeader = (title: string) => `${theme.bold(theme.fg("accent", title))}\n${divider}`;

		// Render a labeled bar line with right-aligned token and count columns.
		// "  label              ████████████░░░░░░░░░░░░   12,345 tok   42 msg"
		const renderBarLine = (
			label: string,
			labelWidth: number,
			tokens: number,
			maxTokens: number,
			count: number,
			countSuffix: string,
		): string => {
			const bar = this.renderAsciiBar(tokens, maxTokens, 24);
			const tokStr = `${this.formatTokenCount(tokens)} tok`;
			const countStr = `${count} ${countSuffix}`;
			return `  ${label.padEnd(labelWidth)}  ${bar}  ${tokStr.padStart(11)}  ${countStr}`;
		};

		// --- type section ---
		const typeSorted = Array.from(typeBreakdown.values()).sort((a, b) => b.tokens - a.tokens);
		const maxTypeTokens = Math.max(...typeSorted.map((e) => e.tokens), 1);
		const typeLabelWidth = Math.max(...typeSorted.map((e) => e.label.length), 8);
		const typeLines = typeSorted.map((e) =>
			renderBarLine(e.label, typeLabelWidth, e.tokens, maxTypeTokens, e.count, e.count === 1 ? "msg" : "msgs"),
		);

		// --- tool output section ---
		const toolSorted = Array.from(toolOutputByName.entries()).sort((a, b) => b[1].tokens - a[1].tokens);
		const maxToolTokens = Math.max(...toolSorted.map(([, v]) => v.tokens), 1);
		const toolLabelWidth = Math.max(...toolSorted.map(([name]) => name.length), 8);
		const toolLines = toolSorted.map(([name, v]) =>
			renderBarLine(name, toolLabelWidth, v.tokens, maxToolTokens, v.count, v.count === 1 ? "call" : "calls"),
		);

		// --- chunk section ---
		const chunkSorted = Array.from(chunkStats.entries()).sort((a, b) => b[1].tokens - a[1].tokens);
		const maxChunkTokens = Math.max(...chunkSorted.map(([, v]) => v.tokens), 1);
		const chunkDisplayNames = chunkSorted.map(([name, entry]) => {
			const isActive = activeChunk?.name === name;
			const kindTag = entry.type !== "none" ? ` [${entry.type}]` : "";
			return `${name}${isActive ? " ●" : ""}${kindTag}`;
		});
		const chunkLabelWidth = Math.max(...chunkDisplayNames.map((n) => n.length), 8);
		const chunkLines: string[] = [];
		for (let i = 0; i < chunkSorted.length; i++) {
			const [, entry] = chunkSorted[i];
			const displayName = chunkDisplayNames[i];
			chunkLines.push(
				renderBarLine(
					displayName,
					chunkLabelWidth,
					entry.tokens,
					maxChunkTokens,
					entry.messages,
					entry.messages === 1 ? "msg" : "msgs",
				),
			);
			const typeParts = Array.from(entry.types.values())
				.sort((a, b) => b.tokens - a.tokens)
				.map((t) => `${t.label}=${this.formatTokenCount(t.tokens)}`);
			if (typeParts.length > 0) {
				chunkLines.push(`    ${theme.fg("dim", typeParts.join("  "))}`);
			}
		}

		// --- summary section ---
		const healthLabel = `${health.label}${percent !== null && percent !== undefined ? ` (${percent.toFixed(1)}%)` : ""}`;
		const windowBar = this.renderAsciiBar(percent ?? 0, 100, 24);
		const modelLabel = this.session.model
			? `${this.session.model.provider} / ${this.session.model.id}`
			: "(no model)";
		const chunkCountLabel = `${chunkByName.size} delimiter${chunkByName.size !== 1 ? "s" : ""}`;
		const chunkKindParts = Array.from(chunkTypeCounts.entries()).map(([k, v]) => `${k}=${v}`);
		const chunkKindSummary = chunkKindParts.length > 0 ? `  (${chunkKindParts.join("  ")})` : "";
		const summaryLines = [
			`  Model      ${modelLabel}`,
			`  Health     ${theme.fg(health.color, healthLabel)}`,
			`  Window     ${windowBar}  ${this.formatTokenCount(usedTokens)} / ${this.formatTokenCount(contextWindow)} tok`,
			`  CWL        ${this.session.cwlLimit ? "custom" : `default (${DEFAULT_CWL_THRESHOLD_TOKENS.toLocaleString()} tok)`}${modelContextWindow > 0 ? `  |  model max: ${this.formatTokenCount(modelContextWindow)} tok` : ""}`,
			`  Measure    ${this.session.cwlTokenMeasurementMode === "fast" ? "fast heuristic" : "exact provider count"}`,
			`  Payload    ~${this.formatTokenCount(approxPromptTokens)} tok  (system: ${this.formatTokenCount(systemPromptTokens)}  +  messages: ${this.formatTokenCount(estimatedContext.tokens)})`,
			`  Messages   ${context.messages.length} active  |  ${rawMessages.length} raw`,
			`  Chunks     ${chunkCountLabel}${chunkKindSummary}  |  ${activeChunk ? `${activeChunk.name} [${activeChunk.type}] active` : "none active"}`,
		];

		const info = [
			sectionHeader("Context Window"),
			"",
			...summaryLines.map((l) => theme.fg("text", l)),
			"",
			sectionHeader("By Type"),
			"",
			...(typeLines.length > 0 ? typeLines.map((l) => theme.fg("text", l)) : [theme.fg("dim", "  (none)")]),
			"",
			sectionHeader("Tool Outputs"),
			"",
			...(toolLines.length > 0 ? toolLines.map((l) => theme.fg("text", l)) : [theme.fg("dim", "  (none)")]),
			"",
			sectionHeader("By Chunk"),
			"",
			...(chunkLines.length > 0 ? chunkLines : [theme.fg("dim", "  (none)")]),
		].join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private handleCwlCommand(arg: string): void {
		const contextWindow = this.session.model?.contextWindow ?? 0;
		const divider = theme.fg("dim", "─".repeat(56));
		const sectionHeader = (title: string) => `${theme.bold(theme.fg("accent", title))}\n${divider}`;

		// Show current limit when called with no argument
		if (!arg) {
			const current = this.session.cwlLimit;
			const effectiveThreshold = getEffectiveCwlThreshold(contextWindow, current);
			let label: string;
			if (!current) {
				label = `default (${DEFAULT_CWL_THRESHOLD_TOKENS.toLocaleString()} tokens)`;
			} else if (current.type === "percent") {
				label = `${current.value}%`;
			} else {
				label = `${current.value.toLocaleString()} tokens`;
			}
			const info = [
				sectionHeader("CWL Limit"),
				"",
				theme.fg("text", `  Current threshold: ${label}`),
				theme.fg("dim", `  Effective threshold for current model: ${effectiveThreshold.toLocaleString()} tokens`),
				theme.fg("dim", ""),
				theme.fg(
					"dim",
					`  Usage: /cwl 50%  |  /cwl 50k  |  /cwl ${DEFAULT_CWL_THRESHOLD_TOKENS.toLocaleString()}  |  /cwl reset`,
				),
			].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new DynamicBorder());
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.chatContainer.addChild(new DynamicBorder());
			this.ui.requestRender();
			return;
		}

		// Reset to default
		if (arg === "reset" || arg === "default") {
			this.session.setCwlLimit(null);
			updatePersistentGlobalConfig({ cwlLimit: null });
			const info = [
				sectionHeader("CWL Limit"),
				"",
				theme.fg("text", `  Threshold reset to default (${DEFAULT_CWL_THRESHOLD_TOKENS.toLocaleString()} tokens)`),
			].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new DynamicBorder());
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.chatContainer.addChild(new DynamicBorder());
			this.ui.requestRender();
			return;
		}

		const limit = parseCwlLimit(arg);
		if (!limit) {
			const info = [
				sectionHeader("CWL Limit"),
				"",
				theme.fg("error", `  Invalid limit: "${arg}"`),
				theme.fg("dim", "  Token thresholds must be positive numbers"),
				theme.fg("dim", ""),
				theme.fg(
					"dim",
					`  Usage: /cwl 50%  |  /cwl 50k  |  /cwl ${DEFAULT_CWL_THRESHOLD_TOKENS.toLocaleString()}  |  /cwl reset`,
				),
			].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new DynamicBorder());
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.chatContainer.addChild(new DynamicBorder());
			this.ui.requestRender();
			return;
		}

		this.session.setCwlLimit(limit);
		updatePersistentGlobalConfig({ cwlLimit: limit });

		let label: string;
		let detail = "";
		const effectiveThreshold = getEffectiveCwlThreshold(contextWindow, limit);
		if (limit.type === "percent") {
			label = `${limit.value}%`;
			if (contextWindow > 0) {
				detail = `  (~${effectiveThreshold.toLocaleString()} tokens for current model)`;
			}
		} else {
			label = `${limit.value.toLocaleString()} tokens`;
			if (contextWindow > 0) {
				const pct = ((effectiveThreshold / contextWindow) * 100).toFixed(1);
				detail = `  (~${pct}% of current context window)`;
			}
		}

		const lines = [sectionHeader("CWL Limit"), "", theme.fg("text", `  Threshold set to ${label}`)];
		if (detail) lines.push(theme.fg("dim", detail));

		const info = lines.join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private handleCwlModeCommand(arg: string): void {
		const divider = theme.fg("dim", "─".repeat(56));
		const sectionHeader = (title: string) => `${theme.bold(theme.fg("accent", title))}\n${divider}`;
		const currentMode = this.session.cwlTokenMeasurementMode;
		const usage = "  Usage: /cwl-mode        |  /cwl-mode fast  |  /cwl-mode exact  |  /cwl-mode status";
		const setMode = (mode: "fast" | "exact") => {
			this.session.setCwlTokenMeasurementMode(mode);
			updatePersistentGlobalConfig({ cwlTokenMeasurementMode: mode });
		};
		const showInfo = (lines: string[]) => {
			const info = [sectionHeader("CWL Token Measurement"), "", ...lines].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new DynamicBorder());
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.chatContainer.addChild(new DynamicBorder());
			this.ui.requestRender();
		};

		if (arg === "status") {
			const isFast = currentMode === "fast";
			showInfo([
				theme.fg("text", `  Current mode: ${isFast ? "fast heuristic" : "exact provider count"}`),
				theme.fg(
					"dim",
					isFast
						? "  CWL will estimate prompt tokens locally and skip provider counting requests."
						: "  CWL may call the provider token-count endpoint to measure prompt size exactly.",
				),
				theme.fg("dim", ""),
				theme.fg("dim", usage),
			]);
			return;
		}

		if (arg === "fast") {
			setMode("fast");
			showInfo([
				theme.fg("text", "  Switched to fast heuristic token counting"),
				theme.fg("dim", "  CWL will stop sending provider token-count requests and use local estimates instead."),
			]);
			return;
		}

		if (arg === "exact" || arg === "off" || arg === "reset" || arg === "default") {
			setMode("exact");
			showInfo([
				theme.fg("text", "  Switched to exact provider-backed token counting"),
				theme.fg("dim", "  CWL will use provider token count APIs when supported."),
			]);
			return;
		}

		if (arg.length > 0) {
			showInfo([theme.fg("error", `  Invalid mode: "${arg}"`), theme.fg("dim", usage)]);
			return;
		}

		const nextMode = currentMode === "fast" ? "exact" : "fast";
		setMode(nextMode);
		showInfo(
			nextMode === "fast"
				? [
						theme.fg("text", "  Switched to fast heuristic token counting"),
						theme.fg(
							"dim",
							"  CWL will stop sending provider token-count requests and use local estimates instead.",
						),
					]
				: [
						theme.fg("text", "  Switched to exact provider-backed token counting"),
						theme.fg("dim", "  CWL will use provider token count APIs when supported."),
					],
		);
	}

	/**
	 * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
	 */
	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("+"),
			)
			.join("/");
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private async handleClearCommand(): Promise<void> {
		if (this.isSubagentActive && this.activeSubagentName) {
			const name = this.activeSubagentName;
			const existing = this.subagentSessions.get(name);
			existing?.dispose();
			this.subagentSessions.delete(name);
			await this.switchToSubagent(name);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`${theme.fg("accent", `✓ New subagent session started: ${name}`)}`, 1, 1),
			);
			this.ui.requestRender();
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			await this.handleRuntimeSessionChange();
			this.renderCurrentSessionState();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private toggleDebugMode(): void {
		this.debugModeEnabled = !this.debugModeEnabled;
		updatePersistentGlobalConfig({ debugModeEnabled: this.debugModeEnabled });
		this.showStatus(`Debug mode ${this.debugModeEnabled ? "enabled" : "disabled"}`);
	}

	private writeDebugLog(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd: this.sessionManager.getCwd(),
				})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(): void {
		this.disposeSubagentSessions();
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.turnReadyNotificationTimer) {
			clearTimeout(this.turnReadyNotificationTimer);
			this.turnReadyNotificationTimer = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
