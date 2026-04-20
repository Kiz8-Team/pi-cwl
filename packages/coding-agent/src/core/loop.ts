import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LOOP_PROMPT = `You are running in maintenance loop mode.

Priority order:
1. Continue any unfinished work already in this conversation.
2. Check the current branch and PR state for review comments, failed CI, or merge conflicts, and address those if they are part of the current work.
3. If nothing is pending, do a small cleanup or verification pass related to the current work.
4. Do not start unrelated new initiatives.
5. Only perform irreversible actions when they were already authorized earlier in this conversation.`;

const LOOP_PROMPT_MAX_BYTES = 25_000;

export interface ParsedDuration {
	input: string;
	normalized: string;
	milliseconds: number;
}

export interface LoopIntervalSpec {
	duration: ParsedDuration;
	cron: string;
	display: string;
	normalizationNote?: string;
}

export interface ParsedLoopCommand {
	mode: "default" | "dynamic" | "fixed";
	prompt?: string;
	interval?: LoopIntervalSpec;
}

const DURATION_UNITS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

function formatDuration(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes % (24 * 60) === 0) {
		const days = minutes / (24 * 60);
		return `${days}d`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours}h`;
	}
	return `${minutes}m`;
}

export function parseHumanDuration(input: string): ParsedDuration | undefined {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) {
		return undefined;
	}

	const compact = trimmed.match(/^(\d+)\s*([a-z]+)$/i);
	if (compact) {
		const value = Number(compact[1]);
		const unit = DURATION_UNITS[compact[2]];
		if (!Number.isFinite(value) || value <= 0 || unit === undefined) {
			return undefined;
		}
		const milliseconds = value * unit;
		return {
			input,
			normalized: `${value}${compact[2].toLowerCase()}`,
			milliseconds,
		};
	}

	const spaced = trimmed.match(/^every\s+(\d+)\s+([a-z]+)$/i) ?? trimmed.match(/^(\d+)\s+([a-z]+)$/i);
	if (!spaced) {
		return undefined;
	}

	const value = Number(spaced[1]);
	const unitKey = spaced[2].toLowerCase();
	const unit = DURATION_UNITS[unitKey];
	if (!Number.isFinite(value) || value <= 0 || unit === undefined) {
		return undefined;
	}

	return {
		input,
		normalized: `${value}${unitKey}`,
		milliseconds: value * unit,
	};
}

export function normalizeLoopInterval(duration: ParsedDuration): LoopIntervalSpec {
	let normalizedMs = duration.milliseconds;
	let normalizationNote: string | undefined;

	if (normalizedMs < 60_000) {
		normalizedMs = 60_000;
		normalizationNote = `Rounded ${duration.input.trim()} up to 1m for recurring scheduling.`;
	}

	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	let cron: string;
	let display: string;

	if (normalizedMs <= hour) {
		const minutes = Math.max(1, Math.round(normalizedMs / minute));
		cron = minutes === 60 ? "0 * * * *" : `*/${minutes} * * * *`;
		display = minutes === 60 ? "every 1h" : `every ${minutes}m`;
		if (minutes * minute !== normalizedMs) {
			normalizationNote = `Rounded ${duration.input.trim()} to ${minutes}m for recurring scheduling.`;
		}
	} else if (normalizedMs <= day) {
		const hours = Math.max(1, Math.round(normalizedMs / hour));
		cron = hours === 24 ? "0 0 * * *" : `0 */${hours} * * *`;
		display = hours === 24 ? "every 1d" : `every ${hours}h`;
		if (hours * hour !== normalizedMs) {
			normalizationNote = `Rounded ${duration.input.trim()} to ${hours}h for recurring scheduling.`;
		}
	} else {
		const days = Math.max(1, Math.round(normalizedMs / day));
		cron = days === 1 ? "0 0 * * *" : `0 0 */${days} * *`;
		display = `every ${days}d`;
		if (days * day !== normalizedMs) {
			normalizationNote = `Rounded ${duration.input.trim()} to ${days}d for recurring scheduling.`;
		}
	}

	return {
		duration: {
			...duration,
			milliseconds: normalizedMs,
			normalized: formatDuration(normalizedMs),
		},
		cron,
		display,
		normalizationNote,
	};
}

export function parseLoopCommand(text: string): ParsedLoopCommand {
	const args = text.replace(/^\/loop\b/, "").trim();
	if (!args) {
		return { mode: "default" };
	}

	const everyIndex = args.toLowerCase().lastIndexOf(" every ");
	if (everyIndex > 0) {
		const maybePrompt = args.slice(0, everyIndex).trim();
		const maybeDuration = parseHumanDuration(args.slice(everyIndex + 1).trim());
		if (maybePrompt && maybeDuration) {
			return {
				mode: "fixed",
				prompt: maybePrompt,
				interval: normalizeLoopInterval(maybeDuration),
			};
		}
	}

	const firstSpace = args.indexOf(" ");
	const firstToken = firstSpace === -1 ? args : args.slice(0, firstSpace);
	const duration = parseHumanDuration(firstToken);
	if (duration) {
		const prompt = firstSpace === -1 ? undefined : args.slice(firstSpace + 1).trim() || undefined;
		return {
			mode: "fixed",
			prompt,
			interval: normalizeLoopInterval(duration),
		};
	}

	return { mode: "dynamic", prompt: args };
}

export function resolveLoopPrompt(cwd: string, explicitPrompt?: string): string {
	if (explicitPrompt && explicitPrompt.trim().length > 0) {
		return explicitPrompt.trim();
	}

	const candidates = [path.join(cwd, ".claude", "loop.md"), path.join(os.homedir(), ".claude", "loop.md")];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) {
			continue;
		}
		const content = readFileSync(candidate);
		const truncated = content.subarray(0, LOOP_PROMPT_MAX_BYTES).toString("utf-8").trim();
		if (truncated.length > 0) {
			return truncated;
		}
	}

	return DEFAULT_LOOP_PROMPT;
}
