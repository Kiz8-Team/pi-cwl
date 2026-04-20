/**
 * System prompt construction and project context loading.
 */

import { formatSkillsForPrompt, type Skill } from "../core/skills.js";
import { getPromptModeAppend } from "./modes.js";
import type { AgentPromptMode } from "./types.js";

export interface PromptSubagentInfo {
	name: string;
	description: string;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write, grep, find, glob, ls, delimiter] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Prompt mode. Default: "default". */
	promptMode?: AgentPromptMode;
	/** Available subagents the assistant may delegate to when useful for the current request. */
	subagents?: PromptSubagentInfo[];
	/** Git status summary injected into the system prompt (branch, status, recent commits). */
	gitStatus?: string;
}

function appendProjectContext(
	prompt: string,
	contextFiles: Array<{ path: string; content: string }>,
	skills: Skill[],
	hasRead: boolean,
): string {
	let result = prompt;

	if (contextFiles.length > 0) {
		result += "\n\n# Project Context\n\n";
		result += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			result += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) {
		result += formatSkillsForPrompt(skills);
	}

	return result;
}

function appendSubagentContext(prompt: string, subagents: PromptSubagentInfo[]): string {
	if (subagents.length === 0) {
		return prompt;
	}

	const lines = subagents.map((subagent) => `- ${subagent.name}: ${subagent.description}`);
	return (
		prompt +
		"\n\n# Available Subagents\n\n" +
		"You may call subagents when useful for the current request. Main-agent chunking rules apply only to the main agent: do not start, end, or manage delimiter chunks just for a subagent call, and subagents may be invoked whether the main agent is currently outside a chunk, inside an exploration chunk, or inside an action chunk.\n\n" +
		`${lines.join("\n")}`
	);
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		promptMode = "default",
		subagents = [],
		gitStatus,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const promptModeAppend = getPromptModeAppend(promptMode);
	const appendedSections = [appendSystemPrompt, promptModeAppend].filter(
		(section) => section && section.trim().length > 0,
	);
	const appendSection = appendedSections.length > 0 ? `\n\n${appendedSections.join("\n\n")}` : "";

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		prompt = appendProjectContext(prompt, contextFiles, skills, customPromptHasRead);
		prompt = appendSubagentContext(prompt, subagents);

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		if (gitStatus) {
			prompt += `\n\n# Git Status\n\n${gitStatus}`;
		}

		return prompt;
	}

	const tools = selectedTools || ["read", "bash", "edit", "write", "grep", "find", "glob", "ls", "delimiter"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasGlob = tools.includes("glob");
	const hasRead = tools.includes("read");
	const hasDelimiter = tools.includes("delimiter");

	if (hasBash && !hasGrep && !hasFind && !hasGlob && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasGlob || hasLs)) {
		addGuideline("Prefer grep/find/glob/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	if (hasRead) {
		addGuideline(
			"Keep reads targeted and minimal: prefer reading specific files, sections, or ranges over pulling in unnecessary content.",
		);
		addGuideline(
			"Before using read, first narrow the search space with grep/find/glob/ls or other structure-discovery tools whenever possible.",
		);
		addGuideline(
			"Stop exploring immediately once you have enough context to make the next edit or answer the user's request.",
		);
		addGuideline(
			"Do not keep reading additional files or broader context once the relevant implementation area is identified and understood.",
		);
	}

	if (hasDelimiter) {
		addGuideline(
			"Use the delimiter tool to structure your work into named chunks before starting any non-trivial task.",
		);
		addGuideline(
			"Use delimiter exploration chunks only for codebase exploration: locating files, reading relevant code, understanding project structure, and identifying the areas that may need changes.",
		);
		addGuideline(
			"Do not put change-specific reasoning or implementation planning in exploration chunks. Once you have enough codebase context, end the exploration chunk.",
		);
		addGuideline(
			"If an existing exploration chunk already contains the needed context, or likely most of the context needed, prefer starting an action chunk immediately and link it to that exploration chunk instead of opening another exploration chunk.",
		);
		addGuideline(
			"Small file re-reads and small amounts of additional context gathering are fine inside an action chunk when the action still gets most of its context from its dependency exploration chunk or chunks.",
		);
		addGuideline(
			"Start a delimiter action chunk before reasoning through the requested change, deciding what to edit, making edits, and validating them. Task-specific reasoning and planning belong in the action chunk.",
		);
		addGuideline(
			"If you need substantially more codebase context while implementing, end the action chunk, open a new exploration chunk for that investigation, then return to a new action chunk.",
		);
		addGuideline(
			"When ending an exploration chunk, include a short 1-2 sentence `description` summarizing the information gathered in that chunk.",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	addGuideline("Be concise in your responses");
	addGuideline(
		"Write the main body of your user-facing responses in natural prose paragraphs. Use bullet points or lists only when they genuinely improve clarity, and do not default to list-heavy answers.",
	);
	addGuideline("Show file paths clearly when working with files");
	addGuideline(
		"When summarizing completed code changes, describe them naturally with references to the relevant code, and explain the logic or algorithm behind new behavior instead of giving only a file-by-file changelog or calling them purely code changes.",
	);

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

	if (appendSection) {
		prompt += appendSection;
	}

	prompt = appendProjectContext(prompt, contextFiles, skills, hasRead);
	prompt = appendSubagentContext(prompt, subagents);

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	if (gitStatus) {
		prompt += `\n\n# Git Status\n\n${gitStatus}`;
	}

	return prompt;
}
