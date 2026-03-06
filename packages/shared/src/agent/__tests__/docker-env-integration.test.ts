import { describe, it, expect } from 'bun:test'
import { getDefaultOptions, type RemoteEnvContext } from '../options.ts'
import { CLAUDE_SDK_PATH_IN_CONTAINER } from '../docker-env.ts'

describe('Docker spawn integration', () => {
  const remoteEnv: RemoteEnvContext = {
    enabled: true,
    sessionId: 'integration-test-1',
    workingDirectory: '/tmp/test-project',
    workspaceRootPath: '/tmp/test-workspace',
  }

  it('returns spawnClaudeCodeProcess when remoteEnv is enabled', () => {
    const opts = getDefaultOptions(undefined, remoteEnv)
    expect(opts.spawnClaudeCodeProcess).toBeFunction()
  })

  it('does not return spawnClaudeCodeProcess when remoteEnv is not provided', () => {
    const opts = getDefaultOptions()
    expect(opts.spawnClaudeCodeProcess).toBeUndefined()
  })

  it('does not return spawnClaudeCodeProcess when remoteEnv.enabled is false', () => {
    const opts = getDefaultOptions(undefined, { ...remoteEnv, enabled: false })
    expect(opts.spawnClaudeCodeProcess).toBeUndefined()
  })

  it('does not include env field in Docker options', () => {
    const opts = getDefaultOptions(undefined, remoteEnv)
    expect(opts.env).toBeUndefined()
  })

  it('sets pathToClaudeCodeExecutable to container path', () => {
    const opts = getDefaultOptions(undefined, remoteEnv)
    expect(opts.pathToClaudeCodeExecutable).toBe(CLAUDE_SDK_PATH_IN_CONTAINER)
  })

  it('does not set executable or executableArgs in Docker mode', () => {
    const opts = getDefaultOptions(undefined, remoteEnv)
    expect(opts.executable).toBeUndefined()
    expect(opts.executableArgs).toBeUndefined()
  })
})
