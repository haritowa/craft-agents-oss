# Suggested Commands

## Development
```bash
bun install                    # Install dependencies
bun run electron:dev           # Hot reload development
bun run electron:start         # Build and run
```

## Quality Checks
```bash
bun run typecheck:all          # TypeScript checking (core + shared)
bun run typecheck              # TypeScript checking (shared only)
bun run lint                   # Lint electron + shared
bun run lint:shared            # Lint shared package only
bun test                       # Run tests
```

## Build
```bash
bun run electron:build         # Build all electron components
bun run electron:dist          # Build distributable
bun run build                  # General build
```

## Other Apps
```bash
bun run viewer:dev             # Viewer app dev server
bun run marketing:dev          # Marketing site dev server
bun run docs:dev               # Documentation dev server
```

## Utilities
```bash
bun run print:system-prompt    # Print the system prompt
bun run fresh-start            # Reset to fresh state
bun run fresh-start:token      # Reset token only
```

## Task Completion Checklist
When a task is completed, run:
1. `bun run typecheck:all` - Ensure no type errors
2. `bun run lint` - Ensure no lint errors
3. `bun test` - Ensure tests pass
