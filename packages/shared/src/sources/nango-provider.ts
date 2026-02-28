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

const DEFAULT_NANGO_HOST = 'https://nango.haritowa.work';

/**
 * Nango Secret Keys are UUID v4 format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).
 * Public Keys have a different format and will cause "not a UUID v4" errors
 * on all Nango API endpoints. Both getNangoToken() and listNangoConnections()
 * reject non-UUID keys early to prevent sending invalid requests.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidNangoSecretKey(key: string): boolean {
  return UUID_V4_PATTERN.test(key);
}

export interface NangoTokenResult {
  accessToken: string;
  expiresAt?: number; // Unix timestamp in ms
}

/**
 * Fetch a fresh token from Nango's REST API.
 *
 * @param nangoConfig - Integration ID and connection ID from source config
 * @param secretKey - Nango secret key (from NANGO_SECRET_KEY env var)
 * @param host - Nango API host (defaults to https://nango.haritowa.work)
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

  // Reject early if the key doesn't look like a UUID v4 — likely the Public Key, not Secret Key.
  // This prevents sending an invalid key to the Nango server, which would return a 401 error.
  if (!isValidNangoSecretKey(secretKey)) {
    throw new Error(
      'NANGO_SECRET_KEY is not a valid UUID v4 — you may be using the Nango Public Key instead of the Secret Key. ' +
      'Check your Nango dashboard under Settings → Secret Key for the UUID v4 key.'
    );
  }

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

// ============================================================================
// List Connections
// ============================================================================

/**
 * A single Nango connection as returned by the list API.
 */
export interface NangoConnection {
  id: number;
  connectionId: string;
  provider: string;
  integrationId: string; // provider_config_key
  created: string;
  errors: Array<{ type: 'auth' | 'sync'; log_id: string }>;
}

/**
 * List all connections from Nango.
 *
 * @param secretKey - Nango secret key (from NANGO_SECRET_KEY env var)
 * @param host - Nango API host (defaults to https://nango.haritowa.work)
 * @returns Array of connections with integration and connection IDs
 */
export async function listNangoConnections(
  secretKey: string,
  host?: string
): Promise<NangoConnection[]> {
  const baseUrl = host || DEFAULT_NANGO_HOST;
  const url = `${baseUrl}/connection`;

  debug('[NangoProvider] Listing connections');

  // Reject early if the key doesn't look like a UUID v4 — prevents sending invalid keys to the server.
  if (!isValidNangoSecretKey(secretKey)) {
    throw new Error(
      'NANGO_SECRET_KEY is not a valid UUID v4 — you may be using the Nango Public Key instead of the Secret Key. ' +
      'Check your Nango dashboard under Settings → Secret Key for the UUID v4 key.'
    );
  }

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
    connections: Array<{
      id: number;
      connection_id: string;
      provider: string;
      provider_config_key: string;
      created: string;
      errors: Array<{ type: 'auth' | 'sync'; log_id: string }>;
    }>;
  };

  return data.connections.map((c) => ({
    id: c.id,
    connectionId: c.connection_id,
    provider: c.provider,
    integrationId: c.provider_config_key,
    created: c.created,
    errors: c.errors || [],
  }));
}
