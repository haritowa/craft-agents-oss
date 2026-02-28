import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DOCKER_IMAGE = 'craft-agents-sandbox'
export const CLAUDE_SDK_PATH_IN_CONTAINER = '/app/claude-agent-sdk/cli.js'
/** Home directory of the `devbox` user inside the container image */
export const CONTAINER_HOME = '/home/devbox'

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

export function buildDockerArgs(config: DockerArgsConfig): string[] {
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

  // The container runs as the image's `devbox` user (non-root), which
  // satisfies the SDK CLI's requirement to not run as root/sudo and has
  // proper access to /nix. On macOS, bind mount permissions are transparent.

  return [
    'run', '-i', '--rm',
    '--name', containerName(config.sessionId),
    '-w', config.workingDirectory,
    ...mountFlags,
    ...envFlags,
    ...networkFlags,
    image,
    config.innerExecutable,
    ...config.innerArgs,
  ]
}

/** Stop a session's container (auto-removed via --rm flag) */
export async function stopContainer(sessionId: string): Promise<void> {
  const name = containerName(sessionId)
  return new Promise<void>((resolve) => {
    execFile('docker', ['stop', name], { stdio: 'ignore' } as any, () => resolve())
  })
}
