/**
 * TokenRefreshManager - Handles OAuth token refresh with rate limiting.
 *
 * This class encapsulates token refresh logic following SOLID principles:
 * - Single Responsibility: Only handles token refresh orchestration
 * - Open/Closed: Delegates to SourceCredentialManager for actual refresh
 * - Dependency Inversion: Takes credential manager as dependency
 *
 * Rate limiting is instance-scoped, not module-level, making it:
 * - Testable (can create fresh instances)
 * - Session-isolated (each session can have its own manager)
 */

import { isOAuthSource, type LoadedSource } from './types.ts';
import type { SourceCredentialManager } from './credential-manager.ts';
import { markSourceAuthenticated } from './storage.ts';
import { getNangoToken, isValidNangoSecretKey } from './nango-provider.ts';

/** Default cooldown after failed refresh (5 minutes) */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export interface TokenRefreshResult {
  /** Whether the token was successfully refreshed */
  success: boolean;
  /** The fresh token if successful */
  token?: string;
  /** Error reason if failed */
  reason?: string;
  /** Whether this was skipped due to rate limiting */
  rateLimited?: boolean;
}

export interface RefreshManagerOptions {
  /** Cooldown period after failed refresh (default: 5 minutes) */
  cooldownMs?: number;
  /** Logger function for debug output */
  log?: (message: string) => void;
}

/** Cached Nango token with expiry info */
interface CachedNangoToken {
  token: string;
  /** When this token expires (Unix ms). Undefined = no known expiry (e.g. API_KEY). */
  expiresAt?: number;
  /** When we fetched this token (Unix ms) */
  fetchedAt: number;
}

/** Refresh Nango tokens 5 minutes before expiry */
const NANGO_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** For Nango tokens without expiry (e.g. API_KEY), re-fetch every 30 minutes */
const NANGO_NO_EXPIRY_TTL_MS = 30 * 60 * 1000;

export class TokenRefreshManager {
  private failedAttempts = new Map<string, number>();
  /** Cached Nango tokens keyed by source slug */
  private nangoTokenCache = new Map<string, CachedNangoToken>();
  private cooldownMs: number;
  private log: (message: string) => void;
  private credManager: SourceCredentialManager;

  constructor(
    credManager: SourceCredentialManager,
    options: RefreshManagerOptions = {}
  ) {
    this.credManager = credManager;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.log = options.log ?? (() => {});
  }

  /**
   * Check if a source is in cooldown after a recent failed refresh.
   */
  isInCooldown(sourceSlug: string): boolean {
    const lastFailure = this.failedAttempts.get(sourceSlug);
    if (!lastFailure) return false;
    return Date.now() - lastFailure < this.cooldownMs;
  }

  /**
   * Record a failed refresh attempt for rate limiting.
   */
  private recordFailure(sourceSlug: string): void {
    this.failedAttempts.set(sourceSlug, Date.now());
  }

  /**
   * Clear the failure record when refresh succeeds.
   */
  private clearFailure(sourceSlug: string): void {
    this.failedAttempts.delete(sourceSlug);
  }

  /**
   * Clear cooldown for a source (e.g. after successful re-authentication).
   */
  clearCooldown(sourceSlug: string): void {
    this.failedAttempts.delete(sourceSlug);
  }

  /**
   * Fetch token from Nango API for Nango-backed sources.
   * Bypasses all local credential storage and refresh logic.
   *
   * On success, restores auth state (same as local OAuth path) so the source
   * can recover from transient failures without manual re-configuration.
   */
  /**
   * Check if a cached Nango token is still fresh (not expired or about to expire).
   */
  private isNangoCacheFresh(cached: CachedNangoToken): boolean {
    const now = Date.now();
    if (cached.expiresAt) {
      // Token has known expiry — use it until NANGO_REFRESH_BUFFER_MS before expiry
      return now < cached.expiresAt - NANGO_REFRESH_BUFFER_MS;
    }
    // No expiry (e.g. API_KEY) — use TTL-based staleness
    return now - cached.fetchedAt < NANGO_NO_EXPIRY_TTL_MS;
  }

  private async fetchNangoToken(source: LoadedSource): Promise<TokenRefreshResult> {
    const slug = source.config.slug;

    // Return cached token if still fresh — avoids hitting Nango rate limits.
    const cached = this.nangoTokenCache.get(slug);
    if (cached && this.isNangoCacheFresh(cached)) {
      this.log(`[TokenRefresh] Using cached Nango token for ${slug}`);
      return { success: true, token: cached.token };
    }

    const secretKey = process.env.NANGO_SECRET_KEY;

    if (!secretKey) {
      this.log(`[TokenRefresh] NANGO_SECRET_KEY not set for Nango source ${slug}`);
      return {
        success: false,
        reason: 'NANGO_SECRET_KEY environment variable is not set',
      };
    }

    // Fail fast if the key is not a UUID v4 — likely the Public Key, not Secret Key.
    if (!isValidNangoSecretKey(secretKey)) {
      const reason = 'NANGO_SECRET_KEY is not a UUID v4. This is likely the Nango Public Key, not the Secret Key. Check Nango dashboard → Settings → Secret Key.';
      this.log(`[TokenRefresh] ${reason}`);
      return { success: false, reason };
    }

    try {
      const host = source.config.nango!.host || process.env.NANGO_HOST;
      const result = await getNangoToken(
        source.config.nango!,
        secretKey,
        host
      );

      this.log(`[TokenRefresh] Got Nango token for ${slug}`);
      this.clearFailure(slug);

      // Cache the token to avoid redundant Nango API calls
      this.nangoTokenCache.set(slug, {
        token: result.accessToken,
        expiresAt: result.expiresAt,
        fetchedAt: Date.now(),
      });

      // Restore auth state — ensures recovery after transient failures.
      // Without this, a single failed fetch permanently disables the source
      // because markSourceNeedsReauth persists isAuthenticated=false to disk.
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
      source.config.isAuthenticated = true;
      source.config.connectionStatus = 'connected';
      source.config.connectionError = undefined;

      return { success: true, token: result.accessToken };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[TokenRefresh] Nango fetch failed for ${slug}: ${reason}`);
      this.recordFailure(slug);
      return { success: false, reason };
    }
  }

  /**
   * Reset all rate limiting and cache state (useful for testing).
   */
  reset(): void {
    this.failedAttempts.clear();
    this.nangoTokenCache.clear();
  }

  /**
   * Check if a source needs token refresh.
   * Returns true if the token is expired or expiring soon (within 5 min).
   */
  async needsRefresh(source: LoadedSource): Promise<boolean> {
    const cred = await this.credManager.load(source);
    if (!cred) return false;
    if (!cred.refreshToken) return false;
    // If no expiresAt, we can't determine token lifetime — proactively refresh.
    // This handles credentials stored before expiresAt defaulting was added.
    // After refresh, the new credential will have expiresAt set, preventing refresh every turn.
    if (!cred.expiresAt) return true;
    return this.credManager.isExpired(cred) || this.credManager.needsRefresh(cred);
  }

  /**
   * Ensure a source has a fresh token, refreshing if needed.
   * This is the single entry point for token refresh (DRY principle).
   *
   * @param source - The source to refresh
   * @returns Result with success status, token, or error reason
   */
  async ensureFreshToken(source: LoadedSource): Promise<TokenRefreshResult> {
    // Nango-backed sources: fetch token directly from Nango API.
    // Nango handles all token refresh server-side, so we bypass local credential logic entirely.
    if (source.config.credentialProvider === 'nango' && source.config.nango) {
      return this.fetchNangoToken(source);
    }

    const slug = source.config.slug;

    // Check rate limiting
    if (this.isInCooldown(slug)) {
      this.log(`[TokenRefresh] Skipping ${slug} - in cooldown after recent failure`);
      return {
        success: false,
        rateLimited: true,
        reason: 'Rate limited after recent failure',
      };
    }

    // Load credential and check if refresh needed
    const cred = await this.credManager.load(source);

    // Non-refreshable tokens (e.g. Slack) — return as-is.
    // Consistent with needsRefresh() which returns false when !refreshToken.
    if (cred && !cred.refreshToken) {
      return { success: true, token: cred.value };
    }

    // If credential exists, has a known expiry, and isn't near expiry, return it as-is.
    // Missing expiresAt means we can't determine lifetime — fall through to refresh
    // so the new credential gets a proper expiresAt (matching needsRefresh() logic).
    if (cred && cred.expiresAt && !this.credManager.isExpired(cred) && !this.credManager.needsRefresh(cred)) {
      return {
        success: true,
        token: cred.value,
      };
    }

    // Need to refresh
    this.log(`[TokenRefresh] Refreshing token for ${slug}`);

    try {
      const token = await this.credManager.refresh(source);

      if (token) {
        this.log(`[TokenRefresh] Successfully refreshed token for ${slug}`);
        this.clearFailure(slug);

        // Restore auth state — undoes markSourceNeedsReauth() from startup
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        source.config.isAuthenticated = true;
        source.config.connectionStatus = 'connected';
        source.config.connectionError = undefined;

        return { success: true, token };
      } else {
        const reason = 'Refresh returned null';
        this.log(`[TokenRefresh] ${reason} for ${slug}`);
        this.credManager.markSourceNeedsReauth(source, 'Token refresh failed');
        this.recordFailure(slug);
        return { success: false, reason };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[TokenRefresh] Failed for ${slug}: ${reason}`);
      this.credManager.markSourceNeedsReauth(source, `Refresh error: ${reason}`);
      this.recordFailure(slug);
      return { success: false, reason };
    }
  }

  /**
   * Get all sources that need token refresh.
   * Includes:
   * - MCP OAuth sources (e.g., Linear, Notion)
   * - API OAuth sources (Google, Slack, Microsoft)
   * - Nango-backed sources (any type — Nango handles refresh server-side)
   * Filters out sources in cooldown.
   */
  async getSourcesNeedingRefresh(sources: LoadedSource[]): Promise<LoadedSource[]> {
    // Filter to refreshable sources: OAuth sources + Nango-backed sources
    const refreshableSources = sources.filter(s =>
      isOAuthSource(s) || (s.config.credentialProvider === 'nango' && s.config.nango)
    );

    if (refreshableSources.length === 0) {
      return [];
    }

    // Check each source in parallel
    const results = await Promise.all(
      refreshableSources.map(async (source) => {
        // Skip if in cooldown
        if (this.isInCooldown(source.config.slug)) {
          this.log(`[TokenRefresh] Skipping ${source.config.slug} - in cooldown`);
          return { source, needsRefresh: false };
        }

        // Nango sources: check if cached token is still fresh
        if (source.config.credentialProvider === 'nango' && source.config.nango) {
          const cached = this.nangoTokenCache.get(source.config.slug);
          const needsRefresh = !cached || !this.isNangoCacheFresh(cached);
          return { source, needsRefresh };
        }

        const needsRefresh = await this.needsRefresh(source);
        return { source, needsRefresh };
      })
    );

    return results
      .filter(({ needsRefresh }) => needsRefresh)
      .map(({ source }) => source);
  }

  /**
   * Refresh multiple sources in parallel.
   * Returns list of sources that were successfully refreshed and list of failures.
   */
  async refreshSources(sources: LoadedSource[]): Promise<{
    refreshed: LoadedSource[];
    failed: Array<{ source: LoadedSource; reason: string }>;
  }> {
    const results = await Promise.all(
      sources.map(async (source) => {
        const result = await this.ensureFreshToken(source);
        return { source, result };
      })
    );

    const refreshed: LoadedSource[] = [];
    const failed: Array<{ source: LoadedSource; reason: string }> = [];

    for (const { source, result } of results) {
      if (result.success) {
        refreshed.push(source);
      } else if (!result.rateLimited) {
        failed.push({ source, reason: result.reason || 'Unknown error' });
      }
    }

    return { refreshed, failed };
  }
}

/**
 * Create a token getter function for API OAuth sources.
 * This wraps the refresh manager for use with the server builder.
 */
export function createTokenGetter(
  refreshManager: TokenRefreshManager,
  source: LoadedSource
): () => Promise<string> {
  return async () => {
    const result = await refreshManager.ensureFreshToken(source);
    if (result.success && result.token) {
      return result.token;
    }
    throw new Error(result.reason || `No token for ${source.config.slug}`);
  };
}
