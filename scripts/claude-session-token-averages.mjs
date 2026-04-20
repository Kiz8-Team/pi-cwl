import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const DEFAULT_TRACE_DIR = resolve(process.env.HOME || process.env.USERPROFILE || "~", ".claude", "agent", "cwl");

function printHelp() {
	console.log(`Usage:
  node scripts/claude-session-token-averages.mjs [trace-dir]

Print average token usage per session, grouped by day, from Claude/pi session traces.

Arguments:
  trace-dir   Directory containing per-session JSON traces
              Default: ${DEFAULT_TRACE_DIR}
`);
}

async function listJsonFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listJsonFiles(entryPath)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".json")) {
			files.push(entryPath);
		}
	}

	return files.sort();
}

function getDayKey(trace, filePath) {
	const messages = Array.isArray(trace?.messages?.full) ? trace.messages.full : [];
	const firstTimestamp = messages
		.map((message) => message?.info?.time?.created)
		.find((value) => typeof value === "number" && Number.isFinite(value));

	if (typeof firstTimestamp === "number") {
		return new Date(firstTimestamp).toISOString().slice(0, 10);
	}

	const fileName = basename(filePath);
	const match = fileName.match(/^(\d{4}-\d{2}-\d{2})T/);
	if (match) {
		return match[1];
	}

	return "unknown";
}

function summarizeSession(trace, filePath) {
	const messages = Array.isArray(trace?.messages?.full) ? trace.messages.full : [];
	const assistantMessages = messages.filter((message) => message?.info?.role === "assistant");

	const totals = {
		total: 0,
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	for (const message of assistantMessages) {
		const tokens = message?.info?.tokens;
		if (!tokens || typeof tokens !== "object") {
			continue;
		}

		totals.total += Number.isFinite(tokens.total) ? tokens.total : 0;
		totals.input += Number.isFinite(tokens.input) ? tokens.input : 0;
		totals.output += Number.isFinite(tokens.output) ? tokens.output : 0;
		totals.reasoning += Number.isFinite(tokens.reasoning) ? tokens.reasoning : 0;
		totals.cacheRead += Number.isFinite(tokens.cache?.read) ? tokens.cache.read : 0;
		totals.cacheWrite += Number.isFinite(tokens.cache?.write) ? tokens.cache.write : 0;
	}

	return {
		sessionID: typeof trace?.sessionID === "string" ? trace.sessionID : basename(filePath, ".json"),
		day: getDayKey(trace, filePath),
		assistantMessages: assistantMessages.length,
		...totals,
	};
}

function addToAccumulator(accumulator, session) {
	accumulator.sessions += 1;
	accumulator.assistantMessages += session.assistantMessages;
	accumulator.total += session.total;
	accumulator.input += session.input;
	accumulator.output += session.output;
	accumulator.reasoning += session.reasoning;
	accumulator.cacheRead += session.cacheRead;
	accumulator.cacheWrite += session.cacheWrite;
}

function createAccumulator() {
	return {
		sessions: 0,
		assistantMessages: 0,
		total: 0,
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function average(value, count) {
	if (count === 0) {
		return 0;
	}
	return Math.round(value / count);
}

function formatNumber(value) {
	return value.toLocaleString("en-US");
}

function printTable(days) {
	const headers = [
		"Day",
		"Sessions",
		"Avg total/session",
		"Avg input/session",
		"Avg output/session",
		"Avg reasoning/session",
		"Avg cache read/session",
		"Avg cache write/session",
		"Avg assistant msgs/session",
	];

	const rows = days.map(([day, summary]) => [
		day,
		formatNumber(summary.sessions),
		formatNumber(average(summary.total, summary.sessions)),
		formatNumber(average(summary.input, summary.sessions)),
		formatNumber(average(summary.output, summary.sessions)),
		formatNumber(average(summary.reasoning, summary.sessions)),
		formatNumber(average(summary.cacheRead, summary.sessions)),
		formatNumber(average(summary.cacheWrite, summary.sessions)),
		formatNumber(average(summary.assistantMessages, summary.sessions)),
	]);

	const widths = headers.map((header, index) => {
		const cells = rows.map((row) => row[index]?.length ?? 0);
		return Math.max(header.length, ...cells);
	});

	const renderRow = (row) => row.map((cell, index) => cell.padStart(widths[index])).join("  ");

	console.log(renderRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) {
		console.log(renderRow(row));
	}
}

async function main() {
	const arg = process.argv[2];
	if (arg === "--help" || arg === "-h") {
		printHelp();
		return;
	}

	const traceDir = resolve(arg ?? DEFAULT_TRACE_DIR);
	const files = await listJsonFiles(traceDir);
	if (files.length === 0) {
		throw new Error(`No JSON trace files found in ${traceDir}`);
	}

	const sessions = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8");
		const trace = JSON.parse(raw);
		sessions.push(summarizeSession(trace, file));
	}

	const days = new Map();
	const overall = createAccumulator();

	for (const session of sessions) {
		if (!days.has(session.day)) {
			days.set(session.day, createAccumulator());
		}
		const daySummary = days.get(session.day);
		addToAccumulator(daySummary, session);
		addToAccumulator(overall, session);
	}

	const sortedDays = [...days.entries()].sort(([left], [right]) => left.localeCompare(right));

	console.log(`Trace directory: ${traceDir}`);
	console.log(`Sessions analyzed: ${formatNumber(sessions.length)}`);
	console.log("");
	printTable(sortedDays);
	console.log("");
	console.log("Overall averages per session:");
	console.log(`- total: ${formatNumber(average(overall.total, overall.sessions))}`);
	console.log(`- input: ${formatNumber(average(overall.input, overall.sessions))}`);
	console.log(`- output: ${formatNumber(average(overall.output, overall.sessions))}`);
	console.log(`- reasoning: ${formatNumber(average(overall.reasoning, overall.sessions))}`);
	console.log(`- cache read: ${formatNumber(average(overall.cacheRead, overall.sessions))}`);
	console.log(`- cache write: ${formatNumber(average(overall.cacheWrite, overall.sessions))}`);
	console.log(`- assistant messages: ${formatNumber(average(overall.assistantMessages, overall.sessions))}`);
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
