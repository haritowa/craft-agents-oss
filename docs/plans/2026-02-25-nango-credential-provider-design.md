# Nango Credential Provider Integration

**Date:** 2026-02-25
**Branch:** feature/add-nango-integration

## Summary

Add Nango as an optional credential provider for sources (MCP and API). Sources are configured normally, but when `credentialProvider: "nango"` is set, tokens are fetched from Nango's REST API instead of the local encrypted credential store. Nango auto-refreshes tokens server-side, eliminating all local refresh logic for Nango-backed sources.

## Decisions

- **Approach:** Minimal addition — no refactoring of existing code, no abstraction layer
- **Integration point:** Early return in `TokenRefreshManager.ensureFreshToken()` for Nango sources
- **SDK:** Direct `fetch` call to Nango REST API (zero new dependencies)
- **Config model:** Per-source `nango.integrationId` + `nango.connectionId` in source config.json
- **UI:** Config-only (manual editing or agent-assisted), no CLI/UI changes

## API Endpoint

```
GET https://api.nango.dev/connection/{connectionId}?provider_config_key={integrationId}
Authorization: Bearer {NANGO_SECRET_KEY}
```

Response (OAuth2):
```json
{
  "credentials": {
    "type": "OAUTH2",
    "access_token": "gho_tsXLG73f...",
    "expires_at": "2024-03-08T09:43:03.725Z",
    "raw": { "scope": "public_repo,user", "token_type": "bearer" }
  }
}
```

Nango auto-refreshes expired tokens on every `GET /connection` call.

## Changes

### 1. New file: `packages/shared/src/sources/nango-provider.ts`

Exports:
- `NangoSourceConfig` type: `{ integrationId: string; connectionId: string }`
- `getNangoToken(config, secretKey, host?)` → `Promise<{ accessToken: string; expiresAt?: number }>`

Implementation: single `fetch` call to Nango REST API. Handles `OAUTH2` and `API_KEY` credential types.

### 2. Modified: `packages/shared/src/sources/types.ts`

Add to `FolderSourceConfig`:
```typescript
credentialProvider?: 'local' | 'nango';
nango?: { integrationId: string; connectionId: string };
```

### 3. Modified: `packages/shared/src/sources/token-refresh-manager.ts`

Add early return at top of `ensureFreshToken()`:
```typescript
if (source.config.credentialProvider === 'nango' && source.config.nango) {
  return this.fetchNangoToken(source);
}
```

New private method `fetchNangoToken()` calls `getNangoToken()` and returns `TokenRefreshResult`.

### 4. Modified: `packages/shared/src/sources/credential-manager.ts`

In `sourceNeedsAuthentication()`: Nango sources with valid config return `false` (auth is handled externally).

In `hasValidCredentials()`: Nango sources with valid config return `true`.

### 5. Modified: `packages/shared/src/sources/index.ts`

Export `NangoSourceConfig` type and `getNangoToken` function.

### 6. Environment variables

```env
NANGO_SECRET_KEY=<nango-secret-key>
NANGO_HOST=https://api.nango.dev  # optional, for self-hosted
```

## What stays untouched

- `CredentialManager` (encrypted storage)
- `SourceCredentialManager` CRUD methods (save/load/delete)
- `SourceServerBuilder` (receives tokens from ensureFreshToken already)
- All existing OAuth flows (Google, Slack, Microsoft, MCP)
- `credentials.enc` — Nango sources never write to it

## Source config examples

### API source with Nango

```json
{
  "type": "api",
  "name": "Gmail",
  "slug": "gmail",
  "provider": "google",
  "enabled": true,
  "credentialProvider": "nango",
  "nango": {
    "integrationId": "google-mail",
    "connectionId": "user-123"
  },
  "api": {
    "baseUrl": "https://gmail.googleapis.com",
    "authType": "bearer",
    "googleService": "gmail"
  }
}
```

### MCP source with Nango

```json
{
  "type": "mcp",
  "name": "GitHub",
  "slug": "github",
  "provider": "github",
  "enabled": true,
  "credentialProvider": "nango",
  "nango": {
    "integrationId": "github",
    "connectionId": "user-123"
  },
  "mcp": {
    "transport": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "authType": "bearer"
  }
}
```
