#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { TERMINAL_TITLE } from "./config.js";
import { main } from "./main.js";

process.title = TERMINAL_TITLE;

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
