# Changelog

## [r.11] - 2026-04-15

### Changed
- Reduced long-session overhead by throttling repeated context token estimation once sessions grow large, while still refreshing the estimate after compaction and on later turns.
- Stopped duplicate CWL cleanup reports from being emitted across repeated filter passes, and kept the interactive transcript from rebuilding itself when showing those cleanup notices.

## [r.5] - 2026-04-11

### Changed
- Improved `/loop` runs so the chat shows the original loop command while keeping the expanded hidden prompt out of transcript context, and plan mode now commits to a single implementation path instead of presenting option menus.
