import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { getNangoToken, listNangoConnections, isValidNangoSecretKey } from '../nango-provider.ts';

// Valid UUID v4 for use in tests
const VALID_SECRET_KEY = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';

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
      VALID_SECRET_KEY
    );

    expect(result.accessToken).toBe('nango-fresh-token-123');
    expect(result.expiresAt).toBe(new Date('2026-03-01T12:00:00.000Z').getTime());

    // Verify correct URL and headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://nango.haritowa.work/connection/user-123?provider_config_key=google-mail');
    expect(options.headers.Authorization).toBe(`Bearer ${VALID_SECRET_KEY}`);
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
      VALID_SECRET_KEY
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
      VALID_SECRET_KEY,
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
        VALID_SECRET_KEY
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
        VALID_SECRET_KEY
      )
    ).rejects.toThrow('Nango API error (404)');
  });

  test('throws early on invalid secret key without making API call', async () => {
    await expect(
      getNangoToken(
        { integrationId: 'test', connectionId: 'user-1' },
        'not-a-uuid-key'
      )
    ).rejects.toThrow('NANGO_SECRET_KEY is not a valid UUID v4');

    // Must not have called fetch at all
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('throws early on empty secret key', async () => {
    await expect(
      getNangoToken(
        { integrationId: 'test', connectionId: 'user-1' },
        ''
      )
    ).rejects.toThrow('NANGO_SECRET_KEY is not a valid UUID v4');

    expect(mockFetch).not.toHaveBeenCalled();
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
      VALID_SECRET_KEY
    );

    expect(result.accessToken).toBe('token-no-expiry');
    expect(result.expiresAt).toBeUndefined();
  });
});

describe('isValidNangoSecretKey', () => {
  test('accepts valid UUID v4', () => {
    expect(isValidNangoSecretKey('a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5')).toBe(true);
    expect(isValidNangoSecretKey('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('rejects non-UUID strings', () => {
    expect(isValidNangoSecretKey('not-a-uuid')).toBe(false);
    expect(isValidNangoSecretKey('nango_public_key_abc123')).toBe(false);
    expect(isValidNangoSecretKey('')).toBe(false);
  });

  test('rejects UUID v1 (version digit must be 4)', () => {
    // UUID v1 has '1' in the version position
    expect(isValidNangoSecretKey('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });
});

describe('listNangoConnections', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns mapped connections list', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        connections: [
          {
            id: 1,
            connection_id: 'user-123',
            provider: 'google',
            provider_config_key: 'google-mail',
            created: '2026-01-15T10:00:00.000Z',
            errors: [],
          },
          {
            id: 2,
            connection_id: 'user-456',
            provider: 'slack',
            provider_config_key: 'slack-bot',
            created: '2026-01-20T10:00:00.000Z',
            errors: [{ type: 'auth', log_id: 'log-1' }],
          },
        ],
      }), { status: 200 })
    );

    const result = await listNangoConnections(VALID_SECRET_KEY);

    expect(result).toHaveLength(2);
    expect(result[0]!.connectionId).toBe('user-123');
    expect(result[0]!.integrationId).toBe('google-mail');
    expect(result[0]!.provider).toBe('google');
    expect(result[0]!.errors).toHaveLength(0);
    expect(result[1]!.connectionId).toBe('user-456');
    expect(result[1]!.integrationId).toBe('slack-bot');
    expect(result[1]!.errors).toHaveLength(1);

    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://nango.haritowa.work/connection');
    expect(options.headers.Authorization).toBe(`Bearer ${VALID_SECRET_KEY}`);
  });

  test('returns empty array when no connections', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ connections: [] }), { status: 200 })
    );

    const result = await listNangoConnections(VALID_SECRET_KEY);
    expect(result).toHaveLength(0);
  });

  test('uses custom host', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ connections: [] }), { status: 200 })
    );

    await listNangoConnections(VALID_SECRET_KEY, 'https://nango.self-hosted.com');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://nango.self-hosted.com/connection');
  });

  test('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    expect(
      listNangoConnections(VALID_SECRET_KEY)
    ).rejects.toThrow('Nango API error (401)');
  });

  test('throws early on invalid secret key without making API call', async () => {
    await expect(
      listNangoConnections('not-a-uuid-key')
    ).rejects.toThrow('NANGO_SECRET_KEY is not a valid UUID v4');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
