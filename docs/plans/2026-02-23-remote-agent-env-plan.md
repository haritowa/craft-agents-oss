# Remote Agent Environment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the Claude Agent SDK subprocess inside a Docker container for security isolation, while keeping the Electron UI on the host.

**Architecture:** Replace the local `bun <script>` subprocess spawn with `docker run -i <image> bun <script>`. Bind mount workspace and project directories at identical paths. Pass credentials via `-e` env flags. Container lifecycle tied to session.

**Tech Stack:** Docker, TypeScript, Bun, Claude Agent SDK

**Design doc:** `docs/plans/2026-02-23-remote-agent-env-design.md`

---

### Task 1: Add RemoteEnvConfig to workspace config types

**Files:**
- Modify: `packages/shared/src/workspaces/types.ts:33-62`

**Step 1: Add RemoteEnvConfig interface and field**

Add above the `WorkspaceConfig` interface (before line 33):

```typescript
export interface RemoteEnvConfig {
  /** Enable running agent in Docker container */
  enabled: boolean
  /** Extra host paths to bind-mount into the container (at identical paths) */
  additionalMounts?: string[]
  /** Docker network name for cross-container communication */
  network?: string
}
```

Add to the `WorkspaceConfig` interface body:

```typescript
  /** Remote environment config for Docker sandbox */
  remoteEnv?: RemoteEnvConfig
```

**Step 2: Verify types compile**

Run: `cd /workspaces/craft-agents-oss && bun run build --filter=@craft-agent/shared`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/shared/src/workspaces/types.ts
git commit -m "feat: add RemoteEnvConfig to workspace config types"
```

---

### Task 2: Create Docker environment module

**Files:**
- Create: `packages/shared/src/agent/docker-env.ts`
- Test: `packages/shared/src/agent/__tests__/docker-env.test.ts`

**Step 1: Write tests for mount flag building**

Create `packages/shared/src/agent/__tests__/docker-env.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { buildDockerArgs, buildMountFlags, buildEnvFlags, containerName } from '../docker-env.ts'

describe('containerName', () => {
  test('generates name from session ID', () => {
    expect(containerName('session-123')).toBe('craft-agent-session-123')
  })
})

describe('buildMountFlags', () => {
  test('mounts working directory', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
    })
    expect(flags).toContain('-v')
    expect(flags).toContain('/home/user/project:/home/user/project')
  })

  test('mounts workspace root path', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
    })
    expect(flags).toContain('/home/user/.craft-agent/workspaces/ws1:/home/user/.craft-agent/workspaces/ws1')
  })

  test('mounts additional paths', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['/home/user/libs', '/home/user/.ssh'],
    })
    expect(flags).toContain('/home/user/libs:/home/user/libs')
    expect(flags).toContain('/home/user/.ssh:/home/user/.ssh')
  })

  test('mounts global agents dir when it exists', () => {
    // This test may need mocking for existsSync
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      globalAgentsDirExists: true,
    })
    expect(flags).toContain('/home/user/.agents:/home/user/.agents')
  })

  test('deduplicates overlapping mounts', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['/home/user/project'], // duplicate of workingDirectory
    })
    const mountPairs = flags.filter(f => f.includes(':/'))
    const projectMounts = mountPairs.filter(f => f.startsWith('/home/user/project:'))
    expect(projectMounts.length).toBe(1)
  })
})

describe('buildEnvFlags', () => {
  test('passes ANTHROPIC_API_KEY when set', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test-123',
    })
    expect(flags).toEqual(['-e', 'ANTHROPIC_API_KEY=sk-test-123'])
  })

  test('passes CLAUDE_CODE_OAUTH_TOKEN when set', () => {
    const flags = buildEnvFlags({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abc',
    })
    expect(flags).toEqual(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=oauth-token-abc'])
  })

  test('passes multiple env vars', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://custom.api.com',
      CRAFT_DEBUG: '1',
    })
    expect(flags).toContain('-e')
    expect(flags).toContain('ANTHROPIC_API_KEY=sk-test')
    expect(flags).toContain('ANTHROPIC_BASE_URL=https://custom.api.com')
    expect(flags).toContain('CRAFT_DEBUG=1')
  })

  test('skips undefined values', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: undefined,
    })
    expect(flags).not.toContain('ANTHROPIC_BASE_URL')
  })
})

describe('buildDockerArgs', () => {
  test('produces correct docker run command structure', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: ['--env-file=/dev/null'],
      pathToClaudeCodeExecutable: '/app/claude-sdk/cli.js',
    })

    // Should start with docker run flags
    expect(args[0]).toBe('run')
    expect(args[1]).toBe('-i')
    expect(args[2]).toBe('--rm')
    expect(args).toContain('--name')
    expect(args).toContain('craft-agent-sess-1')

    // Should end with inner command
    const imageIdx = args.indexOf('craft-agents-sandbox')
    expect(imageIdx).toBeGreaterThan(0)
    expect(args[imageIdx + 1]).toBe('bun')
    expect(args).toContain('--env-file=/dev/null')
    expect(args).toContain('/app/claude-sdk/cli.js')
  })

  test('includes network flag when specified', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: {},
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: [],
      pathToClaudeCodeExecutable: '/app/cli.js',
      network: 'my-dev-network',
    })
    expect(args).toContain('--network')
    expect(args).toContain('my-dev-network')
  })

  test('omits network flag when not specified', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: {},
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: [],
      pathToClaudeCodeExecutable: '/app/cli.js',
    })
    expect(args).not.toContain('--network')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/docker-env.test.ts`
Expected: FAIL — module `../docker-env.ts` not found

**Step 3: Implement docker-env.ts**

Create `packages/shared/src/agent/docker-env.ts`:

```typescript
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DOCKER_IMAGE = 'craft-agents-sandbox'
const CLAUDE_SDK_PATH_IN_CONTAINER = '/app/claude-agent-sdk/cli.js'

/** Env vars that should be forwarded to the container */
const FORWARDED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CRAFT_DEBUG',
  'CRAFT_SESSION_DIR',
] as const

export function containerName(sessionId: string): string {
  return `craft-agent-${sessionId}`
}

export interface MountConfig {
  workingDirectory: string
  workspaceRootPath: string
  additionalMounts?: string[]
  /** Override for testing — defaults to os.homedir() */
  homeDir?: string
  /** Override for testing — defaults to existsSync check */
  globalAgentsDirExists?: boolean
}

export function buildMountFlags(config: MountConfig): string[] {
  const home = config.homeDir ?? homedir()
  const mounts = new Set<string>()

  // Always mount working directory and workspace
  mounts.add(config.workingDirectory)
  mounts.add(config.workspaceRootPath)

  // Mount ~/.claude.json for SDK config
  const claudeConfig = join(home, '.claude.json')
  if (existsSync(claudeConfig)) {
    mounts.add(claudeConfig)
  }

  // Mount global agents dir if it exists
  const globalAgentsDir = join(home, '.agents')
  const agentsDirExists = config.globalAgentsDirExists ?? existsSync(globalAgentsDir)
  if (agentsDirExists) {
    mounts.add(globalAgentsDir)
  }

  // Additional user-configured mounts
  if (config.additionalMounts) {
    for (const mount of config.additionalMounts) {
      mounts.add(mount)
    }
  }

  // Convert to -v flags (identical host:container paths)
  const flags: string[] = []
  for (const mount of mounts) {
    flags.push('-v', `${mount}:${mount}`)
  }
  return flags
}

export function buildEnvFlags(env: Record<string, string | undefined>): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      flags.push('-e', `${key}=${value}`)
    }
  }
  return flags
}

export interface DockerArgsConfig {
  sessionId: string
  workingDirectory: string
  workspaceRootPath: string
  env: Record<string, string | undefined>
  imageName?: string
  innerExecutable: string
  innerArgs: string[]
  pathToClaudeCodeExecutable: string
  network?: string
  additionalMounts?: string[]
}

export function buildDockerArgs(config: DockerArgsConfig): string[] {
  const image = config.imageName ?? DOCKER_IMAGE

  const mountFlags = buildMountFlags({
    workingDirectory: config.workingDirectory,
    workspaceRootPath: config.workspaceRootPath,
    additionalMounts: config.additionalMounts,
  })

  const envFlags = buildEnvFlags(config.env)

  const networkFlags: string[] = config.network
    ? ['--network', config.network]
    : []

  return [
    'run', '-i', '--rm',
    '--name', containerName(config.sessionId),
    ...mountFlags,
    ...envFlags,
    ...networkFlags,
    image,
    config.innerExecutable,
    ...config.innerArgs,
    config.pathToClaudeCodeExecutable,
  ]
}

/** Default image name constant */
export { DOCKER_IMAGE, CLAUDE_SDK_PATH_IN_CONTAINER }

/** Stop and remove a session's container (best-effort, does not throw) */
export async function stopContainer(sessionId: string): Promise<void> {
  const name = containerName(sessionId)
  try {
    const proc = Bun.spawn(['docker', 'stop', name], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await proc.exited
  } catch {
    // Container may already be stopped or removed — ignore
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/docker-env.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/shared/src/agent/docker-env.ts packages/shared/src/agent/__tests__/docker-env.test.ts
git commit -m "feat: add docker-env module for container spawn flag building"
```

---

### Task 3: Create the Dockerfile

**Files:**
- Create: `docker/agent-sandbox/Dockerfile`

**Step 1: Write the Dockerfile**

Create `docker/agent-sandbox/Dockerfile`:

```dockerfile
FROM oven/bun:latest

# Install common tools the agent needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    jq \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Agent SDK globally
# The exact version should match what the host app bundles
COPY package.json /app/package.json
RUN cd /app && bun install --production

# Copy the SDK CLI entrypoint
COPY cli.js /app/claude-agent-sdk/cli.js

# Default working directory (overridden by -w flag at runtime)
WORKDIR /workspace

# No CMD — the entrypoint is specified by docker run args
```

> **Note:** The exact Dockerfile contents will need refinement based on how the Claude Agent SDK CLI is currently bundled. The key requirement is that `bun /app/claude-agent-sdk/cli.js` works inside the container. Check `packages/shared/src/agent/options.ts:221-237` for how the CLI path is resolved on the host — the container needs an equivalent path.

**Step 2: Verify image builds**

Run: `cd /workspaces/craft-agents-oss && docker build -t craft-agents-sandbox docker/agent-sandbox/`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add docker/agent-sandbox/Dockerfile
git commit -m "feat: add Dockerfile for agent sandbox container"
```

---

### Task 4: Wire docker-env into getDefaultOptions

**Files:**
- Modify: `packages/shared/src/agent/options.ts:186-248`

**Step 1: Write test for Docker option generation**

Add to an existing or new test file at `packages/shared/src/agent/__tests__/options.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { getDefaultOptions } from '../options.ts'

describe('getDefaultOptions with remoteEnv', () => {
  test('returns docker as executable when remoteEnv is enabled', () => {
    const opts = getDefaultOptions(undefined, {
      enabled: true,
      sessionId: 'test-session',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
    })
    expect(opts.executable).toBe('docker')
  })

  test('returns normal executable when remoteEnv is not provided', () => {
    const opts = getDefaultOptions()
    expect(opts.executable).not.toBe('docker')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/options.test.ts`
Expected: FAIL — `getDefaultOptions` doesn't accept remoteEnv parameter yet

**Step 3: Add remoteEnv parameter to getDefaultOptions**

In `packages/shared/src/agent/options.ts`, modify `getDefaultOptions` (line 186) to accept an optional second parameter:

```typescript
import { buildDockerArgs, DOCKER_IMAGE, CLAUDE_SDK_PATH_IN_CONTAINER } from './docker-env.ts'
import type { RemoteEnvConfig } from '../workspaces/types.ts'

export interface RemoteEnvContext {
  enabled: boolean
  sessionId: string
  workingDirectory: string
  workspaceRootPath: string
  network?: string
  additionalMounts?: string[]
}

export function getDefaultOptions(
  envOverrides?: Record<string, string>,
  remoteEnv?: RemoteEnvContext,
): Partial<Options> {
```

At the **top** of the function body (after `ensureClaudeConfig()`), add the Docker branch:

```typescript
    if (remoteEnv?.enabled) {
      // Collect env vars to forward into the container
      const containerEnv: Record<string, string | undefined> = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ANTHROPIC_BASE_URL: envOverrides?.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL,
        CRAFT_DEBUG: (process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1') ? '1' : '0',
        CRAFT_SESSION_DIR: process.env.CRAFT_SESSION_DIR,
      }

      // Resolve the SDK CLI path and inner args from what would normally be the local options
      const localOpts = getLocalDefaultOptions(envOverrides)
      const innerExecutable = (localOpts.executable as string) || 'bun'
      const innerArgs = localOpts.executableArgs || []

      const dockerArgs = buildDockerArgs({
        sessionId: remoteEnv.sessionId,
        workingDirectory: remoteEnv.workingDirectory,
        workspaceRootPath: remoteEnv.workspaceRootPath,
        env: containerEnv,
        innerExecutable,
        innerArgs,
        pathToClaudeCodeExecutable: CLAUDE_SDK_PATH_IN_CONTAINER,
        network: remoteEnv.network,
        additionalMounts: remoteEnv.additionalMounts,
      })

      return {
        executable: 'docker' as 'bun',
        executableArgs: dockerArgs,
        pathToClaudeCodeExecutable: CLAUDE_SDK_PATH_IN_CONTAINER,
        // Do NOT pass env — the container gets env via -e flags, not inherited process.env
      }
    }
```

Rename the existing function body logic to a private helper `getLocalDefaultOptions` to avoid duplication, then call it from both paths.

**Step 4: Run tests to verify they pass**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/options.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/agent/options.ts packages/shared/src/agent/__tests__/options.test.ts
git commit -m "feat: add Docker subprocess spawn path to getDefaultOptions"
```

---

### Task 5: Thread remoteEnv config through ClaudeAgent

**Files:**
- Modify: `packages/shared/src/agent/claude-agent.ts:110-141` (ClaudeAgentConfig)
- Modify: `packages/shared/src/agent/claude-agent.ts:708` (getDefaultOptions call in chat())
- Modify: `packages/shared/src/agent/backend/types.ts:288-424` (BackendConfig)

**Step 1: Add remoteEnv to BackendConfig**

In `packages/shared/src/agent/backend/types.ts`, add to the `BackendConfig` interface (near line 423, after `envOverrides`):

```typescript
  /**
   * Remote environment config for Docker sandbox.
   * When set with enabled=true, the agent subprocess runs inside a Docker container.
   */
  remoteEnv?: {
    enabled: boolean
    sessionId: string
    workingDirectory: string
    workspaceRootPath: string
    network?: string
    additionalMounts?: string[]
  }
```

**Step 2: Add remoteEnv to ClaudeAgentConfig**

In `packages/shared/src/agent/claude-agent.ts`, add to the `ClaudeAgentConfig` interface (near line 138):

```typescript
  /** Remote environment config — when enabled, agent runs in Docker container */
  remoteEnv?: {
    enabled: boolean
    sessionId: string
    workingDirectory: string
    workspaceRootPath: string
    network?: string
    additionalMounts?: string[]
  }
```

**Step 3: Forward remoteEnv in constructor**

In the constructor (line 409), add `remoteEnv` to the `backendConfig` object:

```typescript
    remoteEnv: config.remoteEnv,
```

**Step 4: Pass remoteEnv to getDefaultOptions in chat()**

At line 708 in the `chat()` method, change:

```typescript
// Before:
...getDefaultOptions(this.config.envOverrides),

// After:
...getDefaultOptions(this.config.envOverrides, this.config.remoteEnv),
```

Do the same at lines 2423 and 2456 (the `runMiniCompletion` and `queryLlm` calls).

**Step 5: Verify types compile**

Run: `cd /workspaces/craft-agents-oss && bun run build --filter=@craft-agent/shared`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add packages/shared/src/agent/claude-agent.ts packages/shared/src/agent/backend/types.ts
git commit -m "feat: thread remoteEnv config through ClaudeAgent to options"
```

---

### Task 6: Pass remoteEnv from SessionManager to ClaudeAgent

**Files:**
- Modify: `apps/electron/src/main/sessions.ts:2731-2816` (Anthropic branch of getOrCreateAgent)

**Step 1: Load remoteEnv from workspace config and pass to ClaudeAgent**

In the Anthropic branch of `getOrCreateAgent()` (around line 2744), after `envOverrides` is built:

```typescript
        // Load remote env config from workspace
        const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const remoteEnvConfig = workspaceConfig?.remoteEnv

        const remoteEnv = remoteEnvConfig?.enabled ? {
          enabled: true,
          sessionId: managed.id,
          workingDirectory: managed.workingDirectory ?? managed.workspace.rootPath ?? process.cwd(),
          workspaceRootPath: managed.workspace.rootPath,
          network: remoteEnvConfig.network,
          additionalMounts: remoteEnvConfig.additionalMounts,
        } : undefined
```

Then in the `ClaudeAgent` constructor call (around line 2752), add the `remoteEnv` field:

```typescript
          remoteEnv,
```

**Step 2: Add container cleanup on session destroy**

Find where `agent.destroy()` is called (lines 3726, 4845) and add container stop logic. Import `stopContainer` from docker-env:

```typescript
import { stopContainer } from '@craft-agent/shared/agent/docker-env'
```

After `agent.destroy()`, add:

```typescript
// Stop Docker container if remote env was used
if (managed.remoteEnv?.enabled) {
  stopContainer(managed.id).catch(() => {})
}
```

Also add container cleanup in the `cleanup()` method (line 5554) for app shutdown:

```typescript
// Stop all Docker containers for active sessions
for (const [sessionId, managed] of this.sessions) {
  if (managed.remoteEnv?.enabled) {
    stopContainer(sessionId).catch(() => {})
  }
}
```

**Step 3: Verify the app builds**

Run: `cd /workspaces/craft-agents-oss && bun run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add apps/electron/src/main/sessions.ts
git commit -m "feat: pass remoteEnv from workspace config to ClaudeAgent and handle container cleanup"
```

---

### Task 7: Integration test — end-to-end Docker spawn

**Files:**
- Create: `packages/shared/src/agent/__tests__/docker-env-integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, test, expect } from 'bun:test'
import { buildDockerArgs, containerName, DOCKER_IMAGE } from '../docker-env.ts'

describe('Docker spawn integration', () => {
  test('full docker run args produce valid command', () => {
    const args = buildDockerArgs({
      sessionId: 'integration-test-1',
      workingDirectory: '/tmp/test-project',
      workspaceRootPath: '/tmp/test-workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        CRAFT_DEBUG: '0',
      },
      innerExecutable: 'bun',
      innerArgs: ['--env-file=/dev/null'],
      pathToClaudeCodeExecutable: '/app/claude-agent-sdk/cli.js',
      network: 'test-network',
      additionalMounts: ['/tmp/extra-mount'],
    })

    // Reconstruct the full command
    const fullCommand = ['docker', ...args]

    // Verify structure: docker run -i --rm --name <name> [-v ...] [-e ...] [--network ...] <image> bun <args> <cli>
    expect(fullCommand[0]).toBe('docker')
    expect(fullCommand[1]).toBe('run')
    expect(fullCommand[2]).toBe('-i')
    expect(fullCommand[3]).toBe('--rm')

    // Verify container name
    const nameIdx = fullCommand.indexOf('--name')
    expect(fullCommand[nameIdx + 1]).toBe('craft-agent-integration-test-1')

    // Verify image comes before inner command
    const imageIdx = fullCommand.indexOf(DOCKER_IMAGE)
    const bunIdx = fullCommand.indexOf('bun', imageIdx)
    expect(bunIdx).toBe(imageIdx + 1)

    // Verify inner args follow bun
    expect(fullCommand[bunIdx + 1]).toBe('--env-file=/dev/null')
    expect(fullCommand[bunIdx + 2]).toBe('/app/claude-agent-sdk/cli.js')

    // Verify mounts include all paths
    const mountValues = fullCommand.filter((_, i) => i > 0 && fullCommand[i - 1] === '-v')
    expect(mountValues).toContain('/tmp/test-project:/tmp/test-project')
    expect(mountValues).toContain('/tmp/test-workspace:/tmp/test-workspace')
    expect(mountValues).toContain('/tmp/extra-mount:/tmp/extra-mount')

    // Verify env vars
    const envValues = fullCommand.filter((_, i) => i > 0 && fullCommand[i - 1] === '-e')
    expect(envValues).toContain('ANTHROPIC_API_KEY=sk-test')
    expect(envValues).toContain('ANTHROPIC_BASE_URL=https://api.anthropic.com')

    // Verify network
    const netIdx = fullCommand.indexOf('--network')
    expect(fullCommand[netIdx + 1]).toBe('test-network')
  })

  test('credentials are never written to mount paths', () => {
    const args = buildDockerArgs({
      sessionId: 'cred-test',
      workingDirectory: '/tmp/project',
      workspaceRootPath: '/tmp/workspace',
      env: {
        ANTHROPIC_API_KEY: 'sk-secret-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-token',
      },
      innerExecutable: 'bun',
      innerArgs: [],
      pathToClaudeCodeExecutable: '/app/cli.js',
    })

    // Credentials should be in -e flags only, never in -v mount paths
    const mountValues = args.filter((_, i) => i > 0 && args[i - 1] === '-v')
    for (const mount of mountValues) {
      expect(mount).not.toContain('sk-secret-key')
      expect(mount).not.toContain('oauth-secret-token')
    }
  })
})
```

**Step 2: Run integration test**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/docker-env-integration.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add packages/shared/src/agent/__tests__/docker-env-integration.test.ts
git commit -m "test: add integration tests for Docker spawn args"
```

---

### Task 8: Manual end-to-end verification

**Step 1: Build the Docker image**

Run: `cd /workspaces/craft-agents-oss && docker build -t craft-agents-sandbox docker/agent-sandbox/`

**Step 2: Set up a test workspace config**

Edit a workspace's `config.json` to add:

```json
{
  "remoteEnv": {
    "enabled": true
  }
}
```

**Step 3: Start the app and send a message**

Run the Electron app. Open a session in the configured workspace. Send a simple message like "What directory am I in?". Verify:

- Container starts (check `docker ps` for `craft-agent-*`)
- Agent responds correctly
- Working directory matches the host project path
- Container stops when session ends

**Step 4: Verify sandbox isolation**

Send: "List files in /etc/passwd" — should work (file exists in container).
Send: "List files in /home/user/Desktop" — should fail if Desktop isn't mounted.

**Step 5: Verify MCP servers work**

Enable an MCP source and verify tools from it are available in the session.

**Step 6: Verify drag-and-drop**

Drag a file into the chat. Verify the agent can read it.

**Step 7: Verify credentials**

Test with both API key and OAuth connections. Verify the agent can make API calls.

---

## Summary of changes

| File | Action | Purpose |
|------|--------|---------|
| `packages/shared/src/workspaces/types.ts` | Modify | Add `RemoteEnvConfig` type |
| `packages/shared/src/agent/docker-env.ts` | Create | Mount/env flag builders, container lifecycle |
| `packages/shared/src/agent/__tests__/docker-env.test.ts` | Create | Unit tests for flag building |
| `packages/shared/src/agent/__tests__/docker-env-integration.test.ts` | Create | Integration tests |
| `packages/shared/src/agent/__tests__/options.test.ts` | Create | Tests for Docker option path |
| `docker/agent-sandbox/Dockerfile` | Create | Base sandbox image |
| `packages/shared/src/agent/options.ts` | Modify | Add Docker spawn branch |
| `packages/shared/src/agent/claude-agent.ts` | Modify | Thread remoteEnv to options |
| `packages/shared/src/agent/backend/types.ts` | Modify | Add remoteEnv to BackendConfig |
| `apps/electron/src/main/sessions.ts` | Modify | Load config, pass to agent, cleanup |
