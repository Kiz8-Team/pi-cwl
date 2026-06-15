/**
 * Runtime cache for OpenRouter models.
 *
 * Fetches the live model catalogue from https://openrouter.ai/api/v1/models,
 * transforms the response into Model<Api> objects using the same field mapping
 * as packages/ai/scripts/generate-models.ts, and persists them as JSON to
 * ~/.claude/agent/openrouter-models-cache.json.
 *
 * All I/O and network errors are caught and surfaced as console.warn — nothing
 * in this module ever throws.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getOpenRouterCachePath } from "../config.js";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CachedOpenRouterModels {
	models: Model<Api>[];
	fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

/**
 * Read the on-disk cache. Returns null when the file is missing, unreadable,
 * or does not match the expected shape.
 */
export function readCache(): CachedOpenRouterModels | null {
	const path = getOpenRouterCachePath();
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isValidCache(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isValidCache(value: unknown): value is CachedOpenRouterModels {
	if (!value || typeof value !== "object") return false;
	const c = value as Record<string, unknown>;
	return typeof c.fetchedAt === "number" && Array.isArray(c.models);
}

/**
 * Persist models to disk with the current timestamp.
 * Creates parent directories if needed.
 */
export function writeCache(models: Model<Api>[]): void {
	const path = getOpenRouterCachePath();
	mkdirSync(dirname(path), { recursive: true });
	const payload: CachedOpenRouterModels = { models, fetchedAt: Date.now() };
	writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** Returns true when the cache is older than CACHE_TTL_MS. */
export function isCacheStale(cache: CachedOpenRouterModels): boolean {
	return Date.now() - cache.fetchedAt > CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// API fetch + transform
// ---------------------------------------------------------------------------

interface OpenRouterApiModel {
	id: string;
	name?: string;
	context_length?: number;
	supported_parameters?: string[];
	architecture?: {
		modality?: string;
	};
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
	top_provider?: {
		max_completion_tokens?: number | null;
	};
}

/**
 * Transform a raw OpenRouter API model object into a Model<Api> value.
 * Exported as a pure function so it can be unit-tested without network I/O.
 */
export function transformOpenRouterModel(raw: OpenRouterApiModel): Model<Api> {
	const input: ("text" | "image")[] = ["text"];
	if (raw.architecture?.modality?.includes("image")) {
		input.push("image");
	}

	const toMillionTokenRate = (v: string | number | undefined): number => parseFloat(String(v ?? "0")) * 1_000_000;

	return {
		id: raw.id,
		name: raw.name ?? raw.id,
		api: "openai-completions" as Api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: raw.supported_parameters?.includes("reasoning") ?? false,
		input,
		cost: {
			input: toMillionTokenRate(raw.pricing?.prompt),
			output: toMillionTokenRate(raw.pricing?.completion),
			cacheRead: toMillionTokenRate(raw.pricing?.input_cache_read),
			cacheWrite: toMillionTokenRate(raw.pricing?.input_cache_write),
		},
		contextWindow: raw.context_length ?? 4096,
		maxTokens: raw.top_provider?.max_completion_tokens ?? 4096,
	} as Model<Api>;
}

/**
 * Fetch the live OpenRouter model list and return it as Model<Api>[].
 * Only tool-capable models are included (those listing "tools" in supported_parameters).
 * Throws on HTTP error or JSON parse failure.
 */
export async function fetchOpenRouterModels(apiKey: string): Promise<Model<Api>[]> {
	const response = await fetch("https://openrouter.ai/api/v1/models", {
		headers: { Authorization: `Bearer ${apiKey}` },
	});

	if (!response.ok) {
		throw new Error(`OpenRouter API returned ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as { data?: OpenRouterApiModel[] };
	const rawModels = data.data ?? [];

	return rawModels.filter((m) => m.supported_parameters?.includes("tools")).map(transformOpenRouterModel);
}

// ---------------------------------------------------------------------------
// High-level refresh (never throws)
// ---------------------------------------------------------------------------

/**
 * Fetch fresh models, write the cache, and return.
 * All errors are caught and logged; this function never throws.
 */
export async function refreshOpenRouterCache(apiKey: string): Promise<void> {
	try {
		const models = await fetchOpenRouterModels(apiKey);
		writeCache(models);
	} catch (error) {
		console.warn("[openrouter-cache] Failed to refresh model cache:", error instanceof Error ? error.message : error);
	}
}
