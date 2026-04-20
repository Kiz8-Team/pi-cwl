import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const packageJsonPath = join(packageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const binField = packageJson.bin;

if (!binField || typeof binField !== "object" || typeof binField.pi !== "string") {
	throw new Error(`Expected ${packageJsonPath} to define a string bin.pi entry.`);
}

const cliPath = resolve(packageDir, binField.pi);
const linkName = "pi";

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: options.stdio ?? "pipe",
	});
}

function getGlobalBinDir() {
	const prefix = run("npm", ["config", "get", "prefix"]).trim();
	if (!prefix) {
		throw new Error("Could not determine npm global prefix.");
	}
	return join(prefix, "bin");
}

function isUsablePiBinary(binPath) {
	if (!existsSync(binPath)) {
		return false;
	}

	try {
		lstatSync(binPath);
	} catch {
		return false;
	}

	try {
		execFileSync(binPath, ["--help"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function ensureWrapper(binPath) {
	mkdirSync(dirname(binPath), { recursive: true });
	chmodSync(cliPath, 0o755);

	try {
		if (existsSync(binPath)) {
			rmSync(binPath, { force: true });
		}
	} catch {
		// Ignore missing destination; we'll create it below.
	}

	try {
		symlinkSync(cliPath, binPath);
		return "symlink";
	} catch (error) {
		const script = `#!/usr/bin/env bash\nexec node ${JSON.stringify(cliPath)} "$@"\n`;
		writeFileSync(binPath, script, { mode: 0o755 });
		return error instanceof Error ? `wrapper (${error.message})` : "wrapper";
	}
}

console.log("Linking @mariozechner/pi-coding-agent into npm global store...");
execFileSync("npm", ["--prefix", "packages/coding-agent", "link"], {
	cwd: repoRoot,
	encoding: "utf8",
	stdio: "inherit",
});

const globalBinDir = getGlobalBinDir();
const piBinPath = join(globalBinDir, linkName);

if (!existsSync(cliPath)) {
	throw new Error(`Expected built CLI at ${cliPath}, but it does not exist.`);
}

if (isUsablePiBinary(piBinPath)) {
	console.log(`pi is available at ${piBinPath}`);
	process.exit(0);
}

try {
	const mode = ensureWrapper(piBinPath);
	console.log(`npm link did not expose pi; installed ${mode} at ${piBinPath}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to expose pi at ${piBinPath}: ${message}`);
	console.error(`You can install it manually with: sudo ln -sf ${JSON.stringify(cliPath)} ${JSON.stringify(piBinPath)}`);
	process.exit(1);
}

if (!isUsablePiBinary(piBinPath)) {
	console.error(`Created ${piBinPath}, but it still is not executable as 'pi --help'.`);
	process.exit(1);
}

console.log(`pi is available at ${piBinPath}`);
