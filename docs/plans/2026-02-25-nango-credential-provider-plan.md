# Nango Credential Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Nango as an optional credential provider so sources can get auto-refreshed tokens from Nango's REST API instead of the local encrypted store.

**Architecture:** Minimal addition — no refactoring. A new `nango-provider.ts` module provides a `getNangoToken()` function that calls Nango's REST API via `fetch`. `TokenRefreshManager.ensureFreshToken()` gets an early return for Nango-backed sources. `sourceNeedsAuthentication()` returns false for Nango sources (auth is external). Zero new dependencies.

**Tech Stack:** TypeScript, Bun, `fetch` (built-in), bun:test

---

### Task 1: Add Nango fields to FolderSourceConfig type

**Files:**
- Modify: `packages/shared/src/sources/types.ts:371-412`

**Step 1: Add NangoSourceConfig interface and fields to FolderSourceConfig**

Add before the `FolderSourceConfig` interface (around line 367):

```typescript
/**
 * Nango credential provider configuration.
 * When set on a source, tokens are fetched from Nango's REST API
 * instead of the local encrypted credential store.
 */
export interface NangoSourceConfig {
  /** Nango integration ID (provider config key), e.g., 'google-mail', 'slack', 'github' */
  integrationId: string;
  /** Nango connection ID (your user/entity identifier), e.g., 'user-123' */
  connectionId: string;
}
```

Add to `FolderSourceConfig` interface, after the `cards` field and before the status tracking section:

```typescript
  // Nango credential provider (optional — when set, tokens come from Nango instead of local store)
  credentialProvider?: 'local' | 'nango';
  nango?: NangoSourceConfig;
```

**Step 2: Export NangoSourceConfig from types**

The type is already exported by virtue of being in the `FolderSourceConfig` interface, but also add a named export to `index.ts` (Task 5).

**Step 3: Commit**

```bash
git add packages/shared/src/sources/types.ts
git commit -m "feat(nango): add credentialProvider and nango fields to FolderSourceConfig"
```

---

### Task 2: Create nango-provider.ts

**Files:**
- Create: `packages/shared/src/sources/nango-provider.ts`
- Create: `packages/shared/src/sources/__tests__/nango-provider.test.ts`

**Step 1: Write the failing tests**

Create `packages/shared/src/sources/__tests__/nango-provider.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { getNangoToken } from '../nango-provider.ts';

describe('getNangoToken', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns access token for OAUTH2 connection', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        credentials: {
          type: 'OAUTH2',
          access_token: 'nango-fresh-token-123',
          expires_at: '2026-03-01T12:00:00.000Z',
          raw: { scope: 'read write', token_type: 'bearer' },
        },
      }), { status: 200 })
    );

    const result = await getNangoToken(
      { integrationId: 'google-mail', connectionId: 'user-123' },
      'nango-secret-key'
    );

    expect(result.accessToken).toBe('nango-fresh-token-123');
    expect(result.expiresAt).toBe(new Date('2026-03-01T12:00:00.000Z').getTime());

    // Verify correct URL and headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.nango.dev/connection/user-123?provider_config_key=google-mail');
    expect(options.headers.Authorization).toBe('Bearer nango-secret-key');
  });

  test('returns access token for API_KEY connection', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        credentials: {
          type: 'API_KEY',
          apiKey: 'my-api-key-456',
        },
      }), { status: 200 })
    );

    const result = await getNangoToken(
      { integrationId: 'custom-api', connectionId: 'user-123' },
      'nango-secret-key'
    );

    expect(result.accessToken).toBe('my-api-key-456');
    expect(result.expiresAt).toBeUndefined();
  });

  test('uses custom host when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        credentials: {
          type: 'OAUTH2',
          access_token: 'token',
          expires_at: '2026-03-01T12:00:00.000Z',
        },
      }), { status: 200 })
    );

    await getNangoToken(
      { integrationId: 'github', connectionId: 'user-1' },
      'secret',
      'https://nango.self-hosted.com'
    );

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://nango.self-hosted.com/connection/user-1?provider_config_key=github');
  });

  test('throws on unsupported credential type', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        credentials: {
          type: 'BASIC',
          username: 'user',
          password: 'pass',
        },
      }), { status: 200 })
    );

    expect(
      getNangoToken(
        { integrationId: 'test', connectionId: 'user-1' },
        'secret'
      )
    ).rejects.toThrow('Unsupported Nango credential type: BASIC');
  });

  test('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    );

    expect(
      getNangoToken(
        { integrationId: 'missing', connectionId: 'user-1' },
        'secret'
      )
    ).rejects.toThrow('Nango API error (404)');
  });

  test('handles missing expires_at gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        credentials: {
          type: 'OAUTH2',
          access_token: 'token-no-expiry',
        },
      }), { status: 200 })
    );

    const result = await getNangoToken(
      { integrationId: 'test', connectionId: 'user-1' },
      'secret'
    );

    expect(result.accessToken).toBe('token-no-expiry');
    expect(result.expiresAt).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && bun test src/sources/__tests__/nango-provider.test.ts`
Expected: FAIL — module `../nango-provider.ts` not found

**Step 3: Write the implementation**

Create `packages/shared/src/sources/nango-provider.ts`:

```typescript
/**
 * Nango Credential Provider
 *
 * Fetches auto-refreshed tokens from Nango's REST API.
 * Nango handles all token refresh logic server-side — every call to
 * GET /connection returns a fresh token if the current one has expired.
 *
 * Zero dependencies: uses built-in fetch.
 */

import type { NangoSourceConfig } from './types.ts';
import { debug } from '../utils/debug.ts';

const DEFAULT_NANGO_HOST = 'https://api.nango.dev';

export interface NangoTokenResult {
  accessToken: string;
  expiresAt?: number; // Unix timestamp in ms
}

/**
 * Fetch a fresh token from Nango's REST API.
 *
 * @param nangoConfig - Integration ID and connection ID from source config
 * @param secretKey - Nango secret key (from NANGO_SECRET_KEY env var)
 * @param host - Nango API host (defaults to https://api.nango.dev)
 * @returns Fresh access token with optional expiry
 */
export async function getNangoToken(
  nangoConfig: NangoSourceConfig,
  secretKey: string,
  host?: string
): Promise<NangoTokenResult> {
  const baseUrl = host || DEFAULT_NANGO_HOST;
  const url = `${baseUrl}/connection/${encodeURIComponent(nangoConfig.connectionId)}?provider_config_key=${encodeURIComponent(nangoConfig.integrationId)}`;

  debug(`[NangoProvider] Fetching token for ${nangoConfig.integrationId}/${nangoConfig.connectionId}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Nango API error (${response.status}): ${body}`);
  }

  const data = await response.json() as {
    credentials: {
      type: string;
      access_token?: string;
      expires_at?: string;
      apiKey?: string;
      raw?: Record<string, unknown>;
    };
  };

  const { credentials } = data;

  if (credentials.type === 'OAUTH2') {
    return {
      accessToken: credentials.access_token!,
      expiresAt: credentials.expires_at
        ? new Date(credentials.expires_at).getTime()
        : undefined,
    };
  }

  if (credentials.type === 'API_KEY') {
    return {
      accessToken: credentials.apiKey!,
    };
  }

  throw new Error(`Unsupported Nango credential type: ${credentials.type}`);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && bun test src/sources/__tests__/nango-provider.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add packages/shared/src/sources/nango-provider.ts packages/shared/src/sources/__tests__/nango-provider.test.ts
git commit -m "feat(nango): add getNangoToken function with tests"
```

---

### Task 3: Integrate Nango into TokenRefreshManager

**Files:**
- Modify: `packages/shared/src/sources/token-refresh-manager.ts:1-17,113-176`
- Modify: `packages/shared/src/sources/__tests__/token-refresh-manager.test.ts`

**Step 1: Write failing tests for Nango path in ensureFreshToken**

Add to `packages/shared/src/sources/__tests__/token-refresh-manager.test.ts`, inside the existing `describe('TokenRefreshManager')` block, add a new describe section:

```typescript
  describe('Nango credential provider', () => {
    // Mock fetch for Nango API calls
    const originalFetch = globalThis.fetch;
    let mockFetch: ReturnType<typeof mock>;

    beforeEach(() => {
      mockFetch = mock();
      globalThis.fetch = mockFetch as any;
      // Set required env var
      process.env.NANGO_SECRET_KEY = 'test-nango-secret';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.NANGO_SECRET_KEY;
      delete process.env.NANGO_HOST;
    });

    test('fetches token from Nango API for nango-backed source', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'nango-fresh-token',
            expires_at: '2026-03-01T12:00:00.000Z',
          },
        }), { status: 200 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://gmail.googleapis.com', authType: 'bearer' },
        credentialProvider: 'nango',
        nango: { integrationId: 'google-mail', connectionId: 'user-123' },
        isAuthenticated: true,
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('nango-fresh-token');
      // Should NOT call local credential manager
      expect(credManager.load).not.toHaveBeenCalled();
      expect(credManager.refresh).not.toHaveBeenCalled();
    });

    test('returns failure when Nango API returns error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": "Connection not found"}', { status: 404 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'mcp',
        provider: 'github',
        mcp: { url: 'https://api.github.com/mcp', authType: 'bearer' },
        credentialProvider: 'nango',
        nango: { integrationId: 'github', connectionId: 'user-123' },
        isAuthenticated: true,
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Nango API error');
    });

    test('returns failure when NANGO_SECRET_KEY is not set', async () => {
      delete process.env.NANGO_SECRET_KEY;

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'test', connectionId: 'user-1' },
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('NANGO_SECRET_KEY');
    });

    test('falls through to local logic when credentialProvider is not nango', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'local-token',
          expiresAt: Date.now() + 3600_000,
        })),
        isExpired: mock(() => false),
        needsRefresh: mock(() => false),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://gmail.googleapis.com', authType: 'bearer' },
        // No credentialProvider or nango fields
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('local-token');
      expect(credManager.load).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('uses NANGO_HOST env var when set', async () => {
      process.env.NANGO_HOST = 'https://nango.mycompany.com';
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'self-hosted-token',
            expires_at: '2026-03-01T12:00:00.000Z',
          },
        }), { status: 200 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'slack', connectionId: 'user-1' },
      });

      await manager.ensureFreshToken(source);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain('nango.mycompany.com');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && bun test src/sources/__tests__/token-refresh-manager.test.ts`
Expected: FAIL — `credentialProvider` not recognized on `FolderSourceConfig` (if Task 1 isn't done yet) or `ensureFreshToken` doesn't handle Nango path

**Step 3: Modify TokenRefreshManager to handle Nango sources**

In `packages/shared/src/sources/token-refresh-manager.ts`:

Add import at top:
```typescript
import { getNangoToken } from './nango-provider.ts';
```

Add early return at the start of `ensureFreshToken()`, right after `const slug = source.config.slug;` (line 114):

```typescript
    // Nango-backed sources: fetch token directly from Nango API.
    // Nango handles all token refresh server-side, so we bypass local credential logic entirely.
    if (source.config.credentialProvider === 'nango' && source.config.nango) {
      return this.fetchNangoToken(source);
    }
```

Add new private method to the class (after `clearCooldown` method, before `reset`):

```typescript
  /**
   * Fetch token from Nango API for Nango-backed sources.
   * Bypasses all local credential storage and refresh logic.
   */
  private async fetchNangoToken(source: LoadedSource): Promise<TokenRefreshResult> {
    const slug = source.config.slug;
    const secretKey = process.env.NANGO_SECRET_KEY;

    if (!secretKey) {
      this.log(`[TokenRefresh] NANGO_SECRET_KEY not set for Nango source ${slug}`);
      return {
        success: false,
        reason: 'NANGO_SECRET_KEY environment variable is not set',
      };
    }

    try {
      const result = await getNangoToken(
        source.config.nango!,
        secretKey,
        process.env.NANGO_HOST
      );

      this.log(`[TokenRefresh] Got Nango token for ${slug}`);
      this.clearFailure(slug);
      return { success: true, token: result.accessToken };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[TokenRefresh] Nango fetch failed for ${slug}: ${reason}`);
      this.recordFailure(slug);
      return { success: false, reason };
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && bun test src/sources/__tests__/token-refresh-manager.test.ts`
Expected: All tests PASS (both new Nango tests and existing tests)

**Step 5: Commit**

```bash
git add packages/shared/src/sources/token-refresh-manager.ts packages/shared/src/sources/__tests__/token-refresh-manager.test.ts
git commit -m "feat(nango): integrate Nango token fetch into TokenRefreshManager"
```

---

### Task 4: Bypass local auth for Nango sources

**Files:**
- Modify: `packages/shared/src/sources/credential-manager.ts:867-892`

**Step 1: Write failing test**

Add to a new or existing test file. The simplest approach: add to the token-refresh-manager test file since it already has `createMockSource` and imports `sourceNeedsAuthentication` can be imported there. Or create a small focused test. Add to `packages/shared/src/sources/__tests__/token-refresh-manager.test.ts`:

At the top, add import:
```typescript
import { sourceNeedsAuthentication } from '../credential-manager.ts';
```

Add new describe block at the bottom (outside the TokenRefreshManager describe):

```typescript
describe('sourceNeedsAuthentication with Nango', () => {
  test('returns false for Nango-backed MCP source even when not locally authenticated', () => {
    const source = createMockSource({
      type: 'mcp',
      provider: 'github',
      mcp: { url: 'https://api.github.com/mcp', authType: 'bearer' },
      credentialProvider: 'nango',
      nango: { integrationId: 'github', connectionId: 'user-1' },
      isAuthenticated: false, // Not locally authenticated
    });

    expect(sourceNeedsAuthentication(source)).toBe(false);
  });

  test('returns false for Nango-backed API source even when not locally authenticated', () => {
    const source = createMockSource({
      type: 'api',
      provider: 'google',
      api: { baseUrl: 'https://gmail.googleapis.com', authType: 'bearer' },
      credentialProvider: 'nango',
      nango: { integrationId: 'google-mail', connectionId: 'user-1' },
      isAuthenticated: false,
    });

    expect(sourceNeedsAuthentication(source)).toBe(false);
  });

  test('still returns true for non-Nango source that needs auth', () => {
    const source = createMockSource({
      type: 'mcp',
      provider: 'github',
      mcp: { url: 'https://api.github.com/mcp', authType: 'oauth' },
      isAuthenticated: false,
    });

    expect(sourceNeedsAuthentication(source)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && bun test src/sources/__tests__/token-refresh-manager.test.ts`
Expected: First two tests FAIL (Nango sources still trigger `sourceNeedsAuthentication`)

**Step 3: Modify sourceNeedsAuthentication**

In `packages/shared/src/sources/credential-manager.ts`, add at the top of the `sourceNeedsAuthentication` function (line 868, after opening brace):

```typescript
  // Nango-backed sources handle authentication externally — never prompt for local auth
  if (source.config.credentialProvider === 'nango' && source.config.nango) {
    return false;
  }
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && bun test src/sources/__tests__/token-refresh-manager.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/shared/src/sources/credential-manager.ts packages/shared/src/sources/__tests__/token-refresh-manager.test.ts
git commit -m "feat(nango): bypass local auth check for Nango-backed sources"
```

---

### Task 5: Export new types from index.ts

**Files:**
- Modify: `packages/shared/src/sources/index.ts`

**Step 1: Add exports**

Add to `packages/shared/src/sources/index.ts`, in the types section:

```typescript
export type {
  NangoSourceConfig,
} from './types.ts';
```

Add in a new section after the Token Refresh Manager exports:

```typescript
// Nango Credential Provider (optional external token provider)
export { getNangoToken } from './nango-provider.ts';
export type { NangoTokenResult } from './nango-provider.ts';
```

**Step 2: Run type check**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No type errors

**Step 3: Run all sources tests to confirm nothing is broken**

Run: `cd packages/shared && bun test src/sources/`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add packages/shared/src/sources/index.ts
git commit -m "feat(nango): export Nango types and functions from sources module"
```

---

### Task 6: Run full test suite and verify

**Files:** None (verification only)

**Step 1: Run full package test suite**

Run: `cd packages/shared && bun test`
Expected: All tests PASS

**Step 2: Run type check**

Run: `cd packages/shared && bun run tsc --noEmit`
Expected: No type errors

**Step 3: Final commit if any fixups needed**

Only if previous steps revealed issues.
