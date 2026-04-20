#!/usr/bin/env node
import { TERMINAL_TITLE } from "../config.js";

process.title = TERMINAL_TITLE;
process.emitWarning = (() => {}) as typeof process.emitWarning;

await import("./register-bedrock.js");
await import("../cli.js");
