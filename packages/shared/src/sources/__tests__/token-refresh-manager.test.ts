/**
 * Unit tests for TokenRefreshManager and isOAuthSource helper.
 *
 * Tests the proactive token refresh functionality that includes both:
 * - MCP OAuth sources (Linear, Notion, etc.)
 * - API OAuth sources (Google, Slack, Microsoft)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { isOAuthSource, type LoadedSource, type FolderSourceConfig } from '../types.ts';
import { TokenRefreshManager } from '../token-refresh-manager.ts';
import { sourceNeedsAuthentication, type SourceCredentialManager } from '../credential-manager.ts';

// Mock storage module to prevent disk I/O
const mockMarkSourceAuthenticated = mock(() => true);
mock.module('../storage.ts', () => ({
  markSourceAuthenticated: mockMarkSourceAuthenticated,
}));

/**
 * Helper to create a mock LoadedSource for testing
 */
function createMockSource(overrides: Partial<FolderSourceConfig>): LoadedSource {
  const config: FolderSourceConfig = {
    id: 'test-id',
    name: 'Test Source',
    slug: 'test-source',
    enabled: true,
    provider: 'test',
    type: 'api',
    isAuthenticated: true,
    ...overrides,
  };

  return {
    config,
    guide: null,
    folderPath: '/mock/path',
    workspaceRootPath: '/mock/workspace',
    workspaceId: 'mock-workspace',
  };
}

describe('isOAuthSource', () => {
  describe('MCP OAuth sources', () => {
    test('returns true for MCP source with oauth authType', () => {
      const source = createMockSource({
        type: 'mcp',
        provider: 'linear',
        mcp: {
          url: 'https://linear.mcp.example.com',
          authType: 'oauth',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns false for MCP source with bearer authType', () => {
      const source = createMockSource({
        type: 'mcp',
        provider: 'custom',
        mcp: {
          url: 'https://custom.mcp.example.com',
          authType: 'bearer',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });

    test('returns false for MCP source with none authType', () => {
      const source = createMockSource({
        type: 'mcp',
        provider: 'public',
        mcp: {
          url: 'https://public.mcp.example.com',
          authType: 'none',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });

    test('returns false for stdio MCP source (no authType)', () => {
      const source = createMockSource({
        type: 'mcp',
        provider: 'local-tool',
        mcp: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });
  });

  describe('API OAuth sources', () => {
    test('returns true for Google provider (Gmail)', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: {
          baseUrl: 'https://gmail.googleapis.com/gmail/v1',
          authType: 'bearer',
          googleService: 'gmail',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns true for Slack provider', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'slack',
        api: {
          baseUrl: 'https://slack.com/api',
          authType: 'bearer',
          slackService: 'full',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns true for Microsoft provider', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'microsoft',
        api: {
          baseUrl: 'https://graph.microsoft.com/v1.0',
          authType: 'bearer',
          microsoftService: 'outlook',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns false for non-OAuth API provider', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'custom-api',
        api: {
          baseUrl: 'https://api.example.com',
          authType: 'bearer',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });

    test('returns false for API source with header auth', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'custom-api',
        api: {
          baseUrl: 'https://api.example.com',
          authType: 'header',
          headerName: 'X-API-Key',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });
  });

  describe('Authentication state', () => {
    test('returns true for unauthenticated MCP OAuth source (type check only)', () => {
      const source = createMockSource({
        type: 'mcp',
        provider: 'linear',
        mcp: {
          url: 'https://linear.mcp.example.com',
          authType: 'oauth',
        },
        isAuthenticated: false,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns true for unauthenticated Google source (type check only)', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: {
          baseUrl: 'https://gmail.googleapis.com/gmail/v1',
          authType: 'bearer',
        },
        isAuthenticated: false,
      });

      expect(isOAuthSource(source)).toBe(true);
    });

    test('returns true even if isAuthenticated is undefined (type check only)', () => {
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: {
          baseUrl: 'https://gmail.googleapis.com/gmail/v1',
          authType: 'bearer',
        },
      });
      // Remove isAuthenticated to simulate undefined
      delete (source.config as Partial<FolderSourceConfig>).isAuthenticated;

      expect(isOAuthSource(source)).toBe(true);
    });
  });

  describe('Local sources', () => {
    test('returns false for local filesystem source', () => {
      const source = createMockSource({
        type: 'local',
        provider: 'filesystem',
        local: {
          path: '/Users/test/documents',
        },
        isAuthenticated: true,
      });

      expect(isOAuthSource(source)).toBe(false);
    });
  });
});

describe('OAuth source filtering', () => {
  test('filters mixed sources to only OAuth sources', () => {
    const sources: LoadedSource[] = [
      // MCP OAuth - should be included
      createMockSource({
        slug: 'linear',
        type: 'mcp',
        provider: 'linear',
        mcp: { url: 'https://linear.example.com', authType: 'oauth' },
        isAuthenticated: true,
      }),
      // Google API - should be included
      createMockSource({
        slug: 'gmail',
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://gmail.googleapis.com', authType: 'bearer' },
        isAuthenticated: true,
      }),
      // Non-OAuth API - should NOT be included
      createMockSource({
        slug: 'custom-api',
        type: 'api',
        provider: 'custom',
        api: { baseUrl: 'https://api.custom.com', authType: 'bearer' },
        isAuthenticated: true,
      }),
      // MCP bearer - should NOT be included
      createMockSource({
        slug: 'mcp-bearer',
        type: 'mcp',
        provider: 'custom',
        mcp: { url: 'https://custom.mcp.com', authType: 'bearer' },
        isAuthenticated: true,
      }),
      // Slack - should be included
      createMockSource({
        slug: 'slack',
        type: 'api',
        provider: 'slack',
        api: { baseUrl: 'https://slack.com/api', authType: 'bearer' },
        isAuthenticated: true,
      }),
      // Unauthenticated Google - should be included (isOAuthSource is a type check)
      createMockSource({
        slug: 'google-calendar',
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://calendar.googleapis.com', authType: 'bearer' },
        isAuthenticated: false,
      }),
    ];

    const oauthSources = sources.filter(isOAuthSource);

    expect(oauthSources.length).toBe(4);
    expect(oauthSources.map(s => s.config.slug)).toEqual(['linear', 'gmail', 'slack', 'google-calendar']);
  });
});

// --- TokenRefreshManager tests ---

function createMockCredManager(overrides: Partial<SourceCredentialManager> = {}): SourceCredentialManager {
  return {
    load: mock(() => Promise.resolve(null)),
    refresh: mock(() => Promise.resolve(null)),
    isExpired: mock(() => true),
    needsRefresh: mock(() => true),
    markSourceNeedsReauth: mock(() => {}),
    ...overrides,
  } as unknown as SourceCredentialManager;
}

describe('TokenRefreshManager', () => {
  beforeEach(() => {
    mockMarkSourceAuthenticated.mockClear();
  });

  describe('needsRefresh', () => {
    test('returns false when credential has no refreshToken', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          expiresAt: Date.now() - 60_000, // expired
          // no refreshToken
        })),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'mcp',
        provider: 'linear',
        mcp: { url: 'https://linear.example.com', authType: 'oauth' },
        isAuthenticated: false,
      });

      expect(await manager.needsRefresh(source)).toBe(false);
    });

    test('returns true when credential has refreshToken and is expired', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-token-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://gmail.googleapis.com', authType: 'bearer' },
        isAuthenticated: true,
      });

      expect(await manager.needsRefresh(source)).toBe(true);
    });
  });

  describe('getSourcesNeedingRefresh', () => {
    test('includes isAuthenticated: false source with refresh token', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
      });

      const result = await manager.getSourcesNeedingRefresh([source]);
      expect(result.length).toBe(1);
      expect(result[0]!.config.slug).toBe('craft-mcp');
    });

    test('includes Nango-backed source regardless of credential state', async () => {
      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);

      const source = createMockSource({
        slug: 'todoist',
        type: 'mcp',
        provider: 'todoist',
        mcp: { url: 'https://ai.todoist.net/mcp', authType: 'bearer' },
        isAuthenticated: true,
        credentialProvider: 'nango',
        nango: { integrationId: 'todoist', connectionId: 'user-1' },
      });

      const result = await manager.getSourcesNeedingRefresh([source]);
      expect(result.length).toBe(1);
      expect(result[0]!.config.slug).toBe('todoist');
      // Should NOT call credManager.load — Nango bypasses local credentials
      expect(credManager.load).not.toHaveBeenCalled();
    });

    test('includes Nango-backed API source in refresh list', async () => {
      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);

      const source = createMockSource({
        slug: 'exa',
        type: 'api',
        provider: 'exa',
        api: { baseUrl: 'https://api.exa.ai', authType: 'bearer' },
        isAuthenticated: true,
        credentialProvider: 'nango',
        nango: { integrationId: 'exa', connectionId: 'user-1' },
      });

      const result = await manager.getSourcesNeedingRefresh([source]);
      expect(result.length).toBe(1);
    });

    test('excludes source without refresh token', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          expiresAt: Date.now() - 60_000,
          // no refreshToken
        })),
        isExpired: mock(() => true),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
      });

      const result = await manager.getSourcesNeedingRefresh([source]);
      expect(result.length).toBe(0);
    });
  });

  describe('ensureFreshToken', () => {
    test('restores isAuthenticated on successful refresh', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.resolve('new-fresh-token')),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
        connectionError: 'Token expired',
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('new-fresh-token');
      expect(source.config.isAuthenticated).toBe(true);
      expect(source.config.connectionStatus).toBe('connected');
      expect(source.config.connectionError).toBeUndefined();
      expect(mockMarkSourceAuthenticated).toHaveBeenCalledWith('/mock/workspace', 'craft-mcp');
    });

    test('does NOT restore auth on failed refresh', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.resolve(null)),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(false);
      expect(source.config.isAuthenticated).toBe(false);
      expect(mockMarkSourceAuthenticated).not.toHaveBeenCalled();
    });
  });

  describe('end-to-end', () => {
    test('expired source recovered without re-auth', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        needsRefresh: mock(() => true),
        refresh: mock(() => Promise.resolve('fresh-token')),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
        connectionError: 'Token expired',
      });

      // Step 1: getSourcesNeedingRefresh includes the expired source
      const needingRefresh = await manager.getSourcesNeedingRefresh([source]);
      expect(needingRefresh.length).toBe(1);

      // Step 2: refreshSources refreshes and restores auth state
      const { refreshed, failed } = await manager.refreshSources(needingRefresh);
      expect(refreshed.length).toBe(1);
      expect(failed.length).toBe(0);

      // Step 3: Verify auth state is restored
      expect(source.config.isAuthenticated).toBe(true);
      expect(source.config.connectionStatus).toBe('connected');
      expect(source.config.connectionError).toBeUndefined();
      expect(mockMarkSourceAuthenticated).toHaveBeenCalledWith('/mock/workspace', 'craft-mcp');
    });
  });

  describe('Nango credential provider', () => {
    const originalFetch = globalThis.fetch;
    let mockFetch: ReturnType<typeof mock>;
    // Valid UUID v4 for tests (required by isValidNangoSecretKey validation)
    const VALID_NANGO_KEY = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';

    beforeEach(() => {
      mockFetch = mock();
      globalThis.fetch = mockFetch as any;
      process.env.NANGO_SECRET_KEY = VALID_NANGO_KEY;
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
      expect(credManager.load).not.toHaveBeenCalled();
      expect(credManager.refresh).not.toHaveBeenCalled();
    });

    test('restores auth state on successful Nango token fetch', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'fresh-token',
            expires_at: '2026-03-01T12:00:00.000Z',
          },
        }), { status: 200 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'todoist',
        type: 'mcp',
        provider: 'todoist',
        mcp: { url: 'https://ai.todoist.net/mcp', authType: 'bearer' },
        credentialProvider: 'nango',
        nango: { integrationId: 'todoist', connectionId: 'user-1' },
        // Start with failed auth state (simulates recovery after transient failure)
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
        connectionError: 'Token missing or expired',
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('fresh-token');
      // Auth state should be restored
      expect(source.config.isAuthenticated).toBe(true);
      expect(source.config.connectionStatus).toBe('connected');
      expect(source.config.connectionError).toBeUndefined();
      expect(mockMarkSourceAuthenticated).toHaveBeenCalledWith('/mock/workspace', 'todoist');
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

    test('returns failure with clear message when NANGO_SECRET_KEY is not UUID v4', async () => {
      process.env.NANGO_SECRET_KEY = 'not-a-uuid-public-key';

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'test', connectionId: 'user-1' },
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('not a UUID v4');
      expect(result.reason).toContain('Secret Key');
      // Should NOT call fetch — fail fast before network request
      expect(mockFetch).not.toHaveBeenCalled();
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
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('local-token');
      expect(credManager.load).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('caches Nango token and reuses on subsequent calls', async () => {
      // First call: fetch from Nango API
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'cached-token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
          },
        }), { status: 200 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'google-mail', connectionId: 'user-1' },
      });

      const result1 = await manager.ensureFreshToken(source);
      expect(result1.success).toBe(true);
      expect(result1.token).toBe('cached-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call: should use cache, no additional fetch
      const result2 = await manager.ensureFreshToken(source);
      expect(result2.success).toBe(true);
      expect(result2.token).toBe('cached-token');
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still just 1 call
    });

    test('re-fetches Nango token when cache expires', async () => {
      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'slack', connectionId: 'user-1' },
      });

      // First call: token that expires very soon (within refresh buffer)
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'old-token',
            expires_at: new Date(Date.now() + 60_000).toISOString(), // Expires in 1 minute (within 5min buffer)
          },
        }), { status: 200 })
      );

      const result1 = await manager.ensureFreshToken(source);
      expect(result1.token).toBe('old-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call: cache is stale (within refresh buffer), should re-fetch
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'fresh-token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        }), { status: 200 })
      );

      const result2 = await manager.ensureFreshToken(source);
      expect(result2.token).toBe('fresh-token');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('reset() clears Nango token cache', async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          credentials: {
            type: 'OAUTH2',
            access_token: 'token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        }), { status: 200 })
      );

      const credManager = createMockCredManager();
      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        credentialProvider: 'nango',
        nango: { integrationId: 'test', connectionId: 'user-1' },
      });

      await manager.ensureFreshToken(source);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Reset clears cache
      manager.reset();

      await manager.ensureFreshToken(source);
      expect(mockFetch).toHaveBeenCalledTimes(2); // Fetched again after reset
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
});

describe('sourceNeedsAuthentication with Nango', () => {
  test('returns false for Nango-backed MCP source even when not locally authenticated', () => {
    const source = createMockSource({
      type: 'mcp',
      provider: 'github',
      mcp: { url: 'https://api.github.com/mcp', authType: 'bearer' },
      credentialProvider: 'nango',
      nango: { integrationId: 'github', connectionId: 'user-1' },
      isAuthenticated: false,
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
