# Figma MCP Integration

## Feature Summary and Motivation

AI coding agents currently lack visibility into design artifacts during development. When a developer task references a Figma design, the agent must either be told the details manually or work without them. This integration exposes the Figma REST API through MCP tools, allowing agents to read design files, inspect specific nodes, export frames as images, read comments, and access design tokens (styles and variables).

**Ticket:** (Jira ticket to be inserted when available)

---

## Architecture Decisions

### 1. New `FigmaClient` service class (pure API client)

Follow the existing pattern: `GitHubClient` lives in `src/services/github/github-client.ts`, `JiraClient` in `src/services/jira/jira-client.ts`. A new `FigmaClient` goes in `src/services/figma/figma-client.ts`. It is a pure HTTP client with **no MCP awareness** — just fetch wrappers and response type definitions.

**Decision:** Create `src/services/figma/figma-client.ts` with typed methods for each Figma API endpoint. Export from `src/services/index.ts`.

### 2. New `figma` integration module

Follow the existing `src/integrations/github/` structure exactly:

```
src/integrations/figma/
  index.ts        # FigmaModule class (IntegrationModule<{ figma: FigmaClient }>)
  module.ts       # Zod schemas, handler factories, tool descriptors
  module.test.ts  # Handler tests with mock FigmaClient
  index.test.ts   # FigmaModule tests (needsEnv, tool count, etc.)
```

### 3. Static module registration

The module registry at `src/integrations/index.ts` uses explicit static imports. The `FigmaModule` will be added as a third entry in the `modules` array.

### 4. No pagination needed

All Figma endpoints return complete payloads in a single response (no cursor/offset pagination to implement). The Figma API rate limit (200 req/min) is handled by the service-level error reporting, not by client-side throttling.

### 5. No resource or prompt handlers initially

The GitHub module provides a `getResourceHandler` (for `github://prs/<issueKey>`), but Figma has no equivalent URI scheme that maps naturally to agent workflows. Resources and prompts can be added later if a use case emerges. The `getResourceHandler` and `getPromptHandler` methods will not be implemented on `FigmaModule`.

### 6. Image URLs returned as text, not fetched

`figma_get_images` returns presigned S3 URLs (ephemeral, typically expire within minutes). The MCP tool returns these URLs as JSON text — it does NOT download or proxy the images. The AI agent can present the URLs for the user to open in a browser.

---

## API Contracts

### FigmaClient (service layer)

#### Constructor

```typescript
constructor()  // reads process.env.FIGMA_TOKEN
```

Throws if `FIGMA_TOKEN` is missing or empty.

#### Methods

| Method | Figma API Endpoint | Return Type |
|---|---|---|
| `getMe()` | `GET /v1/me` | `FigmaUser` |
| `getFile(fileKey)` | `GET /v1/files/:key` | `FigmaFileResponse` |
| `getNodes(fileKey, ids)` | `GET /v1/files/:key/nodes?ids=...` | `FigmaNodesResponse` |
| `getImages(fileKey, ids, format?, scale?)` | `GET /v1/images/:key?ids=...&format=...&scale=...` | `FigmaImagesResponse` |
| `getComments(fileKey)` | `GET /v1/files/:key/comments` | `FigmaComment[]` |
| `getStyles(fileKey)` | `GET /v1/files/:key/styles` | `FigmaStyle[]` |
| `getVariables(fileKey)` | `GET /v1/files/:key/variables/local` | `FigmaVariablesResponse` |
| `getVersions(fileKey)` | `GET /v1/files/:key/versions` | `FigmaVersion[]` |

**Auth header:** `X-Figma-Token: <token>` (NOT `Authorization: Bearer`)

**Base URL:** `https://api.figma.com`

**Error handling:** Every method throws `Error` with HTTP status and response body on non-2xx. The integration module's tool handlers catch these errors and wrap as `McpError` with `ErrorCode.InternalError`.

#### Return Types (defined in `figma-client.ts`)

```typescript
interface FigmaUser {
  id: string;
  email: string;
  handle: string;
  img_url: string;
}

interface FigmaFileResponse {
  name: string;
  lastModified: string;
  thumbnailUrl?: string;
  version: string;
  document: Record<string, unknown>;  // full node tree
  components?: Record<string, unknown>;
  componentSets?: Record<string, unknown>;
  schemaVersion: number;
  styles?: Record<string, unknown>;
}

interface FigmaNodesResponse {
  nodes: Record<string, {
    document: Record<string, unknown>;
    components?: Record<string, unknown>;
    componentSets?: Record<string, unknown>;
    schemaVersion: number;
    styles?: Record<string, unknown>;
  }>;
}

interface FigmaImagesResponse {
  images: Record<string, string | null>;  // node ID → presigned URL or null
  err?: string;
}

interface FigmaComment {
  id: string;
  message: string;
  file_key: string;
  parent_id?: string;
  user: { id: string; handle: string; img_url: string };
  created_at: string;
  resolved_at?: string;
  order_id?: string;
}

interface FigmaStyle {
  key: string;
  name: string;
  style_type: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  description: string;
  // Additional metadata fields returned by API
  [key: string]: unknown;
}

interface FigmaVariablesResponse {
  status: number;
  error?: boolean;
  meta: {
    variableCollections: Record<string, {
      id: string;
      name: string;
      modes: Array<{ modeId: string; name: string }>;
      defaultModeId: string;
      remote: boolean;
      key: string;
      variableIds: string[];
    }>;
    variables: Record<string, {
      id: string;
      name: string;
      key: string;
      variableCollectionId: string;
      remote: boolean;
      resolvedType: string;
      valuesByMode: Record<string, unknown>;
      description: string;
      scopes?: string[];
    }>;
  };
}

interface FigmaVersion {
  id: string;
  created_at: string;
  label?: string;
  description?: string;
  user: { id: string; handle: string };
}
```

The types marked `[key: string]: unknown` accept the full API payload and pass it through. The integration module returns the raw response JSON — no reshaping beyond standard JSON serialization. This keeps the service layer faithful to the API and avoids schema drift.

### MCP Tool Contracts

All tools accept a flat JSON object and return `{ content: [{ type: 'text', text: string }] }`.

#### `figma_get_me`

No parameters. Returns the authenticated user profile.

**Response shape:** `FigmaUser` (plain object, not paginated)

```json
{
  "id": "abc123",
  "email": "user@example.com",
  "handle": "username",
  "img_url": "https://figma-alpha-api.s3.amazonaws.com/..."
}
```

#### `figma_get_file`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL (e.g., `ABC123def456`). |

**Response shape:** `FigmaFileResponse` (plain object)

#### `figma_get_nodes`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL. |
| `ids` | `string` | Yes | Comma-separated node IDs (e.g., `1:2,3:4`). |

**Response shape:** `FigmaNodesResponse` (plain object)

#### `figma_get_images`

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `fileKey` | `string` | Yes | — | Figma file key from URL. |
| `ids` | `string` | Yes | — | Comma-separated node IDs to export. |
| `format` | `string` | No | `png` | Export format. One of `png`, `svg`, `pdf`. |
| `scale` | `number` | No | `1` | Export scale 1–4. Only applies to PNG format. |

**Response shape:** `FigmaImagesResponse` (plain object with `images` map of node ID → URL)

#### `figma_get_comments`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL. |

**Response shape:** Array of `FigmaComment` (plain JSON array)

#### `figma_get_styles`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL. |

**Response shape:** Array of `FigmaStyle` (plain JSON array)

#### `figma_get_variables`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL. |

**Response shape:** `FigmaVariablesResponse` (plain object with `meta` containing `variableCollections` and `variables`)

#### `figma_get_versions`

| Param | Type | Required | Description |
|---|---|---|---|
| `fileKey` | `string` | Yes | Figma file key from URL. |

**Response shape:** Array of `FigmaVersion` (plain JSON array)

---

## File Structure

### New files to create

| File | Purpose |
|---|---|
| `src/services/figma/figma-client.ts` | `FigmaClient` class — all API methods, type definitions |
| `src/integrations/figma/module.ts` | Zod schemas, handler factories, tool descriptors |
| `src/integrations/figma/index.ts` | `FigmaModule` class implementing `IntegrationModule` |
| `src/integrations/figma/module.test.ts` | Tests for each handler with mock `FigmaClient` |
| `src/integrations/figma/index.test.ts` | Tests for `FigmaModule` (needsEnv, tool count, handler delegation) |

### Existing files to modify

| File | What to change |
|---|---|
| `src/services/index.ts` | Add export of `FigmaClient` and its types |
| `src/integrations/index.ts` | Import `FigmaModule`, add to `modules` array |
| `src/mcp-server.ts` | Add `figmaActive` check, `clients.figma` creation, update log message |
| `src/mcp-health.ts` | Add `figma` boolean to `HealthResult.integrations` |
| `src/mcp-server.test.ts` | Add `FigmaClient` to the mock in `vi.mock('./services/index.js')` |
| `src/integrations/index.test.ts` | Add test coverage for `figma` module presence in registry |

### Files that explicitly do NOT need changes

| File | Reason |
|---|---|
| `src/services/config.ts` | Figma reads env var directly (same pattern as GitHub) |
| `src/mcp-config.ts` | No Figma-specific config needed (same pattern as GitHub) |
| `.env.example` | Already has `FIGMA_TOKEN` entry |
| `README.md` | Config table already shows `FIGMA_TOKEN` |

---

## Implementation Steps

### Step 1: Service layer — `FigmaClient`

**File to create:** `src/services/figma/figma-client.ts`

1. Define all response types: `FigmaUser`, `FigmaFileResponse`, `FigmaNodesResponse`, `FigmaImagesResponse`, `FigmaComment`, `FigmaStyle`, `FigmaVariablesResponse`, `FigmaVersion`.
2. Create `FigmaClient` class:
   - Constructor reads `process.env.FIGMA_TOKEN`, throws if missing/empty.
   - Private `request<T>(path, options?)` helper that prepends `https://api.figma.com`, sets `X-Figma-Token` header, calls `fetch()`, throws on non-2xx with status + body text.
   - Public method for each endpoint (8 methods total).
   - Each method is a thin wrapper: `return this.request<T>(path)`.
3. The `getImages` method accepts optional `format` and `scale` query params.
4. The `getNodes` method accepts `ids` as a comma-separated string (passed directly as query param).

**File to modify:** `src/services/index.ts`

1. Add: `export { FigmaClient } from './figma/figma-client.js';`
2. Add type exports for all Figma response types.

### Step 2: Integration module — `module.ts`

**File to create:** `src/integrations/figma/module.ts`

1. Define `figmaGetMeSchema`: `z.object({})` — no params.
2. Define `figmaGetFileSchema`: `z.object({ fileKey: z.string().min(1).max(50).describe(...) })`.
3. Define `figmaGetNodesSchema`: same `fileKey` + `ids: z.string().min(1).max(500).describe(...)`.
4. Define `figmaGetImagesSchema`: `fileKey`, `ids`, optional `format` (enum `png|svg|pdf`, default `png`), optional `scale` (number 1–4, default 1).
5. Define `figmaGetCommentsSchema`: `fileKey` only.
6. Define `figmaGetStylesSchema`: `fileKey` only.
7. Define `figmaGetVariablesSchema`: `fileKey` only.
8. Define `figmaGetVersionsSchema`: `fileKey` only.
9. Define `ToolHandler` type: `(clients: { figma: FigmaClient }) => (args: T) => Promise<...>`.
10. Create 8 handler factories, one per tool. Each handler:
    - Parses args with its Zod schema
    - Calls the corresponding `FigmaClient` method
    - Returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
    - Wraps client errors as `McpError(ErrorCode.InternalError, ...)`
11. Export `figmaToolDescriptors` array with `zodToJsonSchema()` for each schema.

All `fileKey` parameters use `.describe('Figma file key from URL (e.g., "ABC123def456").')`.

### Step 3: Integration module — `index.ts`

**File to create:** `src/integrations/figma/index.ts`

1. Import `FigmaClient`, `IntegrationModule`, `ToolHandlerFn`, `ToolDescriptor`.
2. Import all handlers, schemas, and `figmaToolDescriptors` from `./module.js`.
3. Create `FigmaModule` class:
   - `readonly id = 'figma'`
   - `needsEnv()` returns `!!process.env.FIGMA_TOKEN`
   - `createToolHandlers()` delegates each tool to its handler factory with parsed args
   - `getToolDescriptors()` returns `figmaToolDescriptors`
   - No `getResourceHandler` or `getPromptHandler` overrides

### Step 4: Module registry

**File to modify:** `src/integrations/index.ts`

1. Add: `import { FigmaModule } from './figma/index.js';`
2. Add to `modules` array: `new FigmaModule()`

Result: `export const modules = [new JiraModule(), new GitHubModule(), new FigmaModule()];`

### Step 5: Bootstrap — `mcp-server.ts`

**File to modify:** `src/mcp-server.ts`

1. Import `FigmaClient` from `./services/index.js` at the top.
2. Add `figmaActive` check after the `githubActive` check:
   ```typescript
   const figmaActive = !!process.env.FIGMA_TOKEN;
   ```
3. Add log line: ``log(`Figma integration: ${figmaActive ? 'active' : 'inactive'}`);``
4. Add client instantiation block after GitHub:
   ```typescript
   if (figmaActive) {
     try {
       clients.figma = new FigmaClient();
       log('FigmaClient created successfully');
     } catch (err) {
       log(`Failed to create FigmaClient: ${err instanceof Error ? err.message : String(err)}`);
     }
   }
   ```
5. Update the `createHealthHandler` call to include the figma active flag.

### Step 6: Health handler — `mcp-health.ts`

**File to modify:** `src/mcp-health.ts`

1. Update `HealthResult.integrations` to include `figma: boolean`.
2. Update `createHealthHandler` signature to accept `figmaActive: boolean`.
3. Set `integrations.figma` in the result object.
4. Update all call sites (only `mcp-server.ts`).

### Step 7: Tests

**File to create:** `src/integrations/figma/module.test.ts`

- Mock `FigmaClient` at the top using `vi.mock('../../services/index.js', ...)`.
- Create a `makeMockFigma()` factory returning vi.fn() stubs for all 8 methods.
- Test each handler factory:
  - `figmaGetMeHandler` — call with no args, verify `getMe` called, verify shape of response.
  - `figmaGetFileHandler` — call with valid `fileKey`, verify `getFile` called with that key.
  - `figmaGetNodesHandler` — call with `fileKey` + `ids`, verify `getNodes` called with both.
  - `figmaGetImagesHandler` — test with defaults, test with custom format+scale.
  - `figmaGetCommentsHandler` — call with `fileKey`, verify correct delegation.
  - `figmaGetStylesHandler` — call with `fileKey`, verify correct delegation.
  - `figmaGetVariablesHandler` — call with `fileKey`, verify correct delegation.
  - `figmaGetVersionsHandler` — call with `fileKey`, verify correct delegation.
  - Error path: mock a method to reject, verify handler wraps as `McpError`.
  - Schema validation: call with invalid `fileKey` (empty), verify ZodError rejection.

**File to create:** `src/integrations/figma/index.test.ts`

- Test `FigmaModule.id` returns `'figma'`.
- Test `needsEnv()` with `FIGMA_TOKEN` set, missing, and empty.
- Test `createToolHandlers` returns 8 handlers with expected names.
- Test handler delegation (one integration test that args flow through to the handler).
- Test `getToolDescriptors` returns 8 descriptors with correct names and descriptions.

**File to modify:** `src/mcp-server.test.ts`

1. Add `FigmaClient: class MockFigmaClient {}` to the mock factory in `vi.mock('./services/index.js')`.
2. No behavior change needed — existing tests verify bootstrap with empty env, and Figma will be inactive in that scenario.

**File to modify:** `src/integrations/index.test.ts`

1. Add a test that the `modules` array contains a module with `id === 'figma'`.
2. Verify `modules` array length is 3.

---

## Out of Scope

The following are explicitly **not** in scope for this implementation:

1. **Resource handlers** (`figma://` URIs) — no current use case. Can be added later.
2. **Prompt handlers** — no prompt template identified yet. Can be added later.
3. **Image proxying** — the tool returns ephemeral presigned URLs; the agent/LLM can present them to the user or fetch them if it has HTTP capability.
4. **Figma Webhook integration** — event-driven workflows (notify on file update) are a separate feature.
5. **Variable mode switching** — the `figma_get_variables` tool returns all modes; selecting a specific mode is a client-side concern.
6. **File search** — Figma's `/v1/me/files` endpoint could list all accessible files, but it's a separate paginated feature. Not needed until an agent workflow requires file discovery.
7. **Rate limit resilience** — Figma's 200 req/min limit is generous for agent workflows. No client-side rate limiting, retry, or queuing. Errors bubble up as `McpError.InternalError`.
8. **Type narrowing** — response types use `Record<string, unknown>` for the full document tree and metadata maps. The raw API response passes through without reshaping.

---

## Verification

After implementation:

1. `npm run typecheck` — must pass with zero errors.
2. `npm run test` — all existing + new tests must pass.
3. Manual verification with a real `FIGMA_TOKEN`:
   - Start the MCP server (`npm run mcp`).
   - Verify logs show `Figma integration: active` and `Module registered: figma`.
   - Call `figma_get_me` to confirm auth works.
   - Call `figma_get_file` with a known file key to confirm data flows.
4. Confirm the health tool response includes `"figma": true`.
