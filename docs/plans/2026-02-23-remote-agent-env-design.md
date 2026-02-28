# Remote Agent Environment (Docker Sandbox) Design

## Problem

Craft Agents runs the Claude SDK subprocess locally on the host machine. The agent has full access to the host filesystem and can execute arbitrary commands. Users want security isolation: the agent should operate in a sandboxed container where it has autonomy but cannot escape to the host.

## Decision

Run the Claude Agent SDK subprocess inside a Docker container. The Electron UI and main process stay on the host. Communication uses stdin/stdout via `docker run -i`, matching the existing subprocess stdio pattern.

## Architecture

```
HOST (Electron)                          DOCKER CONTAINER
+----------------------+                +----------------------------+
| Renderer (React UI)  |                |                            |
|         ^ IPC        |                |  Claude SDK subprocess     |
| Main Process         |   stdin/stdout |    +-- MCP server 1        |
|  +-- SessionManager  | <------------> |    +-- MCP server 2        |
|  +-- Config builder  |  docker run -i |    +-- Bash tool            |
|  +-- Credential mgr  |                |    +-- File tools           |
|  +-- Attachment store|                |                            |
+----------------------+                +----------------------------+
                                         Bind mounts (identical paths):
                                          - project working directory
                                          - ~/.craft-agent/workspaces/{id}
                                          - user-configured extra paths
                                         Docker network:
                                          - bridge (default)
                                          - custom network (optional)
```

### What changes

Only how the subprocess is spawned: `docker run -i` replaces `bun <script>`.

### What doesn't change

IPC protocol, event streaming, session storage, config building, attachment handling, permission flow.

## Container Configuration

### Default image

`craft-agents-sandbox` ships with:
- Bun runtime
- Claude Agent SDK
- Common tools: git, ripgrep, jq, curl

No user-facing image customization for now.

### Workspace config

Addition to workspace `config.json`:

```typescript
interface RemoteEnvConfig {
  /** Enable running agent in Docker container */
  enabled: boolean
  /** Extra host paths to mount (at identical paths) */
  additionalMounts?: string[]
  /** Docker network name (for cross-container communication) */
  network?: string
}
```

Example:

```json
{
  "remoteEnv": {
    "enabled": true,
    "additionalMounts": [
      "/home/user/shared-libs",
      "/home/user/.ssh"
    ],
    "network": "my-dev-network"
  }
}
```

### Bind mounts

Always mounted (at identical host paths):

| Path | Purpose |
|------|---------|
| Project working directory | Agent edits code here |
| `~/.craft-agent/workspaces/{id}/` | Skills, session data, source configs |
| `~/.agents/` (if exists) | Global skills |
| `~/.claude.json` | SDK config |
| Attachment directories | Drag-drop files accessible to agent |

User-configured via `additionalMounts`: any extra host paths.

All mounts use identical paths inside the container to avoid path translation.

### Container lifecycle

- Created on first message in a session (lazy, same as current agent creation)
- Named `craft-agent-{sessionId}` to avoid collisions between concurrent sessions
- Kept alive for session duration
- Stopped + removed (`--rm`) when session ends or app closes
- If container crashes, next message recreates it

### Network

- Default: `bridge` (isolated, internet access only)
- If `network` specified: attaches to named Docker network (cross-container DNS resolution)

## Spawn Mechanism

Currently `getDefaultOptions()` returns:

```typescript
{
  pathToClaudeCodeExecutable: '/path/to/claude-sdk',
  executable: 'bun',
  executableArgs: ['--env-file=/dev/null'],
  env: { ...process.env, ...envOverrides }
}
```

With remote env enabled, we reshape this so the SDK spawns `docker` as the executable:

```typescript
{
  executable: 'docker',
  executableArgs: [
    'run', '-i', '--rm',
    '--name', `craft-agent-${sessionId}`,
    ...mountFlags,     // ['-v', '/host/path:/host/path', ...]
    ...envFlags,       // ['-e', 'ANTHROPIC_API_KEY=...', ...]
    ...networkFlags,   // ['--network', 'my-network']
    imageName,         // 'craft-agents-sandbox'
    'bun',             // actual executable inside container
    ...originalArgs,   // SDK args including --env-file=/dev/null
  ],
  pathToClaudeCodeExecutable: '/app/claude-sdk', // path inside container
}
```

The SDK thinks it's spawning a subprocess. Docker pipes stdin/stdout transparently.

## Credential Handling

Three auth modes, all passed via `-e` flags (process memory only, never written to container filesystem):

| Mode | Env var | Source |
|------|---------|--------|
| API key | `ANTHROPIC_API_KEY` | Decrypted from `credentials.enc` on host |
| OAuth (Max subscription) | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth flow on host, auto-refreshed |
| Custom endpoint | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` | Connection config |

Security properties:
- `.env` hijacking doubly protected: Bun `--env-file=/dev/null` still applies, AND container only sees mounted paths
- Blocked env vars list (prevents leaking to MCP subprocesses) still enforced inside SDK

### Known limitation: OAuth token refresh mid-session

OAuth tokens are set at query start via env vars. If a token expires during a long-running session, the container still holds the old token. The next message will create a fresh query with updated credentials (main process refreshes the token on host, passes new value on next `docker run` or query). This matches current behavior where the SDK subprocess doesn't receive refreshed tokens mid-query.

For very long sessions, a session restart may be needed on token expiry.

## Feature Compatibility Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| Bash tool execution | Works | Runs inside container (the point) |
| File read/write tools | Works | Bind mounts at identical paths |
| MCP stdio servers | Works | Spawned inside container by SDK |
| MCP HTTP servers (other containers) | Works | Docker network DNS resolution |
| Drag-and-drop files | Works | Main process saves to mounted attachments dir |
| Skills (workspace-level) | Works | Workspace dir mounted |
| Skills (project-level) | Works | Project dir mounted, `.agents/` inside it |
| Skills (global `~/.agents/`) | Works | Mounted if exists |
| Session storage (JSONL) | Works | Written by main process on host |
| Working directory | Works | Identical path bind mount |
| Credentials | Works | Passed as `-e` env vars |
| Permission prompts | Works | Handled by main process via SDK hooks over stdio |
| Git operations | Works | Project dir mounted; git in image |
| Internet access | Works | Container has outbound network |
| Files outside mounted paths | Won't work | By design (sandbox); use `additionalMounts` |
| Docker-in-Docker | Won't work | Not supported |
| OAuth refresh mid-session | Limitation | Token set at query start; see known limitation above |

## Implementation Scope

### Files to modify

1. **`packages/shared/src/agent/options.ts`** -- New `getDockerOptions()` that wraps spawn args in `docker run`
2. **`apps/electron/src/main/sessions.ts`** -- Pass `remoteEnv` config + session ID to agent creation; container cleanup on session end
3. **`packages/shared/src/agent/claude-agent.ts`** -- Accept and forward remote env config to options builder
4. **Workspace config schema** -- Add `remoteEnv` field

### New files

5. **`Dockerfile`** -- Base image: Bun + SDK + common tools
6. **`packages/shared/src/agent/docker-env.ts`** -- Container lifecycle: build mount/env/network flags, cleanup

### Not in scope

- UI for configuring remote env (edit config.json directly)
- Image customization
- Remote machine support (local Docker only)
- Docker-in-Docker
