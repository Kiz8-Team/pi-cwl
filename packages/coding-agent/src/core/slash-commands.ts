import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "command" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "effort", description: "Set reasoning effort: none, low, medium, high, xhigh" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "status", description: "Show loaded resources" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "context", description: "Show context window health and context breakdown" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "clear", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "agents", description: "Switch to a subagent conversation" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, commands, and themes" },
	{ name: "debug", description: "Toggle debug mode for detailed CWL cleanup output" },
	{ name: "execute-plan", description: "Start a fresh session and implement the last generated plan" },
	{ name: "loop", description: "Run a prompt or slash command on a reccuring interval" },
	{ name: "cwl", description: "Set CWL eviction threshold: /cwl 50% | /cwl 50k | /cwl 150k | /cwl reset" },
	{ name: "cwl-toggle", description: "Toggle CWL cleanup, tracing, delimiter tool, and prompt instructions on/off" },
	{
		name: "cwl-mode",
		description: "Toggle CWL token accounting mode between fast heuristic and exact provider counts",
	},
	{ name: "exit", description: "Exit pi" },
];
