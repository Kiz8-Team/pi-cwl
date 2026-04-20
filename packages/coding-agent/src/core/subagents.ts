import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

export const SUBAGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export type SubagentColor = (typeof SUBAGENT_COLORS)[number];

export const SUBAGENT_TOOLS = ["Read", "Bash", "Edit", "Write", "Grep", "Find", "Ls", "Delimiter", "Subagent"] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOLS)[number];

interface SubagentFrontmatter {
	name?: string;
	description?: string;
	tools?: string[] | string;
	color?: string;
	[key: string]: unknown;
}

export interface SubagentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: SubagentToolName[];
	color?: SubagentColor;
	filePath: string;
	sourceInfo: SourceInfo;
}

function parseTools(
	value: string[] | string | undefined,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SubagentToolName[] | undefined {
	if (value === undefined) {
		return undefined;
	}

	const rawItems = Array.isArray(value)
		? value.map((item) => String(item).trim())
		: value
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0);

	if (rawItems.length === 0) {
		return undefined;
	}

	const valid = new Set<SubagentToolName>();
	for (const item of rawItems) {
		if ((SUBAGENT_TOOLS as readonly string[]).includes(item)) {
			valid.add(item as SubagentToolName);
		} else {
			diagnostics.push({
				type: "warning",
				message: `Unknown subagent tool "${item}". Allowed tools: ${SUBAGENT_TOOLS.join(", ")}`,
				path: filePath,
			});
		}
	}

	return valid.size > 0 ? Array.from(valid) : undefined;
}

function parseColor(
	value: string | undefined,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SubagentColor | undefined {
	if (value === undefined) {
		return undefined;
	}

	if ((SUBAGENT_COLORS as readonly string[]).includes(value)) {
		return value as SubagentColor;
	}

	diagnostics.push({
		type: "warning",
		message: `Unknown subagent color "${value}". Allowed colors: ${SUBAGENT_COLORS.join(", ")}`,
		path: filePath,
	});
	return undefined;
}

function loadSubagentFromFile(
	filePath: string,
	scope: "user" | "project",
): { subagent: SubagentDefinition | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const raw = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<SubagentFrontmatter>(raw);
		const fileName = basename(filePath, ".md");
		const configuredName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
		if (configuredName && configuredName !== fileName) {
			diagnostics.push({
				type: "warning",
				message: `Frontmatter name "${configuredName}" does not match filename "${fileName}". Using filename.`,
				path: filePath,
			});
		}

		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!description) {
			diagnostics.push({
				type: "warning",
				message: "Subagent description is required",
				path: filePath,
			});
			return { subagent: null, diagnostics };
		}

		const prompt = body.trim();
		if (!prompt) {
			diagnostics.push({
				type: "warning",
				message: "Subagent prompt body is required",
				path: filePath,
			});
			return { subagent: null, diagnostics };
		}

		const tools = parseTools(frontmatter.tools, filePath, diagnostics);
		const color = parseColor(
			typeof frontmatter.color === "string" ? frontmatter.color.trim() : undefined,
			filePath,
			diagnostics,
		);

		return {
			subagent: {
				name: fileName,
				description,
				prompt,
				tools,
				color,
				filePath,
				sourceInfo: createSyntheticSourceInfo(filePath, {
					source: "local",
					scope,
					baseDir: resolve(filePath, ".."),
				}),
			},
			diagnostics,
		};
	} catch (error) {
		return {
			subagent: null,
			diagnostics: [
				{
					type: "warning",
					message: error instanceof Error ? error.message : "failed to parse subagent file",
					path: filePath,
				},
			],
		};
	}
}

function loadSubagentsFromDir(
	dir: string,
	scope: "user" | "project",
): { subagents: SubagentDefinition[]; diagnostics: ResourceDiagnostic[] } {
	const subagents: SubagentDefinition[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { subagents, diagnostics };
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile || !entry.name.endsWith(".md")) {
				continue;
			}
			const result = loadSubagentFromFile(fullPath, scope);
			diagnostics.push(...result.diagnostics);
			if (result.subagent) {
				subagents.push(result.subagent);
			}
		}
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: error instanceof Error ? error.message : "failed to read subagents directory",
			path: dir,
		});
	}

	return { subagents, diagnostics };
}

export function loadSubagents(options: { cwd?: string } = {}): {
	subagents: SubagentDefinition[];
	diagnostics: ResourceDiagnostic[];
} {
	const cwd = options.cwd ?? process.cwd();
	const userDir = join(homedir(), CONFIG_DIR_NAME, "agents");
	const projectDir = join(resolve(cwd), CONFIG_DIR_NAME, "agents");

	const user = loadSubagentsFromDir(userDir, "user");
	const project = loadSubagentsFromDir(projectDir, "project");
	const diagnostics = [...user.diagnostics, ...project.diagnostics];
	const byName = new Map<string, SubagentDefinition>();

	for (const subagent of user.subagents) {
		byName.set(subagent.name, subagent);
	}
	for (const subagent of project.subagents) {
		const existing = byName.get(subagent.name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "${subagent.name}" collision`,
				path: subagent.filePath,
				collision: {
					resourceType: "skill",
					name: subagent.name,
					winnerPath: subagent.filePath,
					loserPath: existing.filePath,
				},
			});
		}
		byName.set(subagent.name, subagent);
	}

	return {
		subagents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics,
	};
}
