import { execCommand } from "../core/exec.js";

/**
 * Fetch a compact git status summary suitable for injecting into the system prompt.
 * Returns undefined if the cwd is not inside a git repository or on any error.
 */
export async function getGitStatusForPrompt(cwd: string): Promise<string | undefined> {
	try {
		const repoCheck = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd, { timeout: 5000 });
		if (repoCheck.code !== 0) {
			return undefined;
		}

		const [branchResult, statusResult, logResult, userResult] = await Promise.all([
			execCommand("git", ["branch", "--show-current"], cwd, { timeout: 5000 }),
			execCommand("git", ["status", "--short"], cwd, { timeout: 5000 }),
			execCommand("git", ["log", "--oneline", "-5"], cwd, { timeout: 5000 }),
			execCommand("git", ["config", "user.name"], cwd, { timeout: 5000 }),
		]);

		const branch = branchResult.stdout.trim() || "(unknown)";
		const statusLines = statusResult.stdout.trim();
		const status = statusLines || "(clean)";
		const recentCommits = logResult.stdout.trim();
		const gitUser = userResult.stdout.trim();

		let result = `Current branch: ${branch}`;
		if (gitUser) {
			result += `\nGit user: ${gitUser}`;
		}
		result += `\n\nStatus:\n${status}`;
		if (recentCommits) {
			result += `\n\nRecent commits:\n${recentCommits}`;
		}

		return result;
	} catch {
		return undefined;
	}
}
