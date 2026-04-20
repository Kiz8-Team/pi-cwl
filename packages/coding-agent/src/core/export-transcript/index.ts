/**
 * Markdown transcript export for pi agent sessions.
 *
 * Formats session messages into a human-readable markdown transcript,
 * with special handling for:
 * - Chunk boundary events from the delimiter tool
 * - Tool calls and results
 * - Thinking / reasoning blocks
 * - Bash executions (! commands)
 * - Compaction and branch summaries
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { ChunkDetails } from "../chunk.js";
import { line as chunkLine } from "../chunk.js";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
} from "../messages.js";
import type { ReadonlySessionManager } from "../session-manager.js";

export interface TranscriptOptions {
	/** Include reasoning/thinking blocks. Default: false */
	thinking?: boolean;
	/** Include full tool input/output. Default: true */
	toolDetails?: boolean;
	/** Include assistant metadata (model, duration). Default: true */
	assistantMetadata?: boolean;
	/** Output file path. If omitted, a timestamped file is created in cwd. */
	outputPath?: string;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUserMessage(msg: { role: "user"; content: unknown; timestamp: number }): string {
	const content = msg.content;
	let text: string;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n\n");
	} else {
		text = String(content);
	}

	// Skip synthetic sticky-note messages
	if (text.includes("<sticky-note>")) return "";

	return `## User\n\n${text.trim()}\n\n---\n\n`;
}

function formatAssistantMessage(msg: AssistantMessage, options: TranscriptOptions): string {
	let header: string;
	if (options.assistantMetadata !== false) {
		const model = msg.model ?? "";
		const provider = msg.provider ?? "";
		const modelLabel = model ? `${provider}/${model}` : provider;
		header = `## Assistant${modelLabel ? ` (${modelLabel})` : ""}\n\n`;
	} else {
		header = "## Assistant\n\n";
	}

	let body = "";
	for (const part of msg.content) {
		if (part.type === "text") {
			body += `${part.text.trim()}\n\n`;
		} else if (part.type === "thinking") {
			if (options.thinking) {
				body += `_Thinking:_\n\n${(part as { type: "thinking"; thinking: string }).thinking}\n\n`;
			}
		} else if (part.type === "toolCall") {
			if (part.name === "delimiter") continue; // rendered via toolResult
			body += `**Tool:** ${part.name}`;
			if (options.toolDetails !== false && part.arguments) {
				body += `\n\n**Input:**\n\`\`\`json\n${JSON.stringify(part.arguments, null, 2)}\n\`\`\``;
			}
			body += "\n\n";
		}
	}

	return `${header}${body}---\n\n`;
}

function formatToolResult(msg: ToolResultMessage, options: TranscriptOptions): string {
	// Delimiter tool: render as chunk boundary marker
	if (msg.toolName === "delimiter") {
		const details = msg.details as ChunkDetails | undefined;
		if (details?.chunkEvent) {
			return `**Chunk** – ${chunkLine(details.chunkEvent)}\n\n`;
		}
		return "";
	}

	if (options.toolDetails === false) return "";

	const textContent = msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	if (!textContent.trim()) return "";

	const status = msg.isError ? "Error" : "Result";
	return `**${msg.toolName} ${status}:**\n\`\`\`\n${textContent}\n\`\`\`\n\n`;
}

function formatBashExecution(msg: BashExecutionMessage): string {
	let text = `**!** \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\`\n`;
	}
	if (msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `Exit code: ${msg.exitCode}\n`;
	}
	return `${text}\n`;
}

function formatCustomMessage(msg: CustomMessage): string {
	if (!msg.display) return "";
	const content =
		typeof msg.content === "string"
			? msg.content
			: msg.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n\n");
	return `**[${msg.customType}]** ${content.trim()}\n\n`;
}

function formatBranchSummary(msg: BranchSummaryMessage): string {
	return `## Branch Summary\n\n${msg.summary.trim()}\n\n---\n\n`;
}

function formatCompactionSummary(msg: CompactionSummaryMessage): string {
	return `## Compaction Summary\n\n${msg.summary.trim()}\n\n---\n\n`;
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

function formatMessage(msg: AgentMessage, options: TranscriptOptions): string {
	switch (msg.role) {
		case "user":
			return formatUserMessage(msg as Parameters<typeof formatUserMessage>[0]);
		case "assistant":
			return formatAssistantMessage(msg as AssistantMessage, options);
		case "toolResult":
			return formatToolResult(msg as ToolResultMessage, options);
		case "bashExecution":
			return formatBashExecution(msg as BashExecutionMessage);
		case "custom":
			return formatCustomMessage(msg as CustomMessage);
		case "branchSummary":
			return formatBranchSummary(msg as BranchSummaryMessage);
		case "compactionSummary":
			return formatCompactionSummary(msg as CompactionSummaryMessage);
		default:
			return "";
	}
}

/**
 * Format an array of agent messages into a markdown transcript string.
 */
export function formatTranscript(
	sessionId: string,
	sessionName: string | undefined,
	cwd: string,
	messages: AgentMessage[],
	options: TranscriptOptions = {},
): string {
	const title = sessionName ?? `Session ${sessionId}`;
	let transcript = `# ${title}\n\n`;
	transcript += `**Session ID:** ${sessionId}\n`;
	transcript += `**Working Directory:** ${cwd}\n`;
	transcript += `**Exported:** ${new Date().toLocaleString()}\n\n`;
	transcript += "---\n\n";

	for (const msg of messages) {
		transcript += formatMessage(msg, options);
	}

	return transcript;
}

/**
 * Export a session to a markdown transcript file.
 * Returns the resolved output file path.
 */
export function exportSessionToMarkdown(
	sessionManager: ReadonlySessionManager,
	messages: AgentMessage[],
	options: TranscriptOptions = {},
): string {
	const outputPath = options.outputPath ?? resolve(`session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
	const filePath = resolve(outputPath);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const content = formatTranscript(
		sessionManager.getSessionId(),
		sessionManager.getSessionName(),
		sessionManager.getCwd(),
		messages,
		options,
	);

	writeFileSync(filePath, content, "utf-8");
	return filePath;
}
