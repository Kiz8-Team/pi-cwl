import crypto from "node:crypto";
import { Cron } from "croner";

const MAX_TASKS = 50;
const RECURRING_TASK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export type ScheduledTaskKind = "cron-recurring" | "cron-once" | "loop-dynamic";

export interface ScheduledTask {
	id: string;
	kind: ScheduledTaskKind;
	prompt: string;
	createdAt: number;
	expiresAt?: number;
	nextRunAt?: number;
	schedule?: string;
	recur: boolean;
	source: string;
	label: string;
	pending: boolean;
	lastReason?: string;
}

interface MutableScheduledTask extends ScheduledTask {
	awaitingSleep?: boolean;
	deleteAfterDispatch?: boolean;
}

export interface CreateCronTaskOptions {
	schedule: string;
	prompt: string;
	recur: boolean;
	source: string;
	label?: string;
}

export interface CreateDynamicLoopOptions {
	prompt: string;
	source: string;
	label?: string;
}

export interface SessionSchedulerCallbacks {
	isIdle: () => boolean;
	dispatch: (task: ScheduledTask) => Promise<void>;
}

export class SessionScheduler {
	private readonly tasks = new Map<string, MutableScheduledTask>();
	private timer: NodeJS.Timeout | undefined;
	private dispatchingTaskId: string | undefined;

	constructor(private readonly callbacks: SessionSchedulerCallbacks) {}

	createCronTask(options: CreateCronTaskOptions): ScheduledTask {
		this.ensureCapacity();
		const now = Date.now();
		const cron = new Cron(options.schedule, { paused: true, legacyMode: false });
		const nextRun = cron.nextRun();
		if (!nextRun) {
			throw new Error(`Schedule never runs: ${options.schedule}`);
		}

		const task: MutableScheduledTask = {
			id: this.generateTaskId(),
			kind: options.recur ? "cron-recurring" : "cron-once",
			prompt: options.prompt,
			createdAt: now,
			expiresAt: options.recur ? now + RECURRING_TASK_LIFETIME_MS : undefined,
			nextRunAt: nextRun.getTime(),
			schedule: options.schedule,
			recur: options.recur,
			source: options.source,
			label: options.label ?? this.summarizePrompt(options.prompt),
			pending: false,
		};
		this.tasks.set(task.id, task);
		this.scheduleNextTimer();
		return this.cloneTask(task);
	}

	createDynamicLoop(options: CreateDynamicLoopOptions): ScheduledTask {
		this.ensureCapacity();
		const now = Date.now();
		const task: MutableScheduledTask = {
			id: this.generateTaskId(),
			kind: "loop-dynamic",
			prompt: options.prompt,
			createdAt: now,
			expiresAt: now + RECURRING_TASK_LIFETIME_MS,
			recur: true,
			source: options.source,
			label: options.label ?? this.summarizePrompt(options.prompt),
			pending: false,
		};
		this.tasks.set(task.id, task);
		return this.cloneTask(task);
	}

	armDynamicLoop(taskId: string, delayMs: number, reason?: string): ScheduledTask {
		const task = this.tasks.get(taskId);
		if (!task || task.kind !== "loop-dynamic") {
			throw new Error(`Dynamic loop not found: ${taskId}`);
		}
		const dueAt = Date.now() + delayMs;
		task.nextRunAt = dueAt;
		task.pending = false;
		task.awaitingSleep = false;
		task.lastReason = reason?.trim() || undefined;
		this.scheduleNextTimer();
		return this.cloneTask(task);
	}

	getTask(taskId: string): ScheduledTask | undefined {
		const task = this.tasks.get(taskId);
		return task ? this.cloneTask(task) : undefined;
	}

	listTasks(): ScheduledTask[] {
		return Array.from(this.tasks.values())
			.sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
			.map((task) => this.cloneTask(task));
	}

	deleteTask(taskId: string): boolean {
		const deleted = this.tasks.delete(taskId);
		if (deleted) {
			if (this.dispatchingTaskId === taskId) {
				this.dispatchingTaskId = undefined;
			}
			this.scheduleNextTimer();
		}
		return deleted;
	}

	async runTaskNow(taskId: string): Promise<void> {
		const task = this.tasks.get(taskId);
		if (!task) {
			throw new Error(`Scheduled task not found: ${taskId}`);
		}
		if (task.kind === "loop-dynamic") {
			task.awaitingSleep = true;
		}
		if (this.dispatchingTaskId) {
			task.pending = true;
			return;
		}
		await this.dispatchTask(task);
	}

	async runDynamicLoopNow(taskId: string): Promise<void> {
		const task = this.tasks.get(taskId);
		if (!task || task.kind !== "loop-dynamic") {
			throw new Error(`Dynamic loop not found: ${taskId}`);
		}
		await this.runTaskNow(taskId);
	}

	async flushPending(): Promise<void> {
		if (this.dispatchingTaskId || !this.callbacks.isIdle()) {
			return;
		}

		this.processDueTasks(Date.now());
		const nextPending = Array.from(this.tasks.values())
			.filter((task) => task.pending)
			.sort((a, b) => (a.nextRunAt ?? a.createdAt) - (b.nextRunAt ?? b.createdAt))[0];
		if (!nextPending) {
			this.scheduleNextTimer();
			return;
		}

		nextPending.pending = false;
		await this.dispatchTask(nextPending);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.tasks.clear();
		this.dispatchingTaskId = undefined;
	}

	private ensureCapacity(): void {
		if (this.tasks.size >= MAX_TASKS) {
			throw new Error(`Scheduler limit reached (${MAX_TASKS} tasks). Delete an existing task first.`);
		}
	}

	private cloneTask(task: MutableScheduledTask): ScheduledTask {
		return {
			id: task.id,
			kind: task.kind,
			prompt: task.prompt,
			createdAt: task.createdAt,
			expiresAt: task.expiresAt,
			nextRunAt: task.nextRunAt,
			schedule: task.schedule,
			recur: task.recur,
			source: task.source,
			label: task.label,
			pending: task.pending,
			lastReason: task.lastReason,
		};
	}

	private generateTaskId(): string {
		let id = "";
		do {
			id = crypto.randomBytes(4).toString("hex");
		} while (this.tasks.has(id));
		return id;
	}

	private summarizePrompt(prompt: string): string {
		return prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "scheduled task";
	}

	private scheduleNextTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.dispatchingTaskId) {
			return;
		}
		const nextRunAt = Array.from(this.tasks.values())
			.map((task) => task.nextRunAt)
			.filter((value): value is number => typeof value === "number")
			.sort((a, b) => a - b)[0];
		if (nextRunAt === undefined) {
			return;
		}
		const delay = Math.max(0, nextRunAt - Date.now());
		this.timer = setTimeout(() => {
			void this.flushPending();
		}, delay);
		this.timer.unref?.();
	}

	private processDueTasks(now: number): void {
		for (const task of this.tasks.values()) {
			if (task.nextRunAt === undefined || task.nextRunAt > now) {
				continue;
			}

			if (task.kind === "cron-once") {
				task.pending = true;
				task.nextRunAt = undefined;
				task.deleteAfterDispatch = true;
				continue;
			}

			if (task.kind === "cron-recurring") {
				task.pending = true;
				const nextRun = new Cron(task.schedule!, { paused: true, legacyMode: false }).nextRun(new Date(now));
				if (!nextRun || (task.expiresAt !== undefined && nextRun.getTime() > task.expiresAt)) {
					task.nextRunAt = undefined;
					task.deleteAfterDispatch = true;
				} else {
					task.nextRunAt = nextRun.getTime();
				}
				continue;
			}

			task.pending = true;
			task.nextRunAt = undefined;
			task.awaitingSleep = true;
			if (task.expiresAt !== undefined && now >= task.expiresAt) {
				task.deleteAfterDispatch = true;
			}
		}
	}

	private async dispatchTask(task: MutableScheduledTask): Promise<void> {
		this.dispatchingTaskId = task.id;
		this.scheduleNextTimer();
		try {
			await this.callbacks.dispatch(this.cloneTask(task));
		} finally {
			const latest = this.tasks.get(task.id);
			if (latest) {
				if (latest.kind === "loop-dynamic" && latest.awaitingSleep) {
					this.tasks.delete(latest.id);
				} else if (latest.deleteAfterDispatch) {
					this.tasks.delete(latest.id);
				}
			}
			this.dispatchingTaskId = undefined;
			this.scheduleNextTimer();
		}
	}
}
