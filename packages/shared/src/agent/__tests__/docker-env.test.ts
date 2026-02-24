import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDockerArgs, buildMountFlags, buildEnvFlags, containerName, DOCKER_IMAGE, stopContainer, CLAUDE_SDK_PATH_IN_CONTAINER, CONTAINER_HOME } from '../docker-env.ts'

describe('containerName', () => {
  it('generates name from session ID', () => {
    expect(containerName('session-123')).toBe('craft-agent-session-123')
  })
})

describe('buildMountFlags', () => {
  it('mounts working directory', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
    })
    expect(flags).toContain('-v')
    expect(flags).toContain('/home/user/project:/home/user/project')
  })

  it('mounts config directory (parent of workspaces/) instead of just workspaceRootPath', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
    })
    // Should mount the entire config dir so the agent can access docs/, config, etc.
    expect(flags).toContain('/home/user/.craft-agent:/home/user/.craft-agent')
    // Should NOT mount just the workspace subdirectory separately
    expect(flags).not.toContain('/home/user/.craft-agent/workspaces/ws1:/home/user/.craft-agent/workspaces/ws1')
  })

  it('mounts additional paths', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['/home/user/libs', '/home/user/.ssh'],
    })
    expect(flags).toContain('/home/user/libs:/home/user/libs')
    expect(flags).toContain('/home/user/.ssh:/home/user/.ssh')
  })

  it('mounts global agents dir when it exists', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      globalAgentsDirExists: true,
    })
    expect(flags).toContain('/home/user/.agents:/home/user/.agents:ro')
  })

  it('does not mount global agents dir when it does not exist', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      globalAgentsDirExists: false,
    })
    expect(flags).not.toContain('/home/user/.agents:/home/user/.agents:ro')
    expect(flags).not.toContain('/home/user/.agents:/home/user/.agents')
  })

  it('throws for relative paths in additionalMounts', () => {
    expect(() => buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['relative/path'],
    })).toThrow('additionalMount "relative/path" must be an absolute path')
  })

  it('throws for dot-relative paths in additionalMounts', () => {
    expect(() => buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['./relative'],
    })).toThrow('additionalMount "./relative" must be an absolute path')
  })

  it('deduplicates overlapping mounts', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      additionalMounts: ['/home/user/project'], // duplicate of workingDirectory
    })
    const mountPairs = flags.filter(f => f.includes(':/'))
    const projectMounts = mountPairs.filter(f => f.startsWith('/home/user/project:'))
    expect(projectMounts.length).toBe(1)
  })

  it('mounts ~/.claude.json to container home (read-only)', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'docker-env-test-'))
    const claudeConfigPath = join(tempHome, '.claude.json')
    writeFileSync(claudeConfigPath, '{}')

    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: tempHome,
    })
    expect(flags).toContain(`${claudeConfigPath}:${join(CONTAINER_HOME, '.claude.json')}:ro`)
  })

  it('mounts ~/.claude/ directory to container home (writable) for session persistence', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      globalAgentsDirExists: false,
    })
    // Should map to container home and be writable (no :ro suffix)
    expect(flags).toContain(`/home/user/.claude:${join(CONTAINER_HOME, '.claude')}`)
    expect(flags).not.toContain(`/home/user/.claude:${join(CONTAINER_HOME, '.claude')}:ro`)
  })

  it('mounts persistent Nix store as named volume', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      globalAgentsDirExists: false,
    })
    // Nix store uses a named volume — Docker auto-populates from image on first use
    expect(flags).toContain('craft-agent-nix:/nix')
  })

  it('mounts ~/.gitconfig to container home (read-only)', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'docker-env-test-'))
    writeFileSync(join(tempHome, '.gitconfig'), '[user]\n  name = Test')

    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: tempHome,
    })
    expect(flags).toContain(`${join(tempHome, '.gitconfig')}:${join(CONTAINER_HOME, '.gitconfig')}:ro`)
  })

  it('does not mount ~/.gitconfig when the file does not exist', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'docker-env-test-'))

    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: tempHome,
    })
    const hasGitConfig = flags.some(f => f.includes('.gitconfig'))
    expect(hasGitConfig).toBe(false)
  })

  it('does not duplicate ~/.agents mount when already in additionalMounts', () => {
    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: '/home/user',
      additionalMounts: ['/home/user/.agents'],
      globalAgentsDirExists: true,
    })
    // ~/.agents should appear only once (as an identity mount from additionalMounts)
    const agentMounts = flags.filter(f => f.includes('.agents'))
    expect(agentMounts.length).toBe(1)
    expect(agentMounts[0]).toBe('/home/user/.agents:/home/user/.agents')
  })

  it('does not mount ~/.claude.json when the file does not exist', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'docker-env-test-'))
    // No .claude.json created in tempHome

    const flags = buildMountFlags({
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      homeDir: tempHome,
    })
    const hasClaudeMount = flags.some(f => f.includes('.claude.json'))
    expect(hasClaudeMount).toBe(false)
  })
})

describe('buildEnvFlags', () => {
  it('passes single env var', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test-123',
    })
    expect(flags).toEqual(['-e', 'ANTHROPIC_API_KEY=sk-test-123'])
  })

  it('passes multiple env vars', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://custom.api.com',
      CRAFT_DEBUG: '1',
    })
    // Verify -e immediately precedes each value
    const idx0 = flags.indexOf('ANTHROPIC_API_KEY=sk-test')
    expect(idx0).toBeGreaterThan(0)
    expect(flags[idx0 - 1]).toBe('-e')

    const idx1 = flags.indexOf('ANTHROPIC_BASE_URL=https://custom.api.com')
    expect(idx1).toBeGreaterThan(0)
    expect(flags[idx1 - 1]).toBe('-e')

    const idx2 = flags.indexOf('CRAFT_DEBUG=1')
    expect(idx2).toBeGreaterThan(0)
    expect(flags[idx2 - 1]).toBe('-e')
  })

  it('skips undefined values', () => {
    const flags = buildEnvFlags({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: undefined,
    })
    expect(flags).toEqual(['-e', 'ANTHROPIC_API_KEY=sk-test'])
  })

  it('returns empty array when no env vars', () => {
    const flags = buildEnvFlags({})
    expect(flags).toEqual([])
  })

  it('throws when a value contains a newline', () => {
    expect(() => buildEnvFlags({ BAD_VAR: 'hello\nworld' })).toThrow(
      'Env var BAD_VAR contains illegal characters (newline/null)',
    )
  })

  it('throws when a value contains a null byte', () => {
    expect(() => buildEnvFlags({ BAD_VAR: 'hello\0world' })).toThrow(
      'Env var BAD_VAR contains illegal characters (newline/null)',
    )
  })

  it('throws when a key contains an equals sign', () => {
    expect(() => buildEnvFlags({ 'BAD=KEY': 'value' })).toThrow(
      'Env var key "BAD=KEY" is not a valid identifier',
    )
  })

  it('throws when a key starts with a digit', () => {
    expect(() => buildEnvFlags({ '1INVALID': 'value' })).toThrow(
      'Env var key "1INVALID" is not a valid identifier',
    )
  })

  it('throws when a key contains a dash', () => {
    expect(() => buildEnvFlags({ 'MY-VAR': 'value' })).toThrow(
      'Env var key "MY-VAR" is not a valid identifier',
    )
  })

  it('throws when a key is empty', () => {
    expect(() => buildEnvFlags({ '': 'value' })).toThrow(
      'Env var key "" is not a valid identifier',
    )
  })

  it('accepts valid keys with underscores and digits', () => {
    const flags = buildEnvFlags({ _MY_VAR_2: 'ok' })
    expect(flags).toEqual(['-e', '_MY_VAR_2=ok'])
  })
})

describe('buildDockerArgs', () => {
  it('produces correct docker run command structure', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: ['--env-file=/dev/null'],
    })

    // Should start with docker run flags
    expect(args[0]).toBe('run')
    expect(args[1]).toBe('-i')
    expect(args[2]).toBe('--rm')
    expect(args).toContain('--name')
    expect(args).toContain('craft-agent-sess-1')

    // Should end with image + inner executable + inner args (SDK appends pathToClaudeCodeExecutable itself)
    const imageIdx = args.indexOf('craft-agents-sandbox')
    expect(imageIdx).toBeGreaterThan(0)
    expect(args[imageIdx + 1]).toBe('bun')
    expect(args[imageIdx + 2]).toBe('--env-file=/dev/null')
    // The args should end after innerArgs — no CLI path appended
    expect(args[args.length - 1]).toBe('--env-file=/dev/null')
  })

  it('includes network flag when specified', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: {},
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: [],
      network: 'my-dev-network',
    })
    expect(args).toContain('--network')
    expect(args).toContain('my-dev-network')
  })

  it('omits network flag when not specified', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: {},
      imageName: 'craft-agents-sandbox',
      innerExecutable: 'bun',
      innerArgs: [],
    })
    expect(args).not.toContain('--network')
  })

  it('uses default image name when not specified', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/tmp/project',
      workspaceRootPath: '/tmp/workspace',
      env: {},
      innerExecutable: 'bun',
      innerArgs: [],
    })
    expect(args).toContain(DOCKER_IMAGE)
  })

  it('sets working directory with -w flag', () => {
    const args = buildDockerArgs({
      sessionId: 'sess-1',
      workingDirectory: '/home/user/project',
      workspaceRootPath: '/home/user/.craft-agent/workspaces/ws1',
      env: {},
      innerExecutable: 'bun',
      innerArgs: [],
    })
    const wIdx = args.indexOf('-w')
    expect(wIdx).toBeGreaterThan(0)
    expect(args[wIdx + 1]).toBe('/home/user/project')
  })
})

describe('stopContainer', () => {
  it('does not throw for a nonexistent session', async () => {
    await expect(stopContainer('nonexistent-session')).resolves.toBeUndefined()
  })
})

describe('CLAUDE_SDK_PATH_IN_CONTAINER', () => {
  it('has the expected container path value', () => {
    expect(CLAUDE_SDK_PATH_IN_CONTAINER).toBe('/app/claude-agent-sdk/cli.js')
  })
})
