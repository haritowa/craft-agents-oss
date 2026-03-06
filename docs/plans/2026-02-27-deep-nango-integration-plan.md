# Deep Nango Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Nango a seamless, equal-citizen credential provider that complements native OAuth — auto-detected during source setup, fully verified during source_test, and clearly communicated to the agent via system prompt.

**Architecture:** Surgical enhancements to 7 existing files. No new files, no new abstractions. Follows existing patterns (context interface for session-tools-core, early-return guards for Nango checks). Uses `SessionToolContext` capability pattern for Nango verification in source_test.

**Tech Stack:** TypeScript, bun:test, fetch (built-in)

---

### Task 1: Fix `hasValidCredentials()` for Nango Sources

**Files:**
- Modify: `packages/shared/src/sources/credential-manager.ts:339-342`

**Step 1: Write the failing test**

There's no dedicated test file for `hasValidCredentials()` visible, and the fix is a 3-line guard that mirrors the existing `sourceNeedsAuthentication()` pattern at line 869. This is a minimal config-only check (no async, no API calls).

Skip TDD for this — it's a guard clause matching an existing pattern.

**Step 2: Add Nango guard to `hasValidCredentials()`**

At `credential-manager.ts:339`, before the existing `getToken` call, add:

```typescript
  async hasValidCredentials(source: LoadedSource): Promise<boolean> {
    // Nango-backed sources manage credentials externally — always valid from our perspective
    if (source.config.credentialProvider === 'nango' && source.config.nango) {
      return true;
    }
    const token = await this.getToken(source);
    return token !== null;
  }
```

**Step 3: Verify typecheck passes**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No errors

---

### Task 2: Add `testNangoConnection` to SessionToolContext

**Files:**
- Modify: `packages/session-tools-core/src/context.ts:272-285` (add new optional capability)

**Step 1: Add the capability interface**

After the `testGoogleSource` optional method (line 284), add:

```typescript
  /**
   * Test a Nango connection by fetching a token.
   * Returns success/failure with credential type and expiry info.
   */
  testNangoConnection?(nangoConfig: { integrationId: string; connectionId: string; host?: string }): Promise<NangoTestResult>;
```

And add the result type near the other test result types (after `ApiTestResult` at line 341):

```typescript
/**
 * Result from Nango connection test
 */
export interface NangoTestResult {
  success: boolean;
  error?: string;
  /** Credential type returned by Nango (e.g., 'OAUTH2', 'API_KEY') */
  credentialType?: string;
  /** Token expiry time as ISO string */
  expiresAt?: string;
}
```

**Step 2: Verify typecheck passes**

Run: `cd packages/session-tools-core && bun run typecheck`
Expected: No errors

---

### Task 3: Implement `testNangoConnection` in source-test handler

**Files:**
- Modify: `packages/session-tools-core/src/handlers/source-test.ts:778-790`

**Step 1: Replace the Nango early-return in `checkAuthStatus()`**

Replace lines 778-790 (the current Nango block in `checkAuthStatus()`) with:

```typescript
  // Nango-backed sources: verify the connection by fetching a token from Nango API
  if (source.credentialProvider === 'nango' && source.nango) {
    lines.push(`Nango credential provider (integrationId: ${source.nango.integrationId}, connectionId: ${source.nango.connectionId})`);

    if (ctx.testNangoConnection) {
      try {
        const result = await ctx.testNangoConnection(source.nango);
        if (result.success) {
          lines.push(`✓ Nango connection verified — token fetched successfully`);
          if (result.credentialType) {
            lines.push(`  Credential type: ${result.credentialType}`);
          }
          if (result.expiresAt) {
            lines.push(`  Expires at: ${result.expiresAt}`);
          }
        } else {
          hasWarning = true;
          lines.push(`✗ Nango connection failed: ${result.error || 'Unknown error'}`);
          lines.push('  Check NANGO_SECRET_KEY and verify the connection exists in your Nango dashboard');
        }
      } catch (err) {
        hasWarning = true;
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`✗ Nango connection test error: ${msg}`);
      }
    } else {
      // Codex context or no Nango test capability — show config-only status
      lines.push(`✓ Configured via Nango`);
      if (!source.isAuthenticated) {
        hasWarning = true;
        lines.push('⚠ Source marked as not authenticated — may need NANGO_SECRET_KEY to be set');
      }
    }

    if (source.lastTestedAt) {
      lines.push(`  Last tested: ${new Date(source.lastTestedAt).toLocaleString()}`);
    }
    return { lines, hasWarning };
  }
```

**Step 2: Verify typecheck passes**

Run: `cd packages/session-tools-core && bun run typecheck`
Expected: No errors

---

### Task 4: Wire `testNangoConnection` in session-scoped-tools

**Files:**
- Modify: `packages/shared/src/agent/session-scoped-tools.ts` (where Claude context is created for source_test)

Find where the `SessionToolContext` is created/populated for the `source_test` handler. Add the `testNangoConnection` implementation that calls `getNangoToken` and `isValidNangoSecretKey`:

```typescript
testNangoConnection: async (nangoConfig) => {
  const secretKey = process.env.NANGO_SECRET_KEY;
  if (!secretKey) {
    return { success: false, error: 'NANGO_SECRET_KEY environment variable is not set' };
  }
  if (!isValidNangoSecretKey(secretKey)) {
    return { success: false, error: 'NANGO_SECRET_KEY is not a valid UUID v4 — you may be using the Nango Public Key instead of the Secret Key' };
  }
  try {
    const host = nangoConfig.host || process.env.NANGO_HOST;
    const result = await getNangoToken(nangoConfig as any, secretKey, host);
    return {
      success: true,
      credentialType: 'OAUTH2',
      expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
},
```

Note: `getNangoToken` and `isValidNangoSecretKey` are already imported in this file (line 45-46).

**Step 2: Verify typecheck passes**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No errors

---

### Task 5: Add Nango guards to OAuth triggers and credential prompt

**Files:**
- Modify: `packages/session-tools-core/src/handlers/source-oauth.ts:42-45, 95-98, 201-204, 290-293`
- Modify: `packages/session-tools-core/src/handlers/credential-prompt.ts:42-45`

**Step 1: Add Nango guard helper**

At the top of `source-oauth.ts`, after imports (line 21), add a helper:

```typescript
/** Check if source uses Nango and return early message if so */
function nangoGuardResponse(source: SourceConfig): ToolResult | null {
  if (source.credentialProvider === 'nango' && source.nango) {
    return successResponse(
      `Source '${source.slug}' uses Nango for authentication (integrationId: ${source.nango.integrationId}). ` +
      `Local auth is not needed. To switch to local auth, remove the credentialProvider and nango fields from the source config.`
    );
  }
  return null;
}
```

Also need to import the `SourceConfig` type (check if already imported — it comes from `../types.ts`).

**Step 2: Insert guard in each handler**

In `handleSourceOAuthTrigger` (after source loaded, line 45):
```typescript
  const nangoGuard = nangoGuardResponse(source);
  if (nangoGuard) return nangoGuard;
```

In `handleGoogleOAuthTrigger` (after source loaded, line 98):
```typescript
  const nangoGuard = nangoGuardResponse(source);
  if (nangoGuard) return nangoGuard;
```

In `handleSlackOAuthTrigger` (after source loaded, line 204):
```typescript
  const nangoGuard = nangoGuardResponse(source);
  if (nangoGuard) return nangoGuard;
```

In `handleMicrosoftOAuthTrigger` (after source loaded, line 293):
```typescript
  const nangoGuard = nangoGuardResponse(source);
  if (nangoGuard) return nangoGuard;
```

**Step 3: Same guard in credential-prompt.ts**

In `handleCredentialPrompt` (after source loaded, line 45), add:

```typescript
  // Nango-backed sources don't need local credentials
  if (source.credentialProvider === 'nango' && source.nango) {
    return successResponse(
      `Source '${sourceSlug}' uses Nango for authentication (integrationId: ${source.nango.integrationId}). ` +
      `Local credentials are not needed. To switch to local auth, remove the credentialProvider and nango fields from the source config.`
    );
  }
```

**Step 4: Verify typecheck passes**

Run: `cd packages/session-tools-core && bun run typecheck`
Expected: No errors

---

### Task 6: Add Nango availability hint to system prompt

**Files:**
- Modify: `packages/shared/src/prompts/system.ts:465-478`

**Step 1: Add Nango hint after the "External Sources" section**

After the "Creating a new source" block (line 478), add a conditional Nango hint:

```typescript
${process.env.NANGO_SECRET_KEY ? `
**Nango credential provider is available** (NANGO_SECRET_KEY is set).
When setting up new sources, check for matching Nango connections first using \`nango_list_connections\` before starting local OAuth flows.
If a matching connection exists, use \`nango_configure_source\` to link it — no local auth needed.
` : ''}
```

**Step 2: Verify typecheck passes**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No errors

---

### Task 7: Add Nango error details to server-builder

**Files:**
- Modify: `packages/shared/src/sources/server-builder.ts:160-168, 282-288`

**Step 1: Add Nango-specific error in `buildApiServer()`**

At line 162 where Nango source returns `null`, before the return, push context:

Replace lines 160-164:
```typescript
    if (source.config.credentialProvider === 'nango' && source.config.nango) {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Nango API source ${source.config.slug} not authenticated or missing token getter`);
        return null;
      }
```

This returns `null` but the caller in `buildAll()` at line 284-287 doesn't add an error for API sources that return `null`. Add error tracking for this case.

In `buildAll()`, after line 287 (the `if (server)` block for API sources), add an else clause:

```typescript
          const getToken = getTokenForSource?.(source);
          const server = await this.buildApiServer(source, credential ?? null, getToken, sessionPath, summarize);
          if (server) {
            apiServers[source.config.slug] = server;
          } else if (source.config.credentialProvider === 'nango' && source.config.nango) {
            errors.push({
              sourceSlug: source.config.slug,
              error: `Nango token fetch failed (integrationId: ${source.config.nango.integrationId}). Check NANGO_SECRET_KEY and Nango connection status.`,
            });
          }
```

**Step 2: Verify typecheck passes**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No errors

---

### Task 8: Update sources.md documentation

**Files:**
- Modify: `apps/electron/resources/docs/sources.md`

**Step 1: Update the source setup flow**

In section "### 1. Understand User Intent" (line 28), add a new step 1.5 after understanding intent but before research:

After line 40, add:

```markdown
### 1.5. Check for Nango Connections (When Available)

If `NANGO_SECRET_KEY` is set in the environment, **always check for matching Nango connections before proceeding with local OAuth**:

1. Call `nango_list_connections` with a search matching the service name (e.g., "google", "slack", "github")
2. If a matching connection exists, offer it to the user:
   > "I found a Nango connection for Google Mail (integrationId: google-mail, connectionId: user-123). Would you like to use Nango for authentication? It handles token refresh automatically."
3. If user accepts: set `credentialProvider: "nango"` in config.json with the matched connection details. Skip the auth trigger step entirely.
4. If user declines or no match found: proceed with local OAuth as usual.

**Why check Nango first:** Nango handles token refresh server-side, eliminating local refresh failures. If a connection already exists, it's the path of least friction.
```

**Step 2: Update the test and validate section**

In section "### 6. Test and Validate" (line 113), after the source_test description (line 126), add:

```markdown
For Nango-backed sources, `source_test` performs **full verification** — it calls the Nango API to fetch a token and confirms the connection is alive. If the test fails, check:
- `NANGO_SECRET_KEY` is set and is the **Secret Key** (UUID v4 format), not the Public Key
- The connection exists and is active in your Nango dashboard
- The integrationId and connectionId match exactly
```

**Step 3: Update the auth trigger section**

In the workflow section (line 816-822), update the Nango bullet to be more prominent:

```markdown
   - **Nango (preferred when available)**: If `NANGO_SECRET_KEY` is set, call `nango_list_connections` first. If a matching connection exists, call `nango_configure_source` — no local auth trigger needed. Nango handles refresh automatically.
```

---

### Task 9: Run full typecheck and verify

**Step 1: Run typechecks for all modified packages**

Run: `cd /workspaces/craft-agents-oss && bun run --filter @craft-agent/shared typecheck && bun run --filter @craft-agent/session-tools-core typecheck`

Expected: No errors

**Step 2: Run existing tests**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/sources/__tests__/nango-provider.test.ts`

Expected: All tests pass (these are the existing Nango provider tests — our changes don't modify nango-provider.ts)

**Step 3: Run docker-env tests**

Run: `cd /workspaces/craft-agents-oss && bun test packages/shared/src/agent/__tests__/docker-env.test.ts`

Expected: All tests pass (we didn't modify docker-env — Nango env vars are already forwarded via options.ts)
