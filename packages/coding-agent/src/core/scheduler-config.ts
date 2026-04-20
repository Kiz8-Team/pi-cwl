export function isSchedulerDisabled(): boolean {
	const values = [process.env.PI_DISABLE_CRON, process.env.CLAUDE_CODE_DISABLE_CRON];
	return values.some((value) => typeof value === "string" && /^(1|true|yes)$/i.test(value));
}
