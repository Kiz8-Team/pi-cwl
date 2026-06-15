# Changelog

## [r.12] - 2026-04-15

### Changed
- Aligned the TUI-facing release marker with the r.12 coding-agent release so the terminal UI reports the current revision consistently.

## [r.9] - 2026-04-12

### Changed
- Reworked the interactive subagent tool list so it stays compact and readable by showing a short wrapped summary of the most recent nested tool calls instead of rendering every nested tool card inline.

## [r.8] - 2026-04-12

### Changed
- Removed the `/changelog`, `/import`, `/export`, `/share`, and `/hotkeys` interactive commands from the TUI so only the remaining supported session commands stay exposed in the slash-command menu and command handler.

## [r.7] - 2026-04-12

### Changed
- Added `/debug` as a built-in interactive command to toggle detailed CWL cleanup output while keeping normal mode on the concise token summary.
