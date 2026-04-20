/**
 * Command Templates
 *
 * File-based templates that inject content when invoked with /templatename.
 */

import {
	type CommandTemplate,
	createAgentSession,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	SessionManager,
} from "@mariozechner/pi-coding-agent";

// Define custom templates
const deployTemplate: CommandTemplate = {
	name: "deploy",
	description: "Deploy the application",
	filePath: "/virtual/commands/deploy.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/commands/deploy.md", { source: "sdk" }),
	content: `# Deploy Instructions

1. Build: npm run build
2. Test: npm test
3. Deploy: npm run deploy`,
};

const loader = new DefaultResourceLoader({
	commandsOverride: (current) => ({
		commands: [...current.commands, deployTemplate],
		diagnostics: current.diagnostics,
	}),
});
await loader.reload();

// Discover templates from cwd/.claude/commands/ and ~/.claude/agent/commands/
const discovered = loader.getCommands().commands;
console.log("Discovered command templates:");
for (const template of discovered) {
	console.log(`  /${template.name}: ${template.description}`);
}

await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});

console.log(`Session created with ${discovered.length + 1} command templates`);
