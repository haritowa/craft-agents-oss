# Deep Nango Integration — Seamless Dual-Mode

**Date:** 2026-02-27
**Branch:** feature/add-nango-integration

## Summary

Deepen the existing Nango integration so it complements (not fights with) native Craft Agents features. Both Nango and local auth become equal citizens. The agent intelligently picks the best one based on context: if a matching Nango connection exists, offer it first; otherwise, proceed with local OAuth.

## Decisions

- **Mode:** Seamless dual-mode — Nango and local auth are equal citizens
- **Auto-detection:** Every source setup checks `nango_list_connections` first when `NANGO_SECRET_KEY` is set
- **Verification:** `source_test` calls `getNangoToken()` to prove Nango connections work
- **Fallback:** No fallback. If Nango is configured and fails, fail clearly. User can manually switch to local auth.
- **Approach:** Surgical enhancements to existing integration points. No new abstractions, no architecture changes.

## Changes

### 1. Source Setup Flow — Nango Auto-Detection

**File:** `apps/electron/resources/docs/sources.md`

Current behavior: Agent follows `sources.md` which mentions Nango as an afterthought at step 6. The agent only uses Nango if the user explicitly asks.

New behavior: When `NANGO_SECRET_KEY` is set, the source setup flow becomes:

1. Search for specialized source guide (unchanged)
2. Understand user intent (unchanged)
3. **Auto-detect Nango connections** — call `nango_list_connections` with a search matching the provider. If matching connections found, offer them to the user.
4. If user accepts → set `credentialProvider: 'nango'`, skip local auth entirely
5. If user declines or no match → proceed with local OAuth as usual
6. Continue with guide.md, permissions.json, source_test (unchanged)

### 2. `source_test` Full Nango Verification

**File:** `packages/session-tools-core/src/handlers/source-test.ts`

Current behavior: `checkAuthStatus()` early-returns for Nango sources with just a config check. No actual API call.

New behavior: When testing a Nango source:

1. Verify `NANGO_SECRET_KEY` is set → error if missing
2. Validate key is UUID v4 → warn about public key vs secret key
3. Call `getNangoToken()` with the source's Nango config
4. On success: report token type (OAuth2/API_KEY), expiry time, mark `isAuthenticated: true`, `connectionStatus: 'connected'`
5. On failure: report Nango error, mark `connectionStatus: 'failed'`, `connectionError` with details

### 3. `hasValidCredentials()` Fix

**File:** `packages/shared/src/sources/credential-manager.ts`

Current behavior: `hasValidCredentials()` only checks local credential store. Nango sources return `false` (no local token), which can incorrectly show "needs auth" in UI.

New behavior: Early return for Nango sources:
```typescript
if (source.config.credentialProvider === 'nango' && source.config.nango) {
  return true; // Nango manages credentials externally
}
```

### 4. System Prompt — Nango Availability Hint

**File:** `packages/shared/src/prompts/system.ts`

Current behavior: System prompt lists sources and their auth status but never mentions Nango availability.

New behavior: When `NANGO_SECRET_KEY` is present in the environment, append to the sources context:
```
Nango credential provider is available (NANGO_SECRET_KEY is set).
When setting up new sources, check for matching Nango connections first
using nango_list_connections before starting local OAuth flows.
```

### 5. Session-Scoped Tools — Nango Awareness

**File:** `packages/shared/src/agent/session-scoped-tools.ts`

Current behavior: OAuth triggers and `source_credential_prompt` don't know about Nango. Triggering local OAuth on a Nango source silently proceeds.

New behavior:

1. **OAuth triggers + credential prompt**: If the source has `credentialProvider: 'nango'`, return a clear message instead of proceeding:
   > "This source uses Nango for authentication (integrationId: {id}). Local auth is not needed. To switch to local auth, remove credentialProvider and nango from the source config."

2. **`nango_configure_source`**: After configuring, clear any stale local credentials for that source.

### 6. Docker Environment — Pass Nango Env Vars

**File:** `packages/shared/src/agent/docker-env.ts`

Current behavior: Docker containers don't receive `NANGO_SECRET_KEY` or `NANGO_HOST`.

New behavior: Forward `NANGO_SECRET_KEY` and `NANGO_HOST` to containers when set on the host.

### 7. Server Builder — Clear Nango Errors

**File:** `packages/shared/src/sources/server-builder.ts`

Current behavior: Nango token failures return `null` with a generic debug log. No clear error surfaces.

New behavior: Add Nango-specific error to the `errors` array:
> "Nango token fetch failed for {slug} (integrationId: {id}). Check NANGO_SECRET_KEY and Nango connection status."

No fallback to local credentials.

### 8. Sources Documentation Update

**File:** `apps/electron/resources/docs/sources.md`

Weave Nango into the main flow:
- Step 3 (Configure Intelligently) mentions checking Nango first
- Step 6 (Test and Validate) notes Nango sources get full token verification
- Add guidance: "If NANGO_SECRET_KEY is detected, always call nango_list_connections before offering local OAuth"

## What stays untouched

- `nango-provider.ts` — already complete
- `token-refresh-manager.ts` — already handles Nango correctly
- `CredentialManager` encrypted storage — Nango sources don't use it
- All existing OAuth flows (Google, Slack, Microsoft, MCP)
- Source config schema — `credentialProvider` and `nango` fields already exist
- `sources/index.ts` exports — already complete

## File Summary

| # | File | Change |
|---|------|--------|
| 1 | `apps/electron/resources/docs/sources.md` | Nango auto-detection in setup flow + docs update |
| 2 | `packages/session-tools-core/src/handlers/source-test.ts` | Full Nango verification via `getNangoToken()` |
| 3 | `packages/shared/src/sources/credential-manager.ts` | Fix `hasValidCredentials()` for Nango |
| 4 | `packages/shared/src/prompts/system.ts` | Nango availability hint in system prompt |
| 5 | `packages/shared/src/agent/session-scoped-tools.ts` | OAuth/credential tools warn on Nango sources |
| 6 | `packages/shared/src/agent/docker-env.ts` | Forward Nango env vars to containers |
| 7 | `packages/shared/src/sources/server-builder.ts` | Clear Nango error messages |

8 changes, 7 files, no new files, no new dependencies, no architecture changes.
