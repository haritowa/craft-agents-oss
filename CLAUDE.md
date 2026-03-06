# CLAUDE.md

## Tool Preferences

**Prefer Serena tools over built-in Claude Code tools for all code operations:**

- **Reading code**: Use Serena's `find_symbol` (with `include_body=true`) and `get_symbols_overview` instead of `Read`. Use `read_file` for full file reads.
- **Editing code**: Use Serena's `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol` for symbol-level edits. Use `replace_content` for line-level edits. Do NOT use `Edit`.
- **Searching code**: Use Serena's `find_symbol`, `find_referencing_symbols`, and `search_for_pattern` instead of `Grep` or `Glob`.
- **Listing files**: Use Serena's `list_dir` and `find_file` instead of `Glob` or `Bash ls`.
- **Creating files**: Use Serena's `create_text_file` instead of `Write`.

Only fall back to built-in tools when Serena tools cannot handle the task (e.g., reading images, PDFs, running shell commands).

## Serena Setup

At the start of each session, activate the project:
```
activate_project("craft-agents-oss")
```
Then check onboarding: `check_onboarding_performed()` — memories are already written.

## Development

- Runtime: Bun
- Language: TypeScript (strict mode)
- Package manager: Bun workspaces (monorepo)
- UI: React 18 + shadcn/ui + Tailwind CSS v4

## Quality Checks

Run before completing any task:
```bash
bun run typecheck:all
bun run lint
bun test
```
