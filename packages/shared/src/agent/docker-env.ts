import { existsSync } from 'node:fs'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SdkMcpServerConfig } from './backend/types'
import { debug } from '../utils/debug'

/**
 * Check whether the `docker` CLI is available on the host.
 * Cached after first call for the lifetime of the process.
 */
let _dockerAvailable: boolean | undefined
export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== undefined) return _dockerAvailable
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 })
    _dockerAvailable = true
  } catch {
    _dockerAvailable = false
  }
  return _dockerAvailable
}

export const DOCKER_IMAGE = 'craft-agents-sandbox'
export const CLAUDE_SDK_PATH_IN_CONTAINER = '/app/claude-agent-sdk/cli.js'
/** Home directory of the `devbox` user inside the container image */
export const CONTAINER_HOME = '/home/devbox'
/**
 * Path to the entrypoint script inside the container.
 * Used as a wrapper for `docker exec` commands so that devbox is activated
 * (adding runtimes like curl, node, python3, bun to PATH).
 *
 * `docker exec` does NOT run through the container's ENTRYPOINT — it starts
 * a fresh process with the container's base env, which lacks devbox PATH
 * entries. Prefixing with `/entrypoint.sh` re-activates devbox, then
 * `exec "$@"` hands off to the actual command.
 */
export const CONTAINER_ENTRYPOINT = '/entrypoint.sh'

export function containerName(sessionId: string): string {
  return `craft-agent-${sessionId}`
}

export interface MountConfig {
  workingDirectory: string
  workspaceRootPath: string
  /** App config directory (e.g., ~/.craft-agent). Mounted so the container can access
   *  source configs, credentials, session data, docs, etc. */
  configDir: string
  additionalMounts?: string[]
  /** Override for testing — defaults to os.homedir() */
  homeDir?: string
  /** Override for testing — defaults to CONTAINER_HOME */
  containerHome?: string
  /** Override for testing — defaults to existsSync check */
  globalAgentsDirExists?: boolean
}

/**
 * Collect identity mounts (host path = container path).
 * Uses a Set to deduplicate overlapping paths.
 */
function collectIdentityMounts(config: MountConfig): Set<string> {
  const mounts = new Set<string>()

  // Working directory + app config dir (explicit path, e.g. ~/.craft-agent)
  mounts.add(config.workingDirectory)
  mounts.add(config.configDir)

  if (config.additionalMounts) {
    for (const mount of config.additionalMounts) {
      if (!mount.startsWith('/')) {
        throw new Error(`additionalMount "${mount}" must be an absolute path`)
      }
      mounts.add(mount)
    }
  }

  return mounts
}

/**
 * Collect mapped mounts — host home files mounted at the container user's home
 * so the SDK CLI finds them via its native HOME (no HOME forwarding needed).
 */
function collectHomeMounts(home: string, containerHome: string): string[] {
  const flags: string[] = []

  // .claude.json — writable (SDK CLI / Skill tool writes to it)
  const claudeJson = join(home, '.claude.json')
  if (existsSync(claudeJson)) {
    flags.push('-v', `${claudeJson}:${join(containerHome, '.claude.json')}`)
  }

  // .gitconfig — read-only
  const gitconfig = join(home, '.gitconfig')
  if (existsSync(gitconfig)) {
    flags.push('-v', `${gitconfig}:${join(containerHome, '.gitconfig')}:ro`)
  }

  // Writable ~/.claude/ — SDK CLI persists session data here
  flags.push('-v', `${join(home, '.claude')}:${join(containerHome, '.claude')}`)

  return flags
}

export function buildMountFlags(config: MountConfig): string[] {
  const home = config.homeDir ?? homedir()
  const containerHome = config.containerHome ?? CONTAINER_HOME
  const identityMounts = collectIdentityMounts(config)

  // Identity mounts (same host and container path)
  const flags: string[] = []
  for (const mount of identityMounts) {
    flags.push('-v', `${mount}:${mount}`)
  }

  // Home-mapped mounts
  flags.push(...collectHomeMounts(home, containerHome))

  // Global agents dir (read-only identity mount, skip if already in identityMounts)
  const globalAgentsDir = join(home, '.agents')
  const agentsDirExists = config.globalAgentsDirExists ?? existsSync(globalAgentsDir)
  if (agentsDirExists && !identityMounts.has(globalAgentsDir)) {
    flags.push('-v', `${globalAgentsDir}:${globalAgentsDir}:ro`)
  }

  // Persistent Nix store — survives container restarts via named volume
  flags.push('-v', 'craft-agent-nix:/nix')

  return flags
}

export function buildEnvFlags(env: Record<string, string | undefined>): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Env var key "${key}" is not a valid identifier`)
    }
    if (value !== undefined) {
      if (/[\n\r\0]/.test(value)) {
        throw new Error(`Env var ${key} contains illegal characters (newline/null)`)
      }
      flags.push('-e', `${key}=${value}`)
    }
  }
  return flags
}

export interface DockerArgsConfig {
  sessionId: string
  workingDirectory: string
  workspaceRootPath: string
  /** App config directory (e.g., ~/.craft-agent) */
  configDir: string
  env: Record<string, string | undefined>
  imageName?: string
  innerExecutable: string
  innerArgs: string[]
  network?: string
  additionalMounts?: string[]
  /** Override for testing — defaults to os.homedir() */
  homeDir?: string
  /** Override for testing — defaults to existsSync check */
  globalAgentsDirExists?: boolean
}

/**
 * Build args for `docker run -d` to start a persistent container.
 * The container runs `sleep infinity` as its foreground process, keeping it
 * alive for the session's lifetime. All SDK invocations use `docker exec`.
 *
 * This ensures background tasks (e.g. `npm run dev &`) survive between
 * agent turns — they live as children of the container's init process,
 * not the SDK subprocess.
 */
export function buildContainerRunArgs(config: DockerArgsConfig): string[] {
  const image = config.imageName ?? DOCKER_IMAGE

  const mountFlags = buildMountFlags({
    workingDirectory: config.workingDirectory,
    workspaceRootPath: config.workspaceRootPath,
    configDir: config.configDir,
    additionalMounts: config.additionalMounts,
    homeDir: config.homeDir,
    globalAgentsDirExists: config.globalAgentsDirExists,
  })

  const envFlags = buildEnvFlags(config.env)

  const networkFlags: string[] = config.network
    ? ['--network', config.network]
    : []

  return [
    'run', '-d',
    '--name', containerName(config.sessionId),
    '-w', config.workingDirectory,
    ...mountFlags,
    ...envFlags,
    ...networkFlags,
    image,
    'sleep', 'infinity',
  ]
}

/**
 * Build args for `docker exec -i` to run a command inside the persistent container.
 * Uses `/entrypoint.sh` to activate devbox PATH before running the command.
 */
export function buildExecArgs(
  sessionId: string,
  env: Record<string, string | undefined>,
  innerExecutable: string,
  innerArgs: string[],
): string[] {
  const envFlags = buildEnvFlags(env)

  return [
    'exec', '-i',
    ...envFlags,
    containerName(sessionId),
    CONTAINER_ENTRYPOINT,
    innerExecutable,
    ...innerArgs,
  ]
}

/** Backward-compatible alias used by existing code and tests. */
export const buildDockerArgs = buildContainerRunArgs

/**
 * Check if a container for the given session is already running.
 */
export function isContainerRunning(sessionId: string): boolean {
  const name = containerName(sessionId)
  try {
    const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    return result.stdout?.toString().trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Ensure the persistent container is running for a session.
 * If already running, this is a no-op. Otherwise starts a new detached
 * container with `sleep infinity`.
 *
 * Called before each SDK subprocess spawn to handle:
 * - First invocation (no container yet)
 * - Container crashed or was manually stopped
 */
export function ensureContainer(config: DockerArgsConfig): void {
  const name = containerName(config.sessionId)

  if (isContainerRunning(config.sessionId)) {
    debug(`[docker-env] Container ${name} already running`)
    return
  }

  // Clean up any stopped container with the same name
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })

  const runArgs = buildContainerRunArgs(config)
  debug(`[docker-env] Starting container: docker ${runArgs.join(' ')}`)

  const result = spawnSync('docker', runArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'unknown error'
    throw new Error(`Failed to start Docker container ${name}: ${stderr}`)
  }

  debug(`[docker-env] Container ${name} started`)
}

/** Stop and remove a session's container. */
export async function stopContainer(sessionId: string): Promise<void> {
  const name = containerName(sessionId)
  return new Promise<void>((resolve) => {
    execFile('docker', ['stop', '-t', '3', name], { stdio: 'ignore' } as any, () => {
      execFile('docker', ['rm', '-f', name], { stdio: 'ignore' } as any, () => resolve())
    })
  })
}

/**
 * Transform a stdio MCP server config to run inside the Docker container
 * via `docker exec` instead of spawning directly on the host.
 *
 * Wraps with `/entrypoint.sh` so devbox is activated (runtimes in PATH).
 * Without this, `docker exec` starts a process with the container's base
 * env which lacks Nix/devbox PATH entries — causing "command not found"
 * for tools like curl, node, python3.
 */
export function wrapStdioConfigForDocker(
  config: Extract<SdkMcpServerConfig, { type: 'stdio' }>,
  sessionId: string,
): Extract<SdkMcpServerConfig, { type: 'stdio' }> {
  const name = containerName(sessionId)
  const envFlags = config.env ? buildEnvFlags(config.env) : []

  return {
    type: 'stdio',
    command: 'docker',
    args: [
      'exec', '-i',
      ...envFlags,
      name,
      CONTAINER_ENTRYPOINT,
      config.command,
      ...(config.args ?? []),
    ],
    env: {},
  }
}

/**
 * Wrap all stdio MCP server configs so they run inside the Docker container.
 * HTTP/SSE configs pass through unchanged.
 */
export function wrapStdioServersForDocker(
  servers: Record<string, SdkMcpServerConfig>,
  sessionId: string,
): Record<string, SdkMcpServerConfig> {
  const result: Record<string, SdkMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    result[name] = config.type === 'stdio'
      ? wrapStdioConfigForDocker(config, sessionId)
      : config
  }
  return result
}
