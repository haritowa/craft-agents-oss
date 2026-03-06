# Code Style & Conventions

## Language
- TypeScript throughout, strict mode enabled
- ESNext target, ESModule format
- `type: "module"` in package.json

## TypeScript Config
- `strict: true`
- `noFallthroughCasesInSwitch: true`
- `noUncheckedIndexedAccess: true`
- `noUnusedLocals: false` (not enforced)
- `noUnusedParameters: false` (not enforced)
- `moduleResolution: "bundler"`
- `allowImportingTsExtensions: true`
- `verbatimModuleSyntax: true`
- Path alias: `@/*` → `src/*`

## General Conventions
- Follow existing patterns in the codebase
- Use meaningful variable and function names
- Add comments for complex logic
- React with JSX (jsxImportSource: react)
- UI: shadcn/ui components with Tailwind CSS v4
- State management: Jotai atoms

## Branch Naming
- `feature/add-new-tool` - New features
- `fix/resolve-auth-issue` - Bug fixes
- `refactor/simplify-agent-loop` - Code refactoring
- `docs/update-readme` - Documentation updates
