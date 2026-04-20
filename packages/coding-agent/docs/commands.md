> pi can create command templates. Ask it to build one for your workflow.

# Command Templates

Command templates are Markdown snippets that expand into full commands. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

## Locations

Pi loads command templates from:

- Global: `~/.claude/agent/commands/*.md`
- Project: `.claude/commands/*.md`
- Packages: `commands/` directories or `pi.commands` entries in `package.json`
- Settings: `commands` array with files or directories
- CLI: `--command <path>` (repeatable)

Disable discovery with `--no-commands`.

## Format

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- The filename becomes the command name. `review.md` becomes `/review`.
- `description` is optional. If missing, the first non-empty line is used.

## Usage

Type `/` followed by the template name in the editor. Autocomplete shows available templates with descriptions.

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

## Arguments

Templates support positional arguments and simple slicing:

- `$1`, `$2`, ... positional args
- `$@` or `$ARGUMENTS` for all args joined
- `${@:N}` for args from the Nth position (1-indexed)
- `${@:N:L}` for `L` args starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Usage: `/component Button "onClick handler" "disabled support"`

## Loading Rules

- Template discovery in `commands/` is non-recursive.
- If you want templates in subdirectories, add them explicitly via `commands` settings or a package manifest.
