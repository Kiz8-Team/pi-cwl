import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private startedAt = Date.now();
	private completionPrefix: string | undefined;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		private options?: {
			showElapsed?: boolean;
		},
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start() {
		this.startedAt = Date.now();
		this.completionPrefix = undefined;
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	complete(prefix = "Worked for") {
		this.stop();
		this.completionPrefix = prefix;
		this.updateDisplay();
	}

	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	private formatElapsed(): string {
		const elapsedMs = Math.max(0, Date.now() - this.startedAt);
		const totalSeconds = Math.floor(elapsedMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}

	private updateDisplay() {
		const elapsed = this.options?.showElapsed ? ` ${this.formatElapsed()}` : "";
		if (this.completionPrefix) {
			this.setText(
				`${this.spinnerColorFn("⠿")} ${this.messageColorFn(`${this.completionPrefix} ${this.formatElapsed()}`)}`,
			);
		} else {
			const frame = this.frames[this.currentFrame];
			this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(`${this.message}${elapsed}`)}`);
		}
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
