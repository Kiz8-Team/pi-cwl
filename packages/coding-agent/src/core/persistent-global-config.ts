import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { getPersistentConfigPath } from "../config.js";
import type { CwlLimit } from "./context-filter.js";

export type CwlTokenMeasurementMode = "exact" | "fast";

export interface PersistentGlobalConfig {
	debugModeEnabled?: boolean;
	cwlEnabled?: boolean;
	cwlLimit?: CwlLimit | null;
	cwlTokenMeasurementMode?: CwlTokenMeasurementMode;
}

function isCwlLimit(value: unknown): value is CwlLimit {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as { type?: unknown; value?: unknown };
	return (
		(candidate.type === "percent" || candidate.type === "tokens") &&
		typeof candidate.value === "number" &&
		Number.isFinite(candidate.value) &&
		candidate.value > 0
	);
}

function sanitizePersistentGlobalConfig(value: unknown): PersistentGlobalConfig {
	if (!value || typeof value !== "object") {
		return {};
	}

	const candidate = value as {
		debugModeEnabled?: unknown;
		cwlEnabled?: unknown;
		cwlLimit?: unknown;
		cwlTokenMeasurementMode?: unknown;
	};
	const config: PersistentGlobalConfig = {};

	if (typeof candidate.debugModeEnabled === "boolean") {
		config.debugModeEnabled = candidate.debugModeEnabled;
	}

	if (typeof candidate.cwlEnabled === "boolean") {
		config.cwlEnabled = candidate.cwlEnabled;
	}

	if (candidate.cwlLimit === null) {
		config.cwlLimit = null;
	} else if (isCwlLimit(candidate.cwlLimit)) {
		config.cwlLimit = candidate.cwlLimit;
	}

	if (candidate.cwlTokenMeasurementMode === "exact" || candidate.cwlTokenMeasurementMode === "fast") {
		config.cwlTokenMeasurementMode = candidate.cwlTokenMeasurementMode;
	}

	return config;
}

function acquireLockSyncWithRetry(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing callers to async.
			}
		}
	}

	throw (lastError as Error) ?? new Error("Failed to acquire persistent config lock");
}

export function loadPersistentGlobalConfig(configPath: string = getPersistentConfigPath()): PersistentGlobalConfig {
	try {
		if (!existsSync(configPath)) {
			return {};
		}
		return sanitizePersistentGlobalConfig(JSON.parse(readFileSync(configPath, "utf-8")));
	} catch {
		return {};
	}
}

export function updatePersistentGlobalConfig(
	patch: Partial<PersistentGlobalConfig>,
	configPath: string = getPersistentConfigPath(),
): PersistentGlobalConfig {
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	let release: (() => void) | undefined;
	try {
		release = acquireLockSyncWithRetry(configPath);
		const current = loadPersistentGlobalConfig(configPath);
		const next = sanitizePersistentGlobalConfig({ ...current, ...patch });
		writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
		return next;
	} finally {
		release?.();
	}
}
