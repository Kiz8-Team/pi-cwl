import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseLoopCommand, resolveLoopPrompt } from "../src/core/loop.js";
import { SessionScheduler } from "../src/core/scheduler.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("loop helpers", () => {
	test("registers /loop as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "loop")).toBe(true);
	});

	test("parses fixed /loop intervals", () => {
		const parsed = parseLoopCommand("/loop 5m check deploy");
		expect(parsed.mode).toBe("fixed");
		expect(parsed.prompt).toBe("check deploy");
		expect(parsed.interval?.cron).toBe("*/5 * * * *");
	});

	test("parses dynamic /loop prompts", () => {
		const parsed = parseLoopCommand("/loop inspect CI and wait");
		expect(parsed.mode).toBe("dynamic");
		expect(parsed.prompt).toBe("inspect CI and wait");
	});

	test("loads project loop.md before user loop.md", () => {
		const cwd = makeTempDir();
		mkdirSync(path.join(cwd, ".claude"), { recursive: true });
		writeFileSync(path.join(cwd, ".claude", "loop.md"), "project loop prompt");

		const originalHome = process.env.HOME;
		const home = makeTempDir();
		mkdirSync(path.join(home, ".claude"), { recursive: true });
		writeFileSync(path.join(home, ".claude", "loop.md"), "user loop prompt");
		process.env.HOME = home;

		try {
			expect(resolveLoopPrompt(cwd)).toBe("project loop prompt");
		} finally {
			process.env.HOME = originalHome;
		}
	});
});

describe("session scheduler", () => {
	test("creates deterministic task ids and lists tasks", () => {
		const scheduler = new SessionScheduler({
			isIdle: () => false,
			dispatch: async () => {},
		});
		const task = scheduler.createCronTask({
			schedule: "*/5 * * * *",
			prompt: "check deploy",
			recur: true,
			source: "test",
		});

		expect(task.id).toMatch(/^[a-f0-9]{8}$/);
		expect(scheduler.listTasks()).toHaveLength(1);
		scheduler.dispose();
	});

	test("fixed loops can run immediately and remain scheduled", async () => {
		vi.useFakeTimers();
		const dispatched: string[] = [];
		let idle = true;
		let finishDispatch: (() => void) | undefined;
		const scheduler = new SessionScheduler({
			isIdle: () => idle,
			dispatch: async (task) => {
				dispatched.push(task.id);
				idle = false;
				await new Promise<void>((resolve) => {
					finishDispatch = () => {
						idle = true;
						resolve();
					};
				});
			},
		});

		try {
			const task = scheduler.createCronTask({
				schedule: "*/5 * * * *",
				prompt: "check deploy",
				recur: true,
				source: "test",
			});
			const scheduledNextRunAt = scheduler.getTask(task.id)?.nextRunAt;
			const run = scheduler.runTaskNow(task.id);
			await Promise.resolve();
			finishDispatch?.();
			await run;

			expect(dispatched).toEqual([task.id]);
			expect(scheduler.getTask(task.id)?.nextRunAt).toBe(scheduledNextRunAt);
		} finally {
			scheduler.dispose();
			vi.useRealTimers();
		}
	});

	test("dynamic loops re-arm through Sleep scheduling", async () => {
		vi.useFakeTimers();
		const dispatched: string[] = [];
		let idle = true;
		let finishDispatch: (() => void) | undefined;
		const scheduler = new SessionScheduler({
			isIdle: () => idle,
			dispatch: async (task) => {
				dispatched.push(task.id);
				idle = false;
				await new Promise<void>((resolve) => {
					finishDispatch = () => {
						idle = true;
						resolve();
					};
				});
			},
		});

		try {
			const task = scheduler.createDynamicLoop({ prompt: "check deploy", source: "test" });
			const run1 = scheduler.runDynamicLoopNow(task.id);
			await Promise.resolve();
			finishDispatch?.();
			await run1;
			expect(dispatched).toEqual([task.id]);
			expect(scheduler.getTask(task.id)).toBeUndefined();

			const task2 = scheduler.createDynamicLoop({ prompt: "check again", source: "test" });
			const run2 = scheduler.runDynamicLoopNow(task2.id);
			await Promise.resolve();
			const rearmed = scheduler.armDynamicLoop(task2.id, 5 * 60_000, "CI still running");
			finishDispatch?.();
			await run2;
			expect(rearmed.nextRunAt).toBeGreaterThan(Date.now());
			expect(scheduler.getTask(task2.id)?.nextRunAt).toBe(rearmed.nextRunAt);
		} finally {
			scheduler.dispose();
			vi.useRealTimers();
		}
	});
});
