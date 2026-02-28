import type { Options, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { debug } from "../utils/debug";
import { buildDockerArgs, containerName, CLAUDE_SDK_PATH_IN_CONTAINER } from "./docker-env";
import { CONFIG_DIR } from "../config/paths";

declare const CRAFT_AGENT_CLI_VERSION: string | undefined;

/** Sensitive env var patterns — values are redacted in debug logs */
const SENSITIVE_ENV_PATTERNS = /TOKEN|SECRET|KEY|AUTH|PASSWORD|CREDENTIAL/i;

/** Redact sensitive `-e KEY=VALUE` flags in docker args for safe logging */
function redactDockerArgs(args: string[]): string[] {
    return args.map((arg, i) => {
        if (i === 0 || args[i - 1] !== '-e') return arg;
        const eq = arg.indexOf('=');
        if (eq === -1) return arg;
        const key = arg.substring(0, eq);
        return SENSITIVE_ENV_PATTERNS.test(key) ? `${key}=***` : arg;
    });
}

/** Resolve CRAFT_DEBUG flag from argv or env (once per call, avoids repeated argv scanning) */
function resolveCraftDebug(): '1' | '0' {
    return (process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1') ? '1' : '0';
}

let customPathToClaudeCodeExecutable: string | null = null;
let customInterceptorPath: string | null = null;
let customExecutable: string | null = null;
let claudeConfigChecked = false;

// UTF-8 BOM character — Windows editors/processes sometimes prepend this to files.
// JSON parsers reject BOM, but the file content after BOM may be valid JSON.
const UTF8_BOM = '\uFEFF';

export interface RemoteEnvContext {
    enabled: boolean
    sessionId: string
    workingDirectory: string
    workspaceRootPath: string
    network?: string
    additionalMounts?: string[]
}

/**
 * Ensure ~/.claude.json exists and contains valid, BOM-free JSON before
 * the SDK subprocess starts.
 *
 * Background: The SDK's cli.js reads this file on startup. If it's missing
 * (with a .backup file present), empty, BOM-prefixed, or contains invalid JSON,
 * the CLI writes plain-text error/recovery messages to process.stdout.
 * The SDK transport expects only JSON on stdout, so any plain text causes:
 *   "CLI output was not valid JSON"
 *
 * Known causes of corruption (from claude-code GitHub issues):
 *   - UTF-8 BOM encoding on Windows (#14442) — editors/auth writes add BOM prefix
 *   - Empty file from crash during write (#2593) — CLI truncates before writing
 *   - Race condition with concurrent sessions (#18998) — no file locking
 *   - Missing file with stale .backup — CLI writes recovery instructions to stdout
 *
 * This runs once per process lifetime (not on every message), unless
 * resetClaudeConfigCheck() is called to force a re-check after error recovery.
 */
function ensureClaudeConfig(): void {
    if (claudeConfigChecked) return;
    claudeConfigChecked = true;

    const configPath = join(homedir(), '.claude.json');

    // Clean up stale .backup file — if present and .claude.json is missing,
    // the CLI writes "A backup file exists at..." to stdout, crashing the SDK.
    // We remove it so the CLI sees a clean "missing file" state (which it handles silently).
    const backupPath = `${configPath}.backup`;
    if (existsSync(backupPath)) {
        try {
            unlinkSync(backupPath);
            debug('[options] Removed stale ~/.claude.json.backup');
        } catch (err) {
            debug(`[options] Failed to remove ~/.claude.json.backup: ${err}`);
        }
    }

    // Clean up .corrupted.* files — these accumulate on Windows and signal
    // to the CLI that a previous corruption was detected, altering its stdout output.
    try {
        const homeDir = homedir();
        const files = readdirSync(homeDir);
        for (const file of files) {
            if (file.startsWith('.claude.json.corrupted.')) {
                try {
                    unlinkSync(join(homeDir, file));
                    debug(`[options] Removed stale ${file}`);
                } catch { /* best effort */ }
            }
        }
    } catch {
        // If we can't read homedir, we'll still try the main repair below
    }

    // If file doesn't exist, create it with minimal valid JSON.
    // The CLI handles truly missing files (no backup) silently, but creating
    // the file is safer — it prevents any future backup-related stdout pollution.
    if (!existsSync(configPath)) {
        debug('[options] ~/.claude.json missing, creating with {}');
        writeConfigSafe(configPath, '{}');
        return;
    }

    // File exists — read and validate
    try {
        const raw = readFileSync(configPath, 'utf-8');

        // Strip UTF-8 BOM if present (common on Windows — see claude-code#14442).
        // The BOM is valid UTF-8 but invalid as a JSON start character, so the CLI
        // rejects the file and writes an error to stdout.
        const content = raw.startsWith(UTF8_BOM) ? raw.slice(1) : raw;
        const hasBom = raw !== content;

        if (content.trim().length === 0) {
            // Empty file (or BOM-only) — write minimal valid JSON
            debug(`[options] ~/.claude.json is empty${hasBom ? ' (had BOM)' : ''}, resetting to {}`);
            writeConfigSafe(configPath, '{}');
            return;
        }

        // Try to parse the (BOM-stripped) content
        JSON.parse(content);

        if (hasBom) {
            // Valid JSON but had BOM prefix — rewrite without BOM to prevent
            // the CLI from rejecting it. Preserves all existing config data.
            debug('[options] ~/.claude.json had UTF-8 BOM, rewriting without BOM');
            writeConfigSafe(configPath, content);
        }
        // else: valid JSON, no BOM — nothing to do
    } catch {
        // File exists but contains invalid JSON — reset to minimal valid state.
        // This loses user's CLI config but prevents the subprocess crash.
        debug('[options] ~/.claude.json is corrupted, resetting to {}');
        writeConfigSafe(configPath, '{}');
    }
}

/**
 * Write content to a config file with retry logic for Windows.
 * On Windows, files can be temporarily locked by antivirus scanners,
 * Windows Search indexer, or other processes — retry once after a brief delay.
 */
function writeConfigSafe(configPath: string, content: string): void {
    try {
        writeFileSync(configPath, content, 'utf-8');
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // EBUSY = file in use, EPERM = permission denied (often transient on Windows)
        if (process.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM')) {
            debug(`[options] Write failed with ${code}, retrying after 100ms...`);
            // Synchronous sleep — acceptable here since this runs once at startup
            const start = Date.now();
            while (Date.now() - start < 100) { /* busy wait */ }
            try {
                writeFileSync(configPath, content, 'utf-8');
                debug('[options] Retry succeeded');
            } catch (retryErr) {
                debug(`[options] Retry also failed: ${retryErr}`);
            }
        } else {
            debug(`[options] Failed to write ~/.claude.json: ${err}`);
        }
    }
}

/**
 * Reset the once-per-process guard so ensureClaudeConfig() runs again.
 * Called from the error handler when a config corruption crash is detected
 * at runtime — allows auto-repair before retrying the session.
 */
export function resetClaudeConfigCheck(): void {
    claudeConfigChecked = false;
}

/**
 * Override the path to the Claude Code executable (cli.js from the SDK).
 * This is needed when the SDK is bundled (e.g., in Electron) and can't auto-detect the path.
 */
export function setPathToClaudeCodeExecutable(path: string) {
    customPathToClaudeCodeExecutable = path;
}

/**
 * Set the path to the network interceptor for the SDK subprocess.
 * This interceptor captures API errors and adds metadata to MCP tool schemas.
 */
export function setInterceptorPath(path: string) {
    customInterceptorPath = path;
}

/**
 * Set the path to the JavaScript runtime executable (e.g., bun or node).
 * This is needed when bundling a runtime with the app (e.g., in Electron).
 */
export function setExecutable(path: string) {
    customExecutable = path;
}

/**
 * Resolve the local executable, args, and env for the Claude Code subprocess.
 * This handles the three existing branches: custom path, versioned CLI, and fallback.
 */
function getLocalOptions(envOverrides?: Record<string, string>): Partial<Options> {
    // SECURITY: Disable Bun's automatic .env file loading in the SDK subprocess.
    // Without this, Bun loads .env from the subprocess cwd (user's working directory),
    // which can inject ANTHROPIC_API_KEY and override our OAuth auth — silently charging
    // the user's API key instead of their Max subscription.
    // See: https://github.com/lukilabs/craft-agents-oss/issues/39
    // Use platform-appropriate null device (NUL on Windows, /dev/null on Unix)
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const envFileFlag = `--env-file=${nullDevice}`;

    // If custom path is set (e.g., for Electron), use it with minimal options
    if (customPathToClaudeCodeExecutable) {
        const executableArgs = [envFileFlag];
        // Add interceptor preload if path is set (needed for cache TTL patching)
        if (customInterceptorPath) {
            executableArgs.push('--preload', customInterceptorPath);
        }
        return {
            pathToClaudeCodeExecutable: customPathToClaudeCodeExecutable,
            // Use custom executable if set, otherwise default to 'bun'
            executable: (customExecutable || 'bun') as 'bun',
            executableArgs,
            env: {
                ...process.env,
                ...envOverrides,
                CRAFT_DEBUG: resolveCraftDebug(),
            }
        };
    }

    if (typeof CRAFT_AGENT_CLI_VERSION !== 'undefined' && CRAFT_AGENT_CLI_VERSION != null) {
        const baseDir = join(homedir(), '.local', 'share', 'craft', 'versions', CRAFT_AGENT_CLI_VERSION);
        return {
            pathToClaudeCodeExecutable: join(baseDir, 'claude-agent-sdk', 'cli.js'),
            // Use the compiled binary itself as the runtime via BUN_BE_BUN=1
            // This makes the compiled Bun executable act as the full Bun CLI,
            // eliminating the need for external Node or Bun installation
            executable: process.execPath as 'bun',
            // Inject network interceptor into SDK subprocess for API error capture and MCP schema injection
            executableArgs: [envFileFlag, '--preload', join(baseDir, 'network-interceptor.ts')],
            env: {
                ...process.env,
                BUN_BE_BUN: '1',
                ...envOverrides,
                CRAFT_DEBUG: resolveCraftDebug(),
            }
        }
    }
    return {
        executableArgs: [envFileFlag],
        env: {
            ...process.env,
            ...envOverrides,
            // Propagate debug mode from argv flag OR existing env var
            CRAFT_DEBUG: resolveCraftDebug(),
        }
    };
}

/**
 * Build the allowlisted env vars to forward into the Docker container.
 * HOME is NOT forwarded — the container uses its native HOME (/home/devbox).
 */
function buildContainerEnv(
    envOverrides: Record<string, string> | undefined,
    remoteEnv: RemoteEnvContext,
): Record<string, string | undefined> {
    const ALLOWED_KEYS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CRAFT_DEBUG', 'CRAFT_SESSION_DIR', 'DEVBOX_USER_PROJECT', 'NANGO_SECRET_KEY', 'NANGO_HOST']);

    if (envOverrides) {
        const droppedKeys = Object.keys(envOverrides).filter(k => !ALLOWED_KEYS.has(k));
        if (droppedKeys.length > 0) {
            console.warn('[docker-env] Dropping non-allowlisted envOverrides:', droppedKeys);
        }
    }

    return {
        ANTHROPIC_API_KEY: envOverrides?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: envOverrides?.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ANTHROPIC_BASE_URL: envOverrides?.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL,
        CRAFT_DEBUG: resolveCraftDebug(),
        CRAFT_SESSION_DIR: envOverrides?.CRAFT_SESSION_DIR ?? process.env.CRAFT_SESSION_DIR,
        DEVBOX_USER_PROJECT: join(remoteEnv.workspaceRootPath, 'devbox'),
        NANGO_SECRET_KEY: envOverrides?.NANGO_SECRET_KEY ?? process.env.NANGO_SECRET_KEY,
        NANGO_HOST: envOverrides?.NANGO_HOST ?? process.env.NANGO_HOST,
    };
}

/**
 * Pre-create directories that Docker would otherwise create as root-owned,
 * making them unwritable by the non-root container user.
 */
function ensureDockerMountDirs(workspaceRootPath: string): void {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    mkdirSync(join(workspaceRootPath, 'devbox'), { recursive: true });
}

/** Extract --preload file paths from executable args so their parent dirs can be bind-mounted. */
function extractPreloadMounts(args: string[]): string[] {
    const mounts: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--preload' && i + 1 < args.length) {
            mounts.push(dirname(args[i + 1]!));
        }
    }
    return mounts;
}

/**
 * Hook up AbortSignal to gracefully stop the Docker container.
 * Without this, aborting only kills the host `docker run` process
 * while the container keeps running — corrupting session state.
 */
function attachAbortHandler(proc: ReturnType<typeof spawn>, signal: AbortSignal, containerName: string): void {
    const onAbort = () => {
        try {
            spawn('docker', ['stop', '-t', '3', containerName], { stdio: 'ignore' })
                .on('error', () => {});
        } catch { /* container may already be stopped */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.once('exit', () => signal.removeEventListener('abort', onAbort));
}

/** Pipe Docker stderr to debug log (SDK's SpawnedProcess interface doesn't expose stderr). */
function captureDockerStderr(proc: ReturnType<typeof spawn>): void {
    proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
            debug(`[docker-env stderr] ${text}`);
            console.error(`[docker-env stderr] ${text}`);
        }
    });
}

/**
 * Create a spawnClaudeCodeProcess function that runs the SDK inside Docker.
 * Uses the SDK's escape hatch to bypass its existsSync check on the CLI path
 * (which lives inside the container, not on the host filesystem).
 */
function createDockerSpawner(dockerArgs: string[], sessionId: string): (opts: SpawnOptions) => SpawnedProcess {
    return (sdkSpawnOpts: SpawnOptions): SpawnedProcess => {
        const name = containerName(sessionId);

        // Clean up any leftover container from a previous run (e.g., auth flow interruption)
        spawnSync('docker', ['stop', '-t', '3', name], { stdio: 'ignore' });
        spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });

        const fullArgs = [...dockerArgs, ...sdkSpawnOpts.args];
        debug(`[docker-env] Spawning: docker ${redactDockerArgs(fullArgs).join(' ')}`);

        const proc = spawn('docker', fullArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            signal: sdkSpawnOpts.signal,
        });

        if (sdkSpawnOpts.signal) attachAbortHandler(proc, sdkSpawnOpts.signal, name);
        captureDockerStderr(proc);

        return {
            stdin: proc.stdin,
            stdout: proc.stdout,
            get killed() { return proc.killed; },
            get exitCode() { return proc.exitCode; },
            kill(signal: NodeJS.Signals) { return proc.kill(signal); },
            on(event: string, listener: (...args: any[]) => void) { proc.on(event, listener); },
            once(event: string, listener: (...args: any[]) => void) { proc.once(event, listener); },
            off(event: string, listener: (...args: any[]) => void) { proc.off(event, listener); },
        };
    };
}

/** Build SDK options that run the Claude Code subprocess inside a Docker container. */
function getDockerOptions(localOpts: Partial<Options>, envOverrides: Record<string, string> | undefined, remoteEnv: RemoteEnvContext): Partial<Options> {
    const innerExecutable = (localOpts.executable ?? 'bun') as string;
    const innerArgs = [...(localOpts.executableArgs ?? [])];
    const preloadMounts = extractPreloadMounts(innerArgs);

    ensureDockerMountDirs(remoteEnv.workspaceRootPath);

    const dockerArgs = buildDockerArgs({
        sessionId: remoteEnv.sessionId,
        workingDirectory: remoteEnv.workingDirectory,
        workspaceRootPath: remoteEnv.workspaceRootPath,
        configDir: CONFIG_DIR,
        env: buildContainerEnv(envOverrides, remoteEnv),
        innerExecutable,
        innerArgs,
        network: remoteEnv.network,
        additionalMounts: [...(remoteEnv.additionalMounts ?? []), ...preloadMounts],
    });

    return {
        spawnClaudeCodeProcess: createDockerSpawner(dockerArgs, remoteEnv.sessionId),
        pathToClaudeCodeExecutable: CLAUDE_SDK_PATH_IN_CONTAINER,
    };
}

/**
 * Get default SDK options for spawning the Claude Code subprocess.
 *
 * @param envOverrides - Per-session env var overrides (take precedence over process.env).
 * @param remoteEnv - When enabled, the subprocess runs inside a Docker container.
 */
export function getDefaultOptions(
    envOverrides?: Record<string, string>,
    remoteEnv?: RemoteEnvContext,
): Partial<Options> {
    ensureClaudeConfig();
    const localOpts = getLocalOptions(envOverrides);
    return remoteEnv?.enabled ? getDockerOptions(localOpts, envOverrides, remoteEnv) : localOpts;
}