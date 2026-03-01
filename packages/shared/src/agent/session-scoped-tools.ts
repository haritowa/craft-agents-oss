/**
 * Session-Scoped Tools
 *
 * Tools that are scoped to a specific session. Each session gets its own
 * instance of these tools with session-specific callbacks and state.
 *
 * This file is a thin adapter that wraps the shared handlers from
 * @craft-agent/session-tools-core for use with the Claude SDK.
 *
 * Tools included:
 * - SubmitPlan: Submit a plan file for user review/display
 * - config_validate: Validate configuration files
 * - skill_validate: Validate skill SKILL.md files
 * - mermaid_validate: Validate Mermaid diagram syntax
 * - source_test: Validate schema, download icons, test connections
 * - source_oauth_trigger: Start OAuth authentication for MCP sources
 * - source_google_oauth_trigger: Start Google OAuth authentication
 * - source_slack_oauth_trigger: Start Slack OAuth authentication
 * - source_microsoft_oauth_trigger: Start Microsoft OAuth authentication
 * - source_credential_prompt: Prompt user for API credentials
 * - nango_list_connections: List available Nango connections
 * - nango_configure_source: Configure a source to use Nango credentials
 * - transform_data: Transform data files via script for datatable/spreadsheet blocks
 * - render_template: Render a source's HTML template with data
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../sessions/storage.ts';
import { debug } from '../utils/debug.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createClaudeContext } from './claude-context.ts';
import type { RemoteEnvContext } from './options.ts';
import { containerName, CONTAINER_ENTRYPOINT } from './docker-env.ts';
import { basename, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Feature flags
import { FEATURE_FLAGS } from '../feature-flags.ts';

// Template rendering
import { loadTemplate, validateTemplateData } from '../templates/loader.ts';
import { renderMustache } from '../templates/mustache.ts';

// Import Nango provider and source storage
import { listNangoConnections, isValidNangoSecretKey } from '../sources/nango-provider.ts';
import { loadSourceConfig, saveSourceConfig } from '../sources/storage.ts';

// Import handlers from session-tools-core
import {
  handleSubmitPlan,
  handleConfigValidate,
  handleSkillValidate,
  handleMermaidValidate,
  handleSourceTest,
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
  handleCredentialPrompt,
  // Types
  type ToolResult,
  type AuthRequest,
} from '@craft-agent/session-tools-core';
import { createLLMTool, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

// Re-export types for backward compatibility
export type {
  CredentialInputMode,
  AuthRequestType,
  AuthRequest,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  GoogleService,
  SlackService,
  MicrosoftService,
} from '@craft-agent/session-tools-core';

// ============================================================
// Session-Scoped Tool Callbacks
// ============================================================

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Agent-native LLM query callback for call_llm tool (OAuth path).
   * Each agent backend sets this to its own queryLlm implementation.
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * Get callbacks for a session
 */
function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}

// ============================================================
// Plan State Management
// ============================================================

// Map of sessionId -> last submitted plan path (for retrieval after submission)
const sessionPlanFilePaths = new Map<string, string>();

/**
 * Get the last submitted plan file path for a session
 */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/**
 * Set the last submitted plan file path for a session
 */
function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/**
 * Clear plan file state for a session
 */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

// ============================================================
// Plan Path Helpers
// ============================================================

/**
 * Get the plans directory for a session
 */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/**
 * Check if a path is within a session's plans directory
 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// Tool Result Converter
// ============================================================

/**
 * Convert shared ToolResult to SDK format
 */
function convertResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: result.content.map(c => ({ type: 'text' as const, text: c.text })),
    ...(result.isError ? { isError: true } : {}),
  };
}

// ============================================================
// Cache for Session-Scoped Tools
// ============================================================

// Cache tools by session to avoid recreating them
const sessionScopedToolsCache = new Map<string, ReturnType<typeof createSdkMcpServer>>();

/**
 * Clean up cached tools for a session
 */
export function cleanupSessionScopedTools(sessionId: string): void {
  sessionScopedToolsCache.delete(sessionId);
}

// ============================================================
// Tool Schemas
// ============================================================
// Note: _displayName/_intent metadata is injected dynamically by the network
// interceptor and stripped by pre-tool-use.ts before Zod validation runs.
// Do NOT add them here — stripping happens first, causing validation failures.

const submitPlanSchema = {
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
};

const configValidateSchema = {
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'hooks', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
};

const skillValidateSchema = {
  skillSlug: z.string().describe('The slug of the skill to validate'),
};

const mermaidValidateSchema = {
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
};

const sourceTestSchema = {
  sourceSlug: z.string().describe('The slug of the source to test'),
};

const sourceOAuthTriggerSchema = {
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
};

const credentialPromptSchema = {
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
};

const renderTemplateSchema = {
  source: z.string().describe('Source slug (e.g., "linear", "gmail")'),
  template: z.string().describe('Template ID (e.g., "issue-detail", "issue-list")'),
  data: z.record(z.string(), z.unknown()).describe('JSON data to render into the template'),
};

const nangoListConnectionsSchema = {
  search: z.string().optional().describe('Optional search string to filter connections by ID'),
  host: z.string().optional().describe('Nango API host URL (e.g., "https://nango.mycompany.com"). Pass $NANGO_HOST if set. Defaults to https://nango.haritowa.work'),
};

const nangoConfigureSourceSchema = {
  sourceSlug: z.string().describe('The slug of the source to configure with Nango credentials'),
  integrationId: z.string().describe('Nango integration ID (provider_config_key), e.g., "google-mail", "slack", "github"'),
  connectionId: z.string().describe('Nango connection ID (your user/entity identifier), e.g., "user-123"'),
  host: z.string().optional().describe('Nango API host URL. Pass $NANGO_HOST if set. Defaults to https://nango.haritowa.work'),
};

const transformDataSchema = {
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
};

// ============================================================
// Tool Descriptions
// ============================================================

const TOOL_DESCRIPTIONS = {
  SubmitPlan: `Submit a plan for user review.

Call this after you have written your plan to a markdown file using the Write tool.
The plan will be displayed to the user in a special formatted view.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to present the plan to the user
- No further tool calls or text output will be processed after this tool returns
- The conversation will resume when the user responds (accept, modify, or reject the plan)
- Do NOT include any text or tool calls after SubmitPlan - they will not be executed`,

  config_validate: `Validate Craft Agent configuration files.

Use this after editing configuration files to check for errors before they take effect.
Returns structured validation results with errors, warnings, and suggestions.

**Targets:**
- \`config\`: Validates ~/.craft-agent/config.json (workspaces, model, settings)
- \`sources\`: Validates all sources in ~/.craft-agent/workspaces/{workspace}/sources/*/config.json
- \`statuses\`: Validates ~/.craft-agent/workspaces/{workspace}/statuses/config.json
- \`preferences\`: Validates ~/.craft-agent/preferences.json
- \`permissions\`: Validates permissions.json files
- \`tool-icons\`: Validates ~/.craft-agent/tool-icons/tool-icons.json
- \`all\`: Validates all configuration files

**Reference:** ${DOC_REFS.sources}`,

  skill_validate: `Validate a skill's SKILL.md file.

Checks:
- Slug format (lowercase alphanumeric with hyphens)
- SKILL.md exists and is readable
- YAML frontmatter is valid with required fields (name, description)
- Content is non-empty after frontmatter
- Icon format if present (svg/png/jpg)

**Reference:** ${DOC_REFS.skills}`,

  mermaid_validate: `Validate Mermaid diagram syntax before outputting.

Use this when:
- Creating complex diagrams with many nodes/relationships
- Unsure about syntax for a specific diagram type
- Debugging a diagram that failed to render

Returns validation result with specific error messages if invalid.

**Reference:** ${DOC_REFS.mermaid}`,

  source_test: `Validate and test a source configuration.

**This tool performs:**
1. **Schema validation**: Validates config.json structure
2. **Icon handling**: Checks/downloads icon if configured
3. **Completeness check**: Warns about missing guide.md/icon/tagline
4. **Connection test**: Tests if the source is reachable
5. **Auth status**: Checks if source is authenticated

**Reference:** ${DOC_REFS.sources}`,

  source_oauth_trigger: `Start OAuth authentication for an MCP source.

This tool initiates the OAuth 2.0 + PKCE flow for sources that require authentication.

**Prerequisites:**
- Source must exist in the current workspace
- Source must be type 'mcp' with authType 'oauth'
- Source must have a valid MCP URL

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_google_oauth_trigger: `Trigger Google OAuth authentication for a Google API source.

Opens a browser window for the user to sign in with their Google account.

**Supported services:** Gmail, Calendar, Drive

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_slack_oauth_trigger: `Trigger Slack OAuth authentication for a Slack API source.

Opens a browser window for the user to sign in with their Slack account.

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth authentication for a Microsoft API source.

Opens a browser window for the user to sign in with their Microsoft account.

**Supported services:** Outlook, Calendar, OneDrive, Teams, SharePoint

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  render_template: `Render a source's HTML template with data.

Use this when a source provides HTML templates for rich rendering of its data (e.g., issue detail views, email threads, ticket summaries).

**Workflow:**
1. Fetch data from the source (via MCP tools or API calls)
2. Call \`render_template\` with the source slug, template ID, and data
3. Output an \`html-preview\` block with the returned file path as \`"src"\`

**Available templates** are documented in each source's \`guide.md\` under the "Templates" section.

Templates use Mustache syntax — the tool handles rendering and writes the output HTML to the session data folder.`,

  transform_data: `Transform data files using a script and write structured output for datatable/spreadsheet blocks, or extract HTML content for html-preview blocks.

Use this tool when you need to transform large datasets (20+ rows) into structured JSON for display, or extract/decode HTML content for rendering. Write a transform script that reads the input file and produces an output file, then reference it via \`"src"\` in your datatable/spreadsheet/html-preview/pdf-preview block.

**Workflow:**
1. Call \`transform_data\` with a script that reads input files and writes output
2. Output a datatable/spreadsheet block with \`"src": "data/output.json"\`, an html-preview block with \`"src": "data/output.html"\`, or a pdf-preview block with \`"src": "data/output.pdf"\`

**Script conventions:**
- Input file paths are passed as command-line arguments (last arg = output file path)
- Python: \`sys.argv[1:-1]\` = input files, \`sys.argv[-1]\` = output path
- Node/Bun: \`process.argv.slice(2, -1)\` = input files, \`process.argv.at(-1)\` = output path
- For datatable/spreadsheet: output must be valid JSON: \`{"title": "...", "columns": [...], "rows": [...]}\`
- For html-preview: output is an HTML file (any valid HTML)

**Security:** Runs in an isolated subprocess with no access to API keys or credentials. 30-second timeout.`,

  source_credential_prompt: `Prompt the user to enter credentials for a source.

Use this when a source requires authentication that isn't OAuth.
The user will see a secure input UI with appropriate fields based on the auth mode.

**Auth Modes:**
- \`bearer\`: Single token field (Bearer Token, API Key)
- \`basic\`: Username and Password fields
- \`header\`: API Key with custom header name shown
- \`query\`: API Key for query parameter auth

**IMPORTANT:** After calling this tool, execution will be paused for user input.`,

  nango_list_connections: `List all available connections from Nango.

Requires NANGO_SECRET_KEY environment variable to be set.

Returns a list of connections with their integration IDs (provider_config_key) and connection IDs.
Use this to discover available Nango connections before configuring a source to use Nango credentials.

Each connection shows:
- **integrationId**: The Nango integration (e.g., "google-mail", "slack", "github")
- **connectionId**: The user/entity identifier (e.g., "user-123")
- **provider**: The OAuth provider name
- **errors**: Any auth or sync errors on the connection

**IMPORTANT:** If \`$NANGO_HOST\` is set in the environment, you MUST pass it as the \`host\` parameter. Check with \`echo $NANGO_HOST\` first. Self-hosted Nango instances require the correct host to avoid hitting the wrong API.`,

  nango_configure_source: `Configure an existing source to use Nango for credential management.

This sets \`credentialProvider: "nango"\` and the \`nango\` config block on the source,
so tokens are fetched from Nango's API instead of the local encrypted credential store.

**Workflow:**
1. First call \`nango_list_connections\` to see available connections
2. Then call this tool with the source slug and matching integrationId + connectionId
3. The source will immediately start using Nango for token refresh

**Requires:** NANGO_SECRET_KEY environment variable to be set.

**IMPORTANT:** If \`$NANGO_HOST\` is set, pass it as the \`host\` parameter so the host is persisted in the source config for token refresh.`,
};

// ============================================================
// Env Vars to Strip from Subprocess
// ============================================================

const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

// ============================================================
// transform_data Handler
// ============================================================

const TRANSFORM_DATA_TIMEOUT_MS = 30_000;

async function handleTransformData(
  sessionId: string,
  workspaceRootPath: string,
  args: {
    language: 'python3' | 'node' | 'bun';
    script: string;
    inputFiles: string[];
    outputFile: string;
  },
  remoteEnv?: RemoteEnvContext,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  const dataDir = getSessionDataPath(workspaceRootPath, sessionId);

  // Validate outputFile doesn't escape data/ directory
  const resolvedOutput = resolve(dataDir, args.outputFile);
  if (!resolvedOutput.startsWith(normalize(dataDir))) {
    return {
      content: [{ type: 'text', text: `Error: outputFile must be within the session data directory. Got: ${args.outputFile}` }],
      isError: true,
    };
  }

  // Resolve and validate input files (relative to session dir)
  const resolvedInputs: string[] = [];
  for (const inputFile of args.inputFiles) {
    const resolvedInput = resolve(sessionDir, inputFile);
    if (!resolvedInput.startsWith(normalize(sessionDir))) {
      return {
        content: [{ type: 'text', text: `Error: inputFile must be within the session directory. Got: ${inputFile}` }],
        isError: true,
      };
    }
    if (!existsSync(resolvedInput)) {
      return {
        content: [{ type: 'text', text: `Error: input file not found: ${inputFile}` }],
        isError: true,
      };
    }
    resolvedInputs.push(resolvedInput);
  }

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Write script to temp file.
  // When Docker sandbox is active, write to dataDir (bind-mounted into container)
  // so `docker exec` can access it. For local execution, tmpdir() is fine.
  const ext = args.language === 'python3' ? '.py' : '.js';
  const tempScriptDir = remoteEnv?.enabled ? dataDir : tmpdir();
  const tempScript = join(tempScriptDir, `craft-transform-${sessionId}-${Date.now()}${ext}`);
  writeFileSync(tempScript, args.script, 'utf-8');

  try {
    // Build command — this handler runs in the parent (Electron) process on
    // the host. When Docker sandbox is active, wrap via `docker exec` so the
    // script runs inside the container.
    const langCmd = args.language === 'python3' ? 'python3' : args.language;
    const langArgs = [tempScript, ...resolvedInputs, resolvedOutput];

    // Strip sensitive env vars
    const env = { ...process.env };
    for (const key of BLOCKED_ENV_VARS) {
      delete env[key];
    }

    let cmd: string;
    let spawnArgs: string[];
    let spawnEnv: Record<string, string | undefined>;
    if (remoteEnv?.enabled) {
      const name = containerName(remoteEnv.sessionId);
      cmd = 'docker';
      // Use entrypoint wrapper to activate devbox (adds runtimes to PATH)
      spawnArgs = ['exec', name, CONTAINER_ENTRYPOINT, langCmd, ...langArgs];
      spawnEnv = {}; // container has its own env
    } else {
      cmd = langCmd;
      spawnArgs = langArgs;
      spawnEnv = env;
    }

    // Spawn subprocess with manual timeout that escalates to SIGKILL.
    // We can't rely on spawn()'s built-in `timeout` option because it only sends
    // SIGTERM, which can be caught/ignored — leaving the promise hanging forever.
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, reject) => {
      const child = spawn(cmd, spawnArgs, {
        cwd: dataDir,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TRANSFORM_DATA_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (timedOut) {
          resolvePromise({ stdout, stderr: `Script timed out after ${TRANSFORM_DATA_TIMEOUT_MS / 1000}s and was killed`, code });
        } else {
          resolvePromise({ stdout, stderr, code });
        }
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });

    if (result.code !== 0) {
      const errorOutput = result.stderr || result.stdout || 'Script exited with non-zero code';
      debug('session-scoped-tools', `transform_data failed (exit code ${result.code}): ${errorOutput.slice(0, 200)}`);
      return {
        content: [{ type: 'text', text: `Script failed (exit code ${result.code}):\n${errorOutput.slice(0, 2000)}` }],
        isError: true,
      };
    }

    // Verify output file was created
    if (!existsSync(resolvedOutput)) {
      return {
        content: [{ type: 'text', text: `Script completed but output file was not created: ${args.outputFile}\n\nStdout: ${result.stdout.slice(0, 500)}` }],
        isError: true,
      };
    }

    // Return the absolute path for use in the datatable/spreadsheet/html-preview "src" field
    // The UI's file reader requires absolute paths for security validation
    const lines = [`Output written to: ${resolvedOutput}`];
    lines.push(`\nUse this absolute path as the "src" value in your datatable, spreadsheet, html-preview, or pdf-preview block.`);
    if (result.stdout.trim()) {
      lines.push(`\nStdout:\n${result.stdout.slice(0, 500)}`);
    }

    debug('session-scoped-tools', `transform_data succeeded: ${resolvedOutput}`);
    return {
      content: [{ type: 'text', text: lines.join('') }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error running script: ${msg}` }],
      isError: true,
    };
  } finally {
    // Clean up temp script
    try { unlinkSync(tempScript); } catch { /* ignore */ }
  }
}

// ============================================================
// render_template Handler
// ============================================================

async function handleRenderTemplate(
  sessionId: string,
  workspaceRootPath: string,
  args: {
    source: string;
    template: string;
    data: Record<string, unknown>;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sourcePath = join(workspaceRootPath, 'sources', args.source);

  // Validate source exists
  if (!existsSync(sourcePath)) {
    return {
      content: [{ type: 'text', text: `Error: Source "${args.source}" not found at ${sourcePath}` }],
      isError: true,
    };
  }

  // Load template
  const template = loadTemplate(sourcePath, args.template);
  if (!template) {
    return {
      content: [{ type: 'text', text: `Error: Template "${args.template}" not found for source "${args.source}".\n\nExpected file: ${join(sourcePath, 'templates', `${args.template}.html`)}` }],
      isError: true,
    };
  }

  // Soft validation
  const warnings = validateTemplateData(template.meta, args.data);

  // Render template
  let rendered: string;
  try {
    rendered = renderMustache(template.content, args.data);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error rendering template "${args.template}": ${msg}` }],
      isError: true,
    };
  }

  // Write output to session data folder
  const dataDir = getSessionDataPath(workspaceRootPath, sessionId);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const outputFileName = `${args.source}-${args.template}-${Date.now()}.html`;
  const outputPath = join(dataDir, outputFileName);
  writeFileSync(outputPath, rendered, 'utf-8');

  // Build response
  const lines: string[] = [];
  lines.push(`Rendered template: ${template.meta.name || args.template}`);
  lines.push(`Output: ${outputPath}`);
  lines.push('');
  lines.push(`Use this absolute path as the "src" value in your html-preview block.`);

  if (warnings.length > 0) {
    lines.push('');
    lines.push('⚠ Warnings:');
    for (const w of warnings) {
      lines.push(`  - ${w.message}`);
    }
    lines.push('The template was rendered but may have blank sections. Consider re-rendering with the missing fields.');
  }

  debug('session-scoped-tools', `render_template succeeded: ${outputPath} (${warnings.length} warnings)`);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ============================================================
// nango_list_connections Handler
// ============================================================

async function handleNangoListConnections(
  args: { search?: string; host?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const secretKey = process.env.NANGO_SECRET_KEY;
  if (!secretKey) {
    return {
      content: [{ type: 'text', text: 'Error: NANGO_SECRET_KEY environment variable is not set. Set it to your Nango secret key to use Nango integration.' }],
      isError: true,
    };
  }

  const host = args.host || process.env.NANGO_HOST;

  // Block on invalid key — listNangoConnections() will also throw, but give a user-friendly message here
  if (!isValidNangoSecretKey(secretKey)) {
    return {
      content: [{ type: 'text', text: 'Error: NANGO_SECRET_KEY is not a valid UUID v4. This is likely the Nango Public Key instead of the Secret Key. Check your Nango dashboard under Settings → Secret Key for the UUID v4 key.' }],
      isError: true,
    };
  }

  try {
    const connections = await listNangoConnections(secretKey, host);

    if (connections.length === 0) {
      return {
        content: [{ type: 'text', text: 'No Nango connections found. Create connections in your Nango dashboard first.' }],
      };
    }

    // Filter by search string if provided
    const filtered = args.search
      ? connections.filter(c =>
          c.connectionId.toLowerCase().includes(args.search!.toLowerCase()) ||
          c.integrationId.toLowerCase().includes(args.search!.toLowerCase()) ||
          c.provider.toLowerCase().includes(args.search!.toLowerCase())
        )
      : connections;

    if (filtered.length === 0) {
      return {
        content: [{ type: 'text', text: `No connections matching "${args.search}". ${connections.length} total connections available.` }],
      };
    }

    const lines: string[] = [`Found ${filtered.length} Nango connection(s):\n`];
    for (const conn of filtered) {
      const hasErrors = conn.errors.length > 0;
      const errorStr = hasErrors ? ` [ERRORS: ${conn.errors.map(e => e.type).join(', ')}]` : '';
      lines.push(`- provider: ${conn.provider}, integrationId: "${conn.integrationId}", connectionId: "${conn.connectionId}"${errorStr}`);
    }

    lines.push('');
    lines.push('Use nango_configure_source to set a source to use one of these connections.');

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error listing Nango connections: ${msg}` }],
      isError: true,
    };
  }
}

// ============================================================
// nango_configure_source Handler
// ============================================================

async function handleNangoConfigureSource(
  workspaceRootPath: string,
  args: { sourceSlug: string; integrationId: string; connectionId: string; host?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const secretKey = process.env.NANGO_SECRET_KEY;
  if (!secretKey) {
    return {
      content: [{ type: 'text', text: 'Error: NANGO_SECRET_KEY environment variable is not set.' }],
      isError: true,
    };
  }

  if (!isValidNangoSecretKey(secretKey)) {
    return {
      content: [{ type: 'text', text: 'Error: NANGO_SECRET_KEY is not a valid UUID v4. This is likely the Nango Public Key instead of the Secret Key. Check your Nango dashboard under Settings → Secret Key for the UUID v4 key.' }],
      isError: true,
    };
  }

  // Load existing source config
  const config = loadSourceConfig(workspaceRootPath, args.sourceSlug);
  if (!config) {
    return {
      content: [{ type: 'text', text: `Error: Source "${args.sourceSlug}" not found in this workspace.` }],
      isError: true,
    };
  }

  // Resolve host: explicit arg > env var > omit (use default at runtime)
  const host = args.host || process.env.NANGO_HOST;

  // Set Nango credential provider
  config.credentialProvider = 'nango';
  config.nango = {
    integrationId: args.integrationId,
    connectionId: args.connectionId,
    ...(host ? { host } : {}),
  };
  config.isAuthenticated = true;
  config.updatedAt = Date.now();

  try {
    saveSourceConfig(workspaceRootPath, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error saving source config: ${msg}` }],
      isError: true,
    };
  }

  const lines = [
    `Source "${config.name}" (${args.sourceSlug}) configured to use Nango credentials.`,
    '',
    `  credentialProvider: "nango"`,
    `  integrationId: "${args.integrationId}"`,
    `  connectionId: "${args.connectionId}"`,
    '',
    'Tokens will now be fetched from Nango automatically on each request.',
  ];

  // Hint about tokenEnvVar for stdio MCP sources that don't have it set
  if (config.type === 'mcp' && config.mcp?.transport === 'stdio' && !config.mcp.tokenEnvVar) {
    lines.push('');
    lines.push('NOTE: This is a stdio MCP source. To inject the Nango token into the server\'s environment,');
    lines.push('set `mcp.tokenEnvVar` in config.json to the env var name the server expects (e.g., "GITHUB_TOKEN").');
  }

  debug('session-scoped-tools', `nango_configure_source: configured ${args.sourceSlug} with ${args.integrationId}/${args.connectionId}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ============================================================
// Main Factory Function
// ============================================================

/**
 * Get or create session-scoped tools for a session.
 * Returns an MCP server with all session-scoped tools registered.
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
  workspaceId?: string,
  remoteEnv?: RemoteEnvContext
): ReturnType<typeof createSdkMcpServer> {
  const cacheKey = `${sessionId}::${workspaceRootPath}`;

  // Return cached if available
  let cached = sessionScopedToolsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Create Claude context with full capabilities
  const ctx = createClaudeContext({
    sessionId,
    workspacePath: workspaceRootPath,
    workspaceId: workspaceId || basename(workspaceRootPath) || '',
    onPlanSubmitted: (planPath: string) => {
      setLastPlanFilePath(sessionId, planPath);
      const callbacks = getSessionScopedToolCallbacks(sessionId);
      callbacks?.onPlanSubmitted?.(planPath);
    },
    onAuthRequest: (request: unknown) => {
      const callbacks = getSessionScopedToolCallbacks(sessionId);
      callbacks?.onAuthRequest?.(request as AuthRequest);
    },
    remoteEnv,
  });

  // Create tools using shared handlers
  const tools = [
    // SubmitPlan
    tool('SubmitPlan', TOOL_DESCRIPTIONS.SubmitPlan, submitPlanSchema, async (args) => {
      const result = await handleSubmitPlan(ctx, args);
      return convertResult(result);
    }),

    // config_validate
    tool('config_validate', TOOL_DESCRIPTIONS.config_validate, configValidateSchema, async (args) => {
      const result = await handleConfigValidate(ctx, args as { target: 'config' | 'sources' | 'statuses' | 'preferences' | 'permissions' | 'hooks' | 'tool-icons' | 'all'; sourceSlug?: string });
      return convertResult(result);
    }),

    // skill_validate
    tool('skill_validate', TOOL_DESCRIPTIONS.skill_validate, skillValidateSchema, async (args) => {
      const result = await handleSkillValidate(ctx, args);
      return convertResult(result);
    }),

    // mermaid_validate
    tool('mermaid_validate', TOOL_DESCRIPTIONS.mermaid_validate, mermaidValidateSchema, async (args) => {
      const result = await handleMermaidValidate(ctx, args);
      return convertResult(result);
    }),

    // source_test
    tool('source_test', TOOL_DESCRIPTIONS.source_test, sourceTestSchema, async (args) => {
      const result = await handleSourceTest(ctx, args);
      return convertResult(result);
    }),

    // source_oauth_trigger
    tool('source_oauth_trigger', TOOL_DESCRIPTIONS.source_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleSourceOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_google_oauth_trigger
    tool('source_google_oauth_trigger', TOOL_DESCRIPTIONS.source_google_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleGoogleOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_slack_oauth_trigger
    tool('source_slack_oauth_trigger', TOOL_DESCRIPTIONS.source_slack_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleSlackOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_microsoft_oauth_trigger
    tool('source_microsoft_oauth_trigger', TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleMicrosoftOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_credential_prompt
    tool('source_credential_prompt', TOOL_DESCRIPTIONS.source_credential_prompt, credentialPromptSchema, async (args) => {
      const result = await handleCredentialPrompt(ctx, args as {
        sourceSlug: string;
        mode: 'bearer' | 'basic' | 'header' | 'query';
        labels?: { credential?: string; username?: string; password?: string };
        description?: string;
        hint?: string;
        passwordRequired?: boolean;
      });
      return convertResult(result);
    }),

    // nango_list_connections
    tool('nango_list_connections', TOOL_DESCRIPTIONS.nango_list_connections, nangoListConnectionsSchema, async (args) => {
      return handleNangoListConnections(args);
    }),

    // nango_configure_source
    tool('nango_configure_source', TOOL_DESCRIPTIONS.nango_configure_source, nangoConfigureSourceSchema, async (args) => {
      return handleNangoConfigureSource(workspaceRootPath, args);
    }),

    // transform_data
    tool('transform_data', TOOL_DESCRIPTIONS.transform_data, transformDataSchema, async (args) => {
      return handleTransformData(sessionId, workspaceRootPath, args, remoteEnv);
    }),

    // render_template (feature-flagged)
    ...(FEATURE_FLAGS.sourceTemplates ? [
      tool('render_template', TOOL_DESCRIPTIONS.render_template, renderTemplateSchema, async (args) => {
        return handleRenderTemplate(sessionId, workspaceRootPath, args);
      }),
    ] : []),

    // call_llm — secondary LLM calls for subtasks
    createLLMTool({
      sessionId,
      getQueryFn: () => {
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        return callbacks?.queryFn;
      },
    }),

  ];

  // Create MCP server
  cached = createSdkMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });

  sessionScopedToolsCache.set(cacheKey, cached);
  return cached;
}
