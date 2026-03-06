# Craft Agents - Project Overview

## Purpose
Craft Agents is a Claude Code-like desktop agent for Craft documents. It provides an intuitive UI for working with AI agents, supporting multi-session management, MCP integration, multiple LLM providers, and document-centric workflows.

## Tech Stack
| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Language | TypeScript (strict mode, ESNext) |
| AI | @anthropic-ai/claude-agent-sdk, @github/copilot-sdk |
| Desktop | Electron + React 18 |
| UI | shadcn/ui + Tailwind CSS v4 + Radix UI |
| Build | esbuild (main) + Vite (renderer) |
| State | Jotai |
| Package Manager | Bun (monorepo with workspaces) |
| Credentials | AES-256-GCM encrypted file storage |
| Testing | bun test |

## Monorepo Structure
```
apps/
  electron/          # Desktop GUI (primary) - Electron main/preload/renderer
  viewer/            # Web viewer app (Vite + React)
packages/
  core/              # @craft-agent/core - Shared types
  shared/            # @craft-agent/shared - Business logic (agent, auth, config, sessions, sources, MCP, etc.)
  ui/                # @craft-agent/ui - React components
  codex-types/       # Codex type definitions
  bridge-mcp-server/ # Bridge MCP server
  session-tools-core/# Session tools core
  session-mcp-server/# Session MCP server
  mermaid/           # Mermaid diagram support
```

## Key Directories in packages/shared/src/
- `agent/` - CraftAgent, permissions
- `auth/` - OAuth, tokens
- `config/` - Storage, preferences, themes
- `credentials/` - AES-256-GCM encrypted storage
- `sessions/` - Session persistence
- `sources/` - MCP, API, local sources
- `mcp/` - MCP integration
- `tools/` - Tool definitions
- `hooks-simple/` - Event-driven automation
- `skills/` - Specialized agent instructions
- `prompts/` - System prompts
- `statuses/` - Dynamic status system
