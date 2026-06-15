/**
 * Unit tests for openrouter-model-cache.ts
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// We need to control the cache file path. The module reads it from
// getOpenRouterCachePath() in config.ts. We mock that module so the cache
// writes to a temp directory instead of ~/.claude/agent/.
// ---------------------------------------------------------------------------

let tempDir: string;
let cachePath: string;

vi.mock("../src/config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/config.js")>();
	return {
		...original,
		getOpenRouterCachePath: () => cachePath,
	};
});

// Import *after* the mock is set up so the module uses the mocked path.
const {
	CACHE_TTL_MS,
	readCache,
	writeCache,
	isCacheStale,
	fetchOpenRouterModels,
	refreshOpenRouterCache,
	transformOpenRouterModel,
} = await import("../src/core/openrouter-model-cache.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(id = "acme/test-model"): Model<Api> {
	return {
		id,
		name: "Test Model",
		api: "openai-completions" as Api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

function writeCacheFile(content: unknown): void {
	mkdirSync(join(tempDir, "agent"), { recursive: true });
	writeFileSync(cachePath, JSON.stringify(content), "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-or-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	cachePath = join(tempDir, "agent", "openrouter-models-cache.json");
});

afterEach(() => {
	vi.restoreAllMocks();
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// readCache()
// ---------------------------------------------------------------------------

describe("readCache()", () => {
	test("returns null when the file does not exist", () => {
		expect(readCache()).toBeNull();
	});

	test("returns null when the file contains invalid JSON", () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		writeFileSync(cachePath, "{ not valid json }", "utf-8");
		expect(readCache()).toBeNull();
	});

	test("returns null when the file is valid JSON but structurally invalid", () => {
		writeCacheFile({ wrong: "shape" });
		expect(readCache()).toBeNull();
	});

	test("returns null when fetchedAt is missing", () => {
		writeCacheFile({ models: [] });
		expect(readCache()).toBeNull();
	});

	test("returns a valid CachedOpenRouterModels when the file is well-formed", () => {
		const model = makeModel();
		writeCacheFile({ models: [model], fetchedAt: 12345 });
		const result = readCache();
		expect(result).not.toBeNull();
		expect(result!.fetchedAt).toBe(12345);
		expect(result!.models).toHaveLength(1);
		expect(result!.models[0].id).toBe("acme/test-model");
	});
});

// ---------------------------------------------------------------------------
// isCacheStale()
// ---------------------------------------------------------------------------

describe("isCacheStale()", () => {
	test("returns true when fetchedAt is beyond CACHE_TTL_MS", () => {
		const stale = { models: [], fetchedAt: Date.now() - CACHE_TTL_MS - 1 };
		expect(isCacheStale(stale)).toBe(true);
	});

	test("returns false for a fresh fetchedAt", () => {
		const fresh = { models: [], fetchedAt: Date.now() - 60_000 }; // 1 min ago
		expect(isCacheStale(fresh)).toBe(false);
	});

	test("returns false exactly at TTL boundary", () => {
		// fetchedAt exactly at CACHE_TTL_MS in the past is NOT yet stale (>)
		const boundary = { models: [], fetchedAt: Date.now() - CACHE_TTL_MS };
		expect(isCacheStale(boundary)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeCache() round-trip
// ---------------------------------------------------------------------------

describe("writeCache()", () => {
	test("persists models that readCache() can read back", () => {
		const model = makeModel("x/round-trip");
		writeCache([model]);
		const result = readCache();
		expect(result).not.toBeNull();
		expect(result!.models).toHaveLength(1);
		expect(result!.models[0].id).toBe("x/round-trip");
		expect(result!.fetchedAt).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// transformOpenRouterModel() (pure function)
// ---------------------------------------------------------------------------

describe("transformOpenRouterModel()", () => {
	const rawTool = {
		id: "vendor/cool-model",
		name: "Cool Model",
		context_length: 200000,
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text+image->text" },
		pricing: {
			prompt: "0.000001", // $0.000001/token = $1/M
			completion: "0.000002", // $2/M
			input_cache_read: "0.0000005",
			input_cache_write: "0.000003",
		},
		top_provider: { max_completion_tokens: 8192 },
	};

	test("sets provider to 'openrouter' and api to 'openai-completions'", () => {
		const m = transformOpenRouterModel(rawTool);
		expect(m.provider).toBe("openrouter");
		expect(m.api).toBe("openai-completions");
	});

	test("sets baseUrl to the OpenRouter endpoint", () => {
		const m = transformOpenRouterModel(rawTool);
		expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	test("maps reasoning from supported_parameters", () => {
		expect(transformOpenRouterModel(rawTool).reasoning).toBe(true);
		const noReasoning = { ...rawTool, supported_parameters: ["tools"] };
		expect(transformOpenRouterModel(noReasoning).reasoning).toBe(false);
	});

	test("includes image in input when modality mentions image", () => {
		const m = transformOpenRouterModel(rawTool);
		expect(m.input).toContain("image");
	});

	test("does NOT include image when modality is text-only", () => {
		const textOnly = { ...rawTool, architecture: { modality: "text->text" } };
		expect(transformOpenRouterModel(textOnly).input).not.toContain("image");
	});

	test("converts pricing from $/token to $/million tokens", () => {
		const m = transformOpenRouterModel(rawTool);
		expect(m.cost.input).toBeCloseTo(1); // $1/M
		expect(m.cost.output).toBeCloseTo(2); // $2/M
		expect(m.cost.cacheRead).toBeCloseTo(0.5);
		expect(m.cost.cacheWrite).toBeCloseTo(3);
	});

	test("uses context_length and max_completion_tokens", () => {
		const m = transformOpenRouterModel(rawTool);
		expect(m.contextWindow).toBe(200000);
		expect(m.maxTokens).toBe(8192);
	});

	test("falls back to 4096 when context_length/maxTokens are absent", () => {
		const minimal = { id: "a/b", supported_parameters: ["tools"] };
		const m = transformOpenRouterModel(minimal);
		expect(m.contextWindow).toBe(4096);
		expect(m.maxTokens).toBe(4096);
	});
});

// ---------------------------------------------------------------------------
// fetchOpenRouterModels() — filters non-tool models
// ---------------------------------------------------------------------------

describe("fetchOpenRouterModels()", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockFetch(data: unknown[]): void {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ data }),
			}),
		);
	}

	const toolModel = {
		id: "p/tool-model",
		name: "Tool Model",
		supported_parameters: ["tools"],
		context_length: 32000,
		pricing: { prompt: "0.000001", completion: "0.000002" },
	};
	const noToolModel = {
		id: "p/no-tool-model",
		name: "No Tool Model",
		supported_parameters: ["functions"],
		context_length: 32000,
	};

	test("filters out models that do not list 'tools' in supported_parameters", async () => {
		mockFetch([toolModel, noToolModel]);
		const models = await fetchOpenRouterModels("test-key");
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("p/tool-model");
	});

	test("throws on non-OK HTTP response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));
		await expect(fetchOpenRouterModels("bad-key")).rejects.toThrow("401");
	});

	test("passes Authorization header", async () => {
		const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
		vi.stubGlobal("fetch", spy);
		await fetchOpenRouterModels("my-secret-key");
		expect(spy).toHaveBeenCalledWith(
			"https://openrouter.ai/api/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer my-secret-key" }) }),
		);
	});
});

// ---------------------------------------------------------------------------
// refreshOpenRouterCache() — swallows errors
// ---------------------------------------------------------------------------

describe("refreshOpenRouterCache()", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("does not throw when fetch fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
		await expect(refreshOpenRouterCache("key")).resolves.toBeUndefined();
	});

	test("does not throw when fetch returns non-OK status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));
		await expect(refreshOpenRouterCache("key")).resolves.toBeUndefined();
	});

	test("writes cache when fetch succeeds", async () => {
		const model = {
			id: "a/model",
			supported_parameters: ["tools"],
			context_length: 8000,
			pricing: { prompt: "0.000001", completion: "0.000002" },
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [model] }) }));
		await refreshOpenRouterCache("good-key");
		const cache = readCache();
		expect(cache).not.toBeNull();
		expect(cache!.models).toHaveLength(1);
		expect(cache!.models[0].id).toBe("a/model");
	});
});
