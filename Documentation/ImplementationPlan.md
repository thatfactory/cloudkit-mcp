# CloudKit MCP - Implementation Plan

Status: implementation-ready roadmap; owner/private and ordinary-participant/shared authentication, change-read, and canonical inventory lookup gates verified on 2026-09-14. Remaining secondary capability and release gates are tracked below. Prepared: 2026-09-13. Primary requirements: the supplied `CloudKitMCP.md` handoff, with the subsequently agreed naming change. Suggested repository location: `Documentation/ImplementationPlan.md`.

| Identity | Value |
| --- | --- |
| GitHub repository | `thatfactory/cloudkit-mcp` |
| npm package | `@thatfactory/cloudkit-mcp` |
| CLI executable / MCP server name | `cloudkit-mcp` |
| Display name | CloudKit MCP |
| Repository description | Inspect and debug CloudKit databases, records, zones, and sharing through a secure, read-only MCP server. |
| First consumer | WortJagd (don't mention in the project's README, internal use only) |
| Initial release target | `0.1.0`, subject to the acceptance gates below |

This is the single planning document. Keep architecture decisions, phase progress, capability limitations, and acceptance evidence here rather than creating separate phase, architecture, or product plans. Normal repository files such as `README.md`, `AGENTS.md`, executable contracts, and tests still belong in the implementation.

## 1. Goal and scope

Build a local, npm-distributed, stdio MCP server that lets an authorized agent inspect CloudKit state and investigate synchronization problems. It must remain independent of `app-store-connect-mcp` (don't mention in the project's README, internal use only) while reusing that project's applicable engineering patterns. The supplied handoff is authoritative for product scope. [H1]

WortJagd is the motivating workflow, not a hard-coded schema. Its owner reads the family inventory through a custom zone in the private database; participants read that inventory through their shared databases. Preserve these account-relative views throughout authentication, identity, queries, caching, comparison, and results. Never treat the container as a single global record store. [H1]

The read-first MVP must cover the handoff's seven areas: context and capabilities; zones; record lookup and indexed queries; synchronization metadata; sharing topology; subscriptions and supported change state; and comparison of two independently authenticated views. Where the chosen public API cannot provide an answer, return a precise limitation and the remaining manual boundary. Do not invent data or quietly drop a requirement. [H1]

Out of scope for the MVP: CloudKit mutations of any kind, accepting invitations, creating or repairing subscriptions, schema deployment, database resets, notification registration, asset downloads, generic HTTP requests, arbitrary CloudKit bodies, CloudKit Console scraping, cookie extraction, Apple Account password handling, a hosted multi-tenant service, and a mandatory Swift/native companion. Local credential storage and read cursors are not permission to mutate CloudKit. Future writes are described in Phase 11 but are not part of this implementation authorization.

### Evidence labels

- **Requirement:** carried forward from the handoff or the naming decision.
- **Verified reference:** observed in the reference repository or published primary documentation; not a claim of live CloudKit validation.
- **Proposed contract:** a design choice made in this plan, including tool names, limits, folders, and error codes.
- **Implementation gate:** a fact that must be demonstrated before enabling the corresponding capability.

No live CloudKit accounts, keys, user sessions, containers, or npm publication were exercised while preparing this plan. Repository inspection was a targeted architecture audit, not a comprehensive security review or a successful run of its tests.

## 2. Reference repository audit and reuse decisions

Reference: `thatfactory/app-store-connect-mcp` at immutable commit:

```text
6d818dd57cbdf7b079388be14fb7a1cdc9060f02
```

The inspected snapshot uses Node 24+, strict TypeScript, ESM, the official MCP SDK, lazy authentication, typed tools, packaged MCP resources, bounded transport, and tarball smoke testing. Its release process publishes from a resolved immutable release commit, not whatever happens to be on `main`. These observations are specific to this snapshot. [R1, R2, R3, R4, R6, R7]

| Inspected reference | Carry forward | Adapt or deliberately exclude |
| --- | --- | --- |
| `package.json` [R1] | Scoped npm package, unscoped executable, lockfile, clean/build/typecheck/test/check/smoke scripts, explicit package allowlist | New names and metadata; independently verify compatible dependencies instead of assuming the snapshot's versions are registry-latest |
| `Documentation/Architecture.md` [R2] | Separation of protocol, domain services, transport, configuration, and security; offline operations without credentials | No App Store repository synchronization domain or Xcode/signing features |
| `src/server.ts` [R3] | Server factory, domain registration functions, packaged capability/schema resources | One package-version source of truth; do not duplicate a hard-coded version constant |
| `src/api/client.ts` [R4] | Fixed origin, redirect rejection, cancellation, streaming byte limits, bounded retries, pagination-loop protection | Replace JSON:API response assumptions and bearer-JWT authentication; classify effects by operation, not HTTP verb |
| `Documentation/Plan-and-Apply.md` [R5] | Immutable plans, exact authorization scope, preconditions, outcome uncertainty, readback, recovery | Preserve the discipline for future writes; do not ship dormant mutation infrastructure in the MVP |
| `Documentation/Release.md` [R6] | External tarball installation, package-content checks, immutable-source validation, explicit owner release authority | New package bootstrap and trusted-publisher identity; reference package setup does not transfer automatically |
| `.github/workflows/publish.yml` [R7] | Release-event preflight, exact tag/version check, main-history membership, per-tag non-cancelling concurrency, OIDC | New repository/environment configuration; review and pin action/toolchain dependencies |
| `package.json` check pipeline and release acceptance documentation [R1, R6] | Deterministic unit/contract tests and install-from-tarball verification | New CloudKit contracts and synthetic fixtures; no reuse of App Store payloads or credentials |

**Critical transport difference:** the reference client treats `method !== 'GET'` as a write. CloudKit record lookup, queries, and change-feed reads use POST. Replace that heuristic with an explicit operation registry containing `effect: 'read' | 'write'`. HTTP verb alone must not determine authorization, retries, annotations, or execution semantics. [R4, A2, A3, A6, A7]

Reuse patterns through small, attributed adaptations where useful. Do not import the App Store Connect package as a runtime dependency or extract a new shared framework before both implementations justify it.

## 3. CloudKit access: verified boundaries and capability gates

### 3.1 Authentication is not interchangeable with API surface

CloudKit Web Services, CloudKit JS, and CKTool JS are API surfaces, not equivalent credential types. Model `backend` separately from `authenticationMode`. Never substitute an App Store Connect key, team role, server key, web token, or automation user token for another credential class.

Apple documents server-to-server keys for public-database access. The Web Services user flow uses an API token plus an interactive user's web-authentication token; the documentation describes token rotation. Treat those as separate implementations, not JWT variants. [A1]

Apple also documents CKTool JS for automation and a separate, interactive, short-lived automation user token with private/shared access. The `cktool` guide describes management and user tokens and Keychain storage. This is an alternative public integration surface worth testing before implementing custom browser infrastructure; it is not permission to automate the user's sign-in or reuse Console cookies. [A9, A10]

### 3.2 Initial capability matrix

This is an evidence-based starting matrix, not an assertion that every endpoint already works. Phase 00 replaces conditional entries with versioned, tested operation-level support.

| Credential / surface | Public | Private | Shared | MVP decision |
| --- | --- | --- | --- | --- |
| No configured credentials | Offline metadata only | No | No | Discovery and configuration validation must work |
| CloudKit server-to-server key / Web Services | Documented public access, within granted authority | Not authorized by this mode | Not authorized by this mode | Implement bounded public read adapter |
| API token without authenticated user / Web Services | Only reads permitted without user authentication | Requires user authentication | Requires user authentication | Optional explicit public mode; never silently downgrade into it |
| API token plus web-authentication token / Web Services | Endpoint and permission dependent | User-relative, operation gated | User-relative, operation gated | Preferred direct-HTTP candidate; prove the complete user workflow |
| Automation user token / CKTool JS | Operation dependent | Documented user access | Documented user access | Competing user-backend candidate; prove normal participant-account access and required operations |
| Automation management token / CKTool JS | Evaluate exact documented read authority | Not accepted as user impersonation | Not accepted as user impersonation | Excluded from the default MVP; no schema-management tools |
| Native CloudKit account access | Separate native runtime | Separate native runtime | Separate native runtime | Not an implicit npm fallback; requires a separately approved extension |

Sources for the authentication distinctions: [A1, A9, A10]. The shared-database parameters for record reads and change feeds are explicitly documented in [A2, A3, A6, A7].

### 3.3 Backend decision rule

Use a small `CloudKitReadBackend` interface. The selected authenticated-user architecture is a bounded CloudKit Web Services adapter using an API token plus a web-authentication token. Keep the separately scoped public server-key adapter only where it provides documented functionality. The two credential paths remain separate implementations even though they share bounded transport and projection contracts.

CKTool JS is excluded from the MVP. Apple's published automation workflow requires developer-oriented CloudKit Console credentials, ordinary invited-participant credential acquisition is not established, and the locally installed `cktool` 1.0.23001 surface does not cover the required zones, sharing, subscriptions, and database-change diagnostics. Reconsider it only through a separately reviewed capability spike that proves ordinary-participant authentication and the complete required read surface. An SDK is not exempt from transport or privacy controls.

The remaining live feasibility gate must use an ordinary invited family member, not just the developer who owns the container. A successful implementation or fixture test does not prove that workflow, and making every participant a developer-team member is not acceptable evidence.

### 3.4 Operation-level evidence required

| Area | Published starting point | Gate before support is advertised |
| --- | --- | --- |
| Record lookup / query | Public, private, and shared are documented parameters [A2, A3] | Owner-aware addressing, actual response shape, projection, permission behavior, and pagination |
| Zones | Archived list/lookup pages explicitly describe public/private [A4, A5] | Shared-zone listing/lookup support must be proven for the selected backend; do not extend an enum by guesswork |
| Sharing | Web Services dictionaries describe share and participant metadata [A8] | Discovering a share, zone-wide versus root-record mode, caller role, and visibility of participant details |
| Subscriptions | Archived list endpoint describes public/private [A11] | Shared scope and native database-subscription visibility require separate evidence |
| Database / zone changes | Private/shared change endpoints are documented [A6, A7] | Token lifecycle, per-zone continuation, tombstones, and recovery behavior |
| Schema/index inspection | Not established by the handoff's data-read requirements | Report configured query policy, not an invented authoritative index catalog |
| Client synchronization internals | Not established by remote record APIs | Local upload queues, CKSyncEngine state, and app-held cursors remain unavailable without separate evidence |

Apple's archived pages are useful but dated and contain uneven coverage. Missing documentation is `notVerified`, not proof of permanent platform impossibility. Missing support in the chosen adapter is `notImplemented` or `backendUnavailable`, not automatically `consoleOnly`.

For each operation retain: backend/API version, credential class, scope, official source, contract-fixture provenance, documented support, live verification status, and known limitations. Capability reporting must distinguish API support, implementation status, and current authorization.

## 4. Proposed architecture

```text
MCP host
  -> stdio protocol / static resources
  -> typed diagnostic tool handlers
  -> profile policy + capability authorization
  -> diagnostic services / comparison engine
  -> backend interface
  -> bounded operation transport + credential/session manager
  -> explicitly allowed Apple service

External private credential store -> credential/session manager only
Backend responses -> validated domain objects -> privacy projection -> MCP result
```

Dependencies point inward: domain models and comparison logic do not import MCP classes or SDK response types. Only backend adapters know Apple's wire format. Only credential modules access secrets. Tool handlers never construct URLs, sign requests, inspect secret files, or return raw backend objects.

### 4.1 Repository layout

```text
cloudkit-mcp/
  AGENTS.md
  Documentation/ImplementationPlan.md
  src/
    index.ts                 # CLI dispatch, stdio startup, process lifecycle
    server.ts                # createServer(dependencies), registration only
    config/                  # strict profile schema, approved local inputs
    domain/                  # view/zone/record/share/change models
    auth/                    # credential resolution, principal binding, rotation
    api/                     # operation registry, bounded transport, adapters
    diagnostics/             # privacy projection, evidence and comparison
    state/                   # bounded opaque handles and local secret-store locks
    tools/                   # context, zones, records, shares, changes, compare
    observability/           # structured stderr events without private data
  resources/
    capabilities.json
    schemas/
  contracts/
    operation-policy.json
    provenance.json
  tests/
    unit/
    contracts/
    security/
    mcp/
    packaging/
    fixtures/                # synthetic, deterministic data only
  scripts/
    clean.mjs
    generate-schemas.ts
    pack-smoke.mjs
    verify-package.mjs
  .github/workflows/
    ci.yml
    nightly.yml
    publish.yml
  package.json
  package-lock.json
  tsconfig.json
  README.md
  LICENSE
```

Folders are proposed responsibilities, not a mandate to create empty abstractions. Add modules only with their implementing phase. Do not add `planning/` or write adapters until a future mutation phase is authorized.

### 4.2 Configuration and identity

Profiles are immutable startup policy, not agent-editable runtime preferences. A profile binds a container, environment, backend, credential reference, allowed scopes, and optional record-type/field policy. Container and environment are required; no production default and no fallback across environments.

Illustrative non-secret configuration; property names are proposed:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "owner-development",
      "containerId": "iCloud.com.example.vocabulary",
      "environment": "development",
      "backend": "web-services",
      "authenticationMode": "web-user",
      "credentialRef": "owner-development-session",
      "allowedScopes": ["private"],
      "recordPolicy": {
        "allowedTypes": ["VocabularyEntry"],
        "queryableFields": ["entryID"],
        "readablePayloadFields": []
      }
    },
    {
      "id": "participant-development",
      "containerId": "iCloud.com.example.vocabulary",
      "environment": "development",
      "backend": "web-services",
      "authenticationMode": "web-user",
      "credentialRef": "participant-development-session",
      "allowedScopes": ["shared"],
      "recordPolicy": {
        "allowedTypes": ["VocabularyEntry"],
        "queryableFields": ["entryID"],
        "readablePayloadFields": []
      }
    }
  ]
}
```

All identifiers, types, and fields above are synthetic, not claims about WortJagd's deployed schema. Replace them only with explicitly supplied configuration. A local `queryableFields` list is an allowlist, not evidence that Apple has deployed those indexes.

Every remote operation resolves a view containing profile, container, environment, database scope, authenticated principal, and principal epoch. Every zone adds its actual owner and name; every record adds its record name. This full identity, not record name alone, binds requests, cursors, caches, and comparison evidence.

In shared scope an absent owner is not silently interpreted as the caller. Resolve an opaque zone handle returned by authorized discovery, or a previously verified owner mapping. Preserve Apple's actual wire owner identifiers privately. Do not normalize another owner's zone into the caller's private namespace.

Use privacy-safe account aliases derived with a process-secret keyed hash, scoped to the container, so a verified owner can be correlated across the two views in one process without publishing raw account IDs. Raw names, emails, contact details, device identifiers, and lookup information are not part of the default account projection.

Separate **principal epoch** from **token generation**. A new login/account binding changes the epoch and invalidates view-bound state. Routine web-token rotation advances its generation without invalidating every cursor. Do not use the current token value as the public identity of an account.

### 4.3 Authentication and local storage boundary

Credentials must be resolved lazily, only after input/policy checks for an authorized remote operation. Server startup, help/version, tool/resource discovery, static capabilities, and offline profile validation must not load secret values or contact Apple.

Use provider-specific credential records: server key, Web Services API token plus web session, or CKTool automation user token. Reject combinations rather than trying credentials against multiple services. Do not copy the App Store JWT implementation.

For the initial manual workflow, provide a dedicated local CLI command such as `cloudkit-mcp auth import --profile <id>`. It takes secret values through a hidden terminal prompt or an explicitly supported protected input channel, never command arguments, MCP parameters, conversation text, or a repository file. The operator obtains the credential through the selected provider's official interactive flow. Import is explicit authorization to store that session locally; it is not silent persistence during MCP discovery.

A proposed cross-platform-friendly MVP store is an explicitly configured, owner-only local credential directory outside all repository trees. On supported POSIX platforms require directory mode `0700`, file mode `0600`, ownership checks, symlink rejection, bounded parsing, atomic replacement, and restrictive creation from the outset. These files are access-controlled, **not inherently encrypted**. Document that limitation. Prefer a vetted OS credential-store adapter when available without exposing secrets through process arguments. Do not claim Windows support for this storage path until equivalent ACL tests pass.

Keep credential storage separate from diagnostic state, fixtures, packages, and any future recovery journal. Do not auto-import `.env`, inspect browser cookies, enumerate unrelated Keychain items, or expose credential paths in diagnostics. Authentication expiry must return an actionable local re-authentication instruction without the token or login URL.

For rotating web sessions, serialize the complete read-request/token-update transaction per credential slot, including across server processes sharing that slot. Commit replacement tokens atomically before another request uses the session. A response lost after dispatch can leave authentication state uncertain even though the database operation was read-only. Suspend that session rather than blindly replaying the old token. CKTool user tokens use their own documented lifecycle; do not assume web-token rotation applies to them.

A custom browser login helper is optional, not an MVP prerequisite. Implement it only after proving registered callback handling, allowed authentication hosts, origin checks, flow correlation, expected account verification, timeout/cancellation, and no token leakage through URLs in logs or errors. Do not assume CloudKit implements OAuth state, PKCE, or refresh tokens.

### 4.4 Read-only transport and budgets

Use a closed operation registry. Each entry defines backend, HTTP method or typed SDK method, path template, credential class, supported scopes, request/response schema, projection behavior, and `effect`. Only registry entries with `effect: 'read'` are reachable in the MVP. Deny modification, invitation acceptance, subscription creation, notification registration, and any SDK bootstrap that performs those operations.

For direct Web Services requests allow only the exact HTTPS origin `https://api.apple-cloudkit.com`, with no alternate port, userinfo, fragment, arbitrary path, or following of redirects. Build encoded path segments from validated identifiers; the caller cannot supply a URL. A CKTool adapter needs its own evidence-backed exact allowlist before activation. Never use a wildcard Apple-domain allowlist or infer a new host from a server response.

The initial budgets below are product safety choices, not claimed Apple service limits. The effective limit is always the lower of a verified service limit and the local budget.

| Resource | Proposed default / hard ceiling |
| --- | --- |
| Tool input JSON | 64 KiB; bounded strings, nesting, arrays, and filter counts |
| Single upstream request | 15 seconds, including response-body consumption |
| Whole tool call | 45 seconds, including queueing, retries, and projection |
| Upstream response | 4 MiB of decoded bytes, enforced while reading success and error bodies |
| Serialized MCP result | 512 KiB across structured content and any text representation |
| Query/change page | Default 50 records; at most 100, subject to endpoint support |
| Named lookup | At most 20 records per call |
| Diagnostic traversal | At most 5 pages and 500 records total; no hidden unbounded drain |
| Retries | At most one retry, only when operation and session state both permit it |
| Concurrency | One active request per rotating credential; at most 4 globally; bounded pending queue |
| Opaque handle registry | At most 128 entries and 4 MiB total; 15-minute maximum lifetime |
| Explicit payload projection | At most 10 selected fields; 4 KiB per string and 64 KiB total payload output |

Validate all configured budgets against compiled ceilings. Tool parameters may reduce them, never raise them. Share participant lists, zone lists, reference lists, errors, and metadata strings also need independent bounds.

Handle HTTP errors, top-level CloudKit errors, and per-item errors inside successful HTTP responses. Validate critical identity and cursor fields before projection. Discard unknown response fields; preserve unknown documented enum values as `unknown` without exposing arbitrary strings. Do not log upstream `reason` text, request URLs with credentials, request/response bodies, or exception objects that may embed them.

Retries must honor verified provider retry guidance only within the remaining deadline. Re-sign server-key attempts as needed. For user sessions, update or invalidate authentication state before considering a retry. Cancellation must propagate through queues, fetch, streaming reads, and projection and release locks without pretending an uncertain session is still usable.

### 4.5 Result, privacy, and evidence contract

All remote results carry the explicit profile, container, environment, scope, backend, observation time, completion status, and limitations. Comparisons carry one independently bound context per side. Static/offline results say that no authentication or remote probe has occurred.

Proposed status model:

```text
status: ok | partial | unavailable | error
execution: notStarted | started | completed | uncertain
remoteDataEffect: none
sessionEffect: unchanged | rotated | uncertain
completeness: completeForRequest | partial | notEstablished
```

`execution` describes the diagnostic operation, not a database write. `remoteDataEffect: none` is invariant in the MVP. Keep authentication uncertainty separate so a read can be safe for remote data yet unsafe to retry with the same session token.

Use explicit result variants for present, not-found-in-this-view, inaccessible, and unknown. A failed lookup does not establish global nonexistence. An omitted field does not establish a null value. A missing share or subscription does not establish its deletion. Tombstones require positive change-feed evidence; absence of a tombstone is not proof a record never existed.

By default expose synchronization metadata and bounded structural summaries, not vocabulary words, definitions, arbitrary user strings, asset content, contact information, or share URLs. Prefer opaque record/zone handles for discovered identifiers that may contain personal text. Allow exact identifier disclosure only through explicit profile policy or a narrowly scoped request; never expose raw account IDs. Names deliberately supplied for a lookup may be echoed only in that request's bounded result, never logs.

Record summaries should support change tag, timestamps, observed deletion state, owning zone, and available reference metadata. The backend must distinguish a field that was not fetched from one that was fetched and redacted. Do not fetch whole records merely to count or summarize their fields.

Projection is enforced twice: request the minimum supported fields upstream, then construct an allowlisted output. Phase 00 must verify whether an empty desired-field list really yields metadata only. If it does not, record that data can reach the process despite not reaching the agent and expose that distinction; do not claim upstream data minimization that the API cannot provide.

User-defined reference fields need explicit permitted projection just like other data fields; do not download all fields to discover references. System parent/share references can be exposed only through their verified metadata contract. Never follow references automatically outside the selected view.

`read_record_fields` is the only payload-reading tool. It requires explicit record selection, an exact field list, and a matching startup field allowlist. No wildcards, "all fields", asset download URLs, hidden attachments, or bulk inventory export. Explain in onboarding that enabled payloads enter the MCP host's context. Treat returned text as untrusted data, never instructions to invoke tools or change policy.

Use structured stderr events for operation start/outcome, duration, counts, stable error code, and an opaque request ID. Do not include record names, query values, field values, raw IDs, tokens, share links, or credentials. Disable telemetry and crash uploads by default. Privacy-safe observability is required; a blanket debug switch that prints raw objects is not acceptable.

### 4.6 Pagination and change-token handling

Return explicit page completion and a server-issued opaque continuation handle. Retain raw Apple markers and sync tokens privately; do not expose a base64-wrapped token as a supposedly safe handle. Bind each handle to principal epoch, profile, container, environment, scope, backend, zone owner/name, operation kind, filter/sort/projection, and page budget.

Reject cross-profile, cross-scope, cross-zone, cross-environment, changed-query, expired, and post-reauthentication reuse before contacting Apple. Token generation changes within the same authenticated epoch must not break valid handles.

One ordinary tool call returns one bounded upstream page. A separately defined diagnostic traversal may use the explicit aggregate budget. If an endpoint has no verified continuation mechanism, do not invent server pagination; return a bounded incomplete result or a size-limit error and guidance to narrow the operation. If local pagination over an already-read bounded snapshot is introduced, label it `localSnapshot`, not an Apple continuation.

Never truncate records from a page and then advance the upstream cursor past the dropped records. Retain a bounded remainder or fail without claiming resumability. Detect repeated cursors and endless `moreComing` responses. Partial results must include a stop reason and specify whether a valid continuation is available.

Database-change cursors, zone-change cursors, query markers, and native app cursors are distinct types. Do not decode or order them, compare them across accounts, or assume a native `CKServerChangeToken` can be imported as a Web Services token. A token held by this MCP describes this diagnostic reader, not WortJagd's local CKSyncEngine state.

### 4.7 Proposed MCP surface

Use intent-oriented names. Register the supported implementation surface consistently without loading credentials. Per-profile availability is reported separately; annotations are descriptive, not the authorization mechanism. Include validated structured output where supported by the pinned official SDK and compatible clients. [M1]

| Tool | Principal inputs | Result / boundary |
| --- | --- | --- |
| `get_context` | Optional configured profile selector | Offline configuration and capability matrix; no secret or network access |
| `probe_access` | Explicit profile and requested scope | Minimal authenticated read; verified account alias and operation availability, not a container scan |
| `list_zones` | View, page limit/handle when supported | Account-relative zones, privacy-safe owners, completeness |
| `get_zone` | View and zone selector | Metadata and supported sharing/change-state hints |
| `get_records` | View, zone, exact record names or handles | Metadata-first lookup with per-record outcomes |
| `query_records` | View, explicit zone/type, allowed filters, limit/handle | Bounded indexed query; no arbitrary predicates or cross-zone scan |
| `read_record_fields` | View, exact records, selected allowed fields | Explicit payload access; unavailable when policy allows no fields |
| `get_share` | View and proven zone/share/record selector | Available sharing mode, caller role, permission, redacted participants |
| `list_subscriptions` | View and supported bounded selector | Visible subscriptions, not proof of client push delivery |
| `get_database_changes` | View, explicit starting mode or issued cursor | Changed-zone metadata and database cursor handle |
| `get_zone_changes` | View, zone, explicit starting mode or issued cursor | Record-change metadata/tombstones and zone cursor handle |
| `compare_views` | Two explicit views and bounded record/zone selectors | Evidence-backed comparison with independent authorization and limitations |

Do not add a generic `request`, `execute`, `fetch_url`, `set_credentials`, or `repair_sync` tool. An optional higher-level diagnostic tool should wait until concrete usage shows that composing these tools is insufficient.

Ship offline capability and schema resources under `cloudkit://capabilities` and `cloudkit://schemas/...`. Avoid resources containing live records or secret configuration. Keep capability resources, tool schemas, policy registry, tests, and README examples generated from or checked against a common source of truth.

### 4.8 Stable errors

At minimum define typed codes for invalid configuration/input, disallowed scope, unsupported or unverified capability, authentication required/expired/uncertain, permission denied, not found in view, unavailable query index, invalid/expired/context-mismatched cursor, rate limiting, timeout/cancellation, malformed response, response/output bounds, and partial failure.

Each error contains a safe message, bound context when known, execution/session status, retryability with its conditions, and one actionable next step. The host may distinguish protocol/input errors from tool execution errors according to the pinned SDK. No stack trace or raw provider message belongs in a tool result.

## 5. Execution rules and phase map

Implement phases in order unless their dependencies explicitly allow isolated work. Keep each phase reviewable; use the indicated sub-PRs rather than opening one monolithic change. Tests and relevant documentation updates travel with every behavior change, not only with Phase 10. All phase checkboxes below start uncompleted.

| Phase | Outcome | Dependency | Suggested review slices |
| --- | --- | --- | --- |
| 00 | Evidence matrix and real private/shared feasibility | None | Reference/governance audit; user-backend spike |
| 01 | npm/TypeScript/MCP skeleton and repository governance | 00 architecture baseline | Bootstrap; CI/package smoke |
| 02 | Profiles, identities, output/privacy contracts | 01 | Domain/configuration; projection/error contracts |
| 03 | Bounded read transport and public authentication | 02 | Transport/registry; signing and public probe |
| 04 | Independently bound user sessions | 00 user-backend gate, 02-03 | Credential ingress/storage; lifecycle/isolation |
| 05 | Zone discovery and ownership | 03-04 for enabled modes | Zone adapters and tools |
| 06 | Record metadata, queries, explicit payloads | 05 | Lookup; query/pagination; selected payload fields |
| 07 | Sharing and participant topology | 04-06, sharing evidence gate | Share discovery/projection |
| 08 | Subscriptions and change-state diagnostics | 05-07, operation gates | Subscriptions; change feeds/cursors |
| 09 | Two-account comparison and diagnostic evidence | 06-08 | Pure comparison engine; MCP orchestration |
| 10 | Acceptance, exact-head review, npm release | 00-09 | Hardening/live evidence; release pipeline/approval |
| 11 | Optional future writes, not part of MVP | Separate product authorization | Plan-only; apply/reconcile after separate review |

### Phase 00 - Audit, capability contracts, and feasibility

**Goal:** prove a supported path to WortJagd's private/shared inventory before building features around assumed access.

Work:

1. Reconfirm the reference commit and inspect any applicable local guidance. Record differences from this audit without silently switching the reference baseline mid-phase.
2. Confirm the repository-local npm package and workflow conventions against the reference MCP repositories.
3. Complete the operation-level matrix in Section 3. Keep docs-derived and live-proven support distinct. Record exact wire parameters, endpoint scopes, SDK versions, numeric/date handling, and response/error variants in machine-readable contracts with source provenance.
4. Run a manually authorized spike with disposable data and two distinct consenting accounts: an owner and an ordinary invited participant. Prepare the custom zone, sample records, root-record share, and zone-wide share outside the MCP using an authorized test app or Console. Do not create a test-seeding write path inside the distributed server.
5. Demonstrate owner/private and participant/shared lookup of the same logical record, including the owner's zone identity. Test list/query, metadata projection, share discovery, participant visibility, subscriptions, changes, and expiry to the extent the public surface supports them.
6. Compare Web Services user access against CKTool JS. Record the chosen backend, account prerequisites, manual credential acquisition, credential lifetime, SDK transport hooks, and every missing capability. Do not assume a developer's successful session proves a family participant can authenticate.
7. Verify that no selected SDK automatically registers subscriptions/tokens or mutates data during configuration or authentication. Reject such defaults or disable them explicitly with tests.

**Tests/evidence:** sanitized synthetic contracts with operation, provider, date, version, credential class, scope, and observed outcome; no real account IDs or token-bearing URLs. Label hand-written fixtures as synthetic, never captured.

**Exit gate:** the authentication route and core owner/private-to-participant/shared record path are demonstrated, or recorded as a blocking unknown with an exact manual action needed. Missing credentials are not evidence that Apple's API is unsupported. Offline/public engineering may continue, but a public-only build cannot be described as the completed WortJagd MVP. Unavailable secondary metadata may remain a documented capability limitation where the supported API genuinely does not expose it.

- [x] Reference and governance versions recorded.
- [x] Capability matrix and provenance baseline completed.
- [x] Authenticated-user backend architecture selected from primary evidence.
- [x] Ordinary owner/participant private-to-shared workflow live-verified.

### Phase 01 - Repository, npm package, and MCP skeleton

**Goal:** a package that installs and advertises its capabilities without Apple credentials.

Work:

1. Initialize strict TypeScript with Node 24+ as the reference baseline, ESM, the official MCP SDK, runtime schema validation, and a committed lockfile. Select and pin compatible supported versions based on current primary documentation/registry evidence; do not blindly copy dependency versions from a plan.
2. Implement a shebang-equipped CLI, default stdio serving, explicit `--help` and `--version`, and deterministic process exit behavior. In serve mode reserve stdout for protocol traffic. Reject unknown flags; in the MVP `--allow-writes` must not activate anything.
3. Build `createServer(dependencies)` without side effects. Add offline capability/schema resources and minimal context reporting. Use one authoritative package version.
4. Add clean, build, typecheck, test, schema-consistency, package-verification, smoke, and aggregate check scripts. A fresh checkout must be able to run `npm ci` and `npm run check`.
5. Keep repository guidance local to this npm package and aligned with the reference npm MCP repositories.
6. Start secretless CI and tarball checks immediately. Keep publishing disabled until Phase 10.

**Tests:** subprocess help/version; MCP startup and discovery with credential providers that throw on access; a network implementation that throws if invoked; protocol-only stdout; clean shutdown; install and execute a packed tarball outside the source checkout.

**Exit gate:** offline discovery works from the actual package, no secret provider/network is touched, and the first CI pipeline is green.

- [x] Skeleton, governance, and scripts implemented.
- [x] Offline MCP and external package smoke tests pass.

### Phase 02 - Profiles, domain identities, privacy, and result schemas

**Goal:** make account/scope separation and safe outputs foundational rather than retrofits.

Work:

1. Implement strict startup-profile parsing with explicit environment, permitted scopes, backend, credential references, and field policy. Reject unknown security-sensitive fields, duplicate profile IDs, accidental inline secrets, remote includes, and repository-driven configuration discovery.
2. Introduce resolved view, owner-aware zone, record identity, principal epoch, capability/evidence state, typed errors, and result-envelope models.
3. Implement opaque handles and bounded privacy projection independently of any Apple SDK. Define metadata, references, payload selection, account aliases, redacted fields, and unavailable fields.
4. Complete static `get_context`; add a backend-independent seam for `probe_access`. Static support and last explicitly observed availability must remain distinguishable.
5. Generate/check tool schemas and packaged capability resources against policy. Ensure field permissions cannot be expanded through a tool argument.

**Tests:** two zones with identical names but different owners; records with identical names across scopes/environments; malicious configuration keys; PII-like record IDs; nested secrets in provider error objects; missing versus null versus redacted fields; no credentials required for offline policy validation.

**Exit gate:** invalid or forbidden identities are rejected before secret resolution or network access, and every projected result passes its schema and privacy assertions.

- [x] Profile/identity models implemented.
- [x] Result, redaction, capability, and error contracts covered by synthetic tests.

### Phase 03 - Bounded transport, request signing, and public reads

**Goal:** a small audited transport that can execute only approved reads.

Work:

1. Implement the closed operation registry and bounded transport from Section 4.4. Keep injected transport/clock/sleep/randomness seams for deterministic tests; never expose a runtime arbitrary-host override to agents.
2. Implement the CloudKit server-key signer from Apple's documented canonicalization and headers. Verify exact body bytes, digest construction, path encoding, timestamp format, key format, signature encoding, and algorithm against an authoritative contract. Do not reuse App Store JWT claims or assume JWT signature encoding is applicable. [A1]
3. Validate success and error response shapes, including per-record errors in successful responses. Apply the same streaming/time bounds to error bodies.
4. Implement retry eligibility from both operation effect and authentication/session state. Keep cancellation and total deadline behavior deterministic.
5. Wire a minimal public `probe_access`. Where public probing cannot establish a particular resource permission without reading that resource, report the narrower evidence rather than `fullAccess`.

**Tests:** cryptographic known-input verification, independently verified signatures rather than exact randomized ECDSA byte equality, empty/body-bearing requests, tampered body/path/date, encoded credentials, host/redirect rejection, oversized/chunked/error-body responses, malformed UTF-8/JSON, 429/retry guidance, cancellation during body read, HTTP 200 with item failures, and POST reads not being misclassified as writes.

**Exit gate:** approved public reads work against fixtures and a separately authorized synthetic live target; every non-read operation is unreachable. Verify signing live before claiming real server-key support.

- [x] Operation registry and bounded transport implemented.
- [x] Deterministic server-key signing contract implemented and independently verified synthetically.
- [x] Public API-token challenge and authenticated web-user probe/session-rotation contracts live-verified.
- [x] Deterministic transport/error adversarial coverage complete; provider error/retry variants remain live-unverified and are not intentionally provoked during acceptance.
- [ ] Live server-key signing remains unverified and is not required for the proven web-user MVP path.
- [x] Automatic transport retries remain deliberately unavailable; safe errors expose bounded retry eligibility instead.

### Phase 04 - Manual user authentication and session isolation

**Goal:** two independently authenticated users without credential crossover or automated sign-in.

Work:

1. Implement only the user backend selected in Phase 00. Freeze and publish its operation-level support matrix; do not add hidden fallback credentials or switch backends after a permission error.
2. Add explicit local credential import/status/removal commands. Import uses protected non-echoed input. Status displays profile, credential class, and safe availability only. Removal affects only the selected local credential slot; do not imply it revokes Apple's remote authorization unless a separately documented action actually does so.
3. Implement the private store and cross-process locking contract. Hold the appropriate lease across remote use and replacement of rotating tokens. Do not expose a user's session in MCP discovery, fixtures, npm contents, errors, or stderr.
4. Bind each authenticated session to its observed principal and the configured container/environment. Detect an account switch even if the profile label stays the same. Where the API does not establish binding sufficiently, mark the session unverified and deny cross-account comparison claims.
5. Implement provider-specific expiry and, for Web Services, replacement-token handling. Failed atomic storage after a received replacement token makes the slot unsafe for reuse; invalidate it and request reauthentication rather than silently reverting to an older token.
6. Add authentication-uncertainty behavior for timeouts, response parsing failures, process interruption, and concurrent use. Uncertainty may occur on a read and must not trigger blind retries.
7. Add authenticated private/shared `probe_access` only for proven operations. Do not probe every scope or enumerate records as a side effect.

**Tests:** independent owner/participant credentials; simultaneous requests; two processes using one slot; duplicate aliases for one account; different accounts with the same profile label after re-login; token rotation on success and error; stale replacement attempts; permission-denied versus auth-expired; crash/stale-lock handling; safe file modes/symlink attacks; and zero secrets in captured stderr, MCP responses, or unexpected exceptions.

**Exit gate:** synthetic owner/private and participant/shared reads succeed with isolated credential material, wrong-account reuse fails closed, and the documented manual authentication process is reproducible. Any remaining browser/callback work stays behind its own verification gate.

- [x] Manual credential lifecycle implemented.
- [x] Principal binding, session isolation, and uncertainty behavior validated synthetically.

### Phase 05 - Zone discovery and owner-aware addressing

**Goal:** let the agent identify the actual zone behind each account's view.

Work:

1. Implement `list_zones` and `get_zone` through verified backend operations. Distinguish supported public/default-zone behavior from custom private/shared zones; do not imply arbitrary public custom-zone support.
2. Preserve owner identity privately and expose the safe alias plus opaque zone handle. Include configured environment, observed scope, and available metadata in every result.
3. Distinguish unavailable shared-zone enumeration from an empty shared database. Where explicit zone lookup works but enumeration does not, advertise the narrower capability and require a verified selector.
4. Never create a missing zone. Never switch from shared to private or infer current-user ownership to make a lookup succeed.
5. Apply bounds and accurate completeness reporting even if a list endpoint is not paginated.

**Tests:** same name/different owners; owner omitted in a shared selector; empty versus inaccessible collections; revoked sharing; missing zone; unsupported public-zone metadata; mixed per-zone errors; oversized unpaginated response.

**Exit gate:** a tool result identifies owner/private and participant/shared views without conflating either with a separate same-named zone.

- [x] Zone tools and owner-safe selectors implemented.
- [x] Scope, ownership, and collection completeness synthetic tests pass.

### Phase 06 - Record lookup, indexed queries, and explicit payload access

**Goal:** answer existence and metadata questions before exposing content.

**PR 06A: named metadata lookup.** Implement `get_records` for an explicit zone and bounded named records/handles, with one outcome per requested item. Project change tags, available timestamps, references, and observed deletion status. Preserve incomplete metadata and per-item errors. A successful HTTP response is not proof every record was fetched. [A2]

**PR 06B: typed bounded queries.** Implement `query_records` with an explicit record type and zone, a small allowlisted comparator set, typed values, and permitted indexed fields. Sorting is not part of the `0.1.0` contract. Do not accept predicate strings, raw JSON query bodies, arbitrary system fields, or all-zone scans. Record that indexes are asynchronous and query results do not establish authoritative absence; recommend exact-name lookup when possible. Keep markers bound to the complete query and principal context. [A3]

**PR 06C: selected payload fields.** Implement `read_record_fields` only after metadata-only behavior is tested. Require exact fields and records plus startup authorization. Bound strings/arrays/binary representations and omit asset links. Explicitly label whether fields were not requested, unavailable, redacted, or returned. Do not silently return an entire record when selective projection is unsupported.

**Tests:** mixed lookup success/failure; same record name in another scope; missing record type; unqueryable field; absent query index; asynchronous index lag fixture; repeated continuation marker; changed filter/projection; output budget exhausted mid-page; unknown scalar types; large numbers without precision loss; nested references; payload containing tokens/share URLs and prompt-injection text; unexpected upstream full payload despite minimum projection.

**Exit gate:** lookup and query semantics are distinct, paging never skips withheld items, default tools return no vocabulary payloads, and authorized selected-field reads remain narrowly scoped.

- [x] Named metadata lookup complete.
- [x] Typed query and cursor handling complete for the implemented contract.
- [x] Explicit payload projection and privacy tests complete.

### Phase 07 - Shares and participant topology

**Goal:** inspect sharing without accepting, repairing, or changing it.

Work:

1. Implement `get_share` through a verified record/zone-to-share lookup. Do not require users to paste share URLs into MCP as the primary lookup method.
2. Return observed mode (`zoneWide`, `recordHierarchy`, or `unknown`), caller role, public permission when available, and bounded privacy-safe participant summaries.
3. Distinguish invited, accepted, removed, and unavailable participant state according to the actual backend contract. An owner may see more topology than a participant; label completeness rather than copying owner-only details into another profile's result.
4. Establish zone-wide mode only from proven metadata. The `zoneWide` query option means search scope in the Web Services query documentation; it is not evidence that a share is zone-wide. Do not infer share mode from "there is only one share" or from a missing root. [A3]
5. Keep invitation acceptance outside the read-only registry. Expired/revoked invitation diagnostics must not automatically reopen or accept a share.

**Tests:** synthetic zone-wide and record-hierarchy shares; invited-only and public-permission topology where supported; owner/participant projections; no identity visibility; unknown mode; omitted fields; oversized participants; revoked permission; and no share URLs, short GUIDs usable as links, contacts, or raw account IDs in any public output.

**Exit gate:** supported sharing facts are established from evidence. Where zone-wide metadata is not exposed by the chosen backend, return the exact missing field/capability and manual follow-up; never report a fabricated `false` value.

- [x] Share discovery and topology projection complete for the implemented contract.
- [x] Mode, role, privacy, and no-invitation-mutation synthetic tests pass.

### Phase 08 - Subscriptions and change-state diagnostics

**Goal:** expose supported server-side synchronization evidence without pretending to inspect app-local state.

**PR 08A: subscriptions.** Implement `list_subscriptions` for proven scope/type combinations. Return safe type/scope/zone information and bounded structural predicate summaries, not predicate values or notification payloads. Distinguish query/zone/database subscription support as actually provided by the backend. An empty result from an API that cannot expose the relevant subscription class is not "no subscriptions installed". Never create/register a subscription to make the tool useful. [A11]

**PR 08B: changes.** Implement database and zone-change tools with explicit starts: an issued cursor, a verified current-baseline operation, or a deliberately requested beginning/baseline scan. Each start has a distinct `coverage` description; do not equate a current baseline with a full history audit. The documented Web Services zone-change endpoint applies to custom zones and supports private/shared scope; use the current documented change endpoints rather than deprecated `records/changes`. [A6, A7, A12]

Preserve per-zone tokens and per-zone errors independently. Process tombstones without inventing record fields. Do not interpret a zone deletion as deletion of every previously observed record unless the requested diagnostic explicitly states that narrower inference. An expired cursor requires an explicit new baseline, never a silent reset that hides missed changes.

Keep tokens inside the process-bound handle registry. No raw token export/import in the MVP. Do not modify WortJagd's local SQLite data, sync state, or persisted cursors. Observing this server's cursor does not observe the app's cursor.

**Tests:** multiple changed zones; partial zone failure; empty page with valid continuation; repeated marker; deleted records/zones; expired token; malformed token response; wrong cursor type or owner; limited history coverage; denied shared subscription class; unknown subscription type; attempted scan exceeding budget; cancellation without losing resumability.

**Exit gate:** supported subscriptions and change evidence are visible with exact scope and coverage. The server reports app-local synchronization state as unavailable unless separate evidence is supplied; it does not infer a stale application cursor from remote-token inequality.

- [x] Supported subscription diagnostics complete; unverified shared listing remains gated.
- [x] Change feeds, tombstones, bounded coverage, and process-local cursor recovery implemented.

### Phase 09 - Independent view comparison and diagnostic reasoning

**Goal:** answer the handoff's cross-account questions with auditable evidence rather than guesses.

Work:

1. Implement a pure comparison engine over normalized observations before wiring `compare_views`.
2. Require two explicit views, normally in the same container/environment. Do not automatically search other accounts, environments, zones, or record types. A cross-environment comparison is a separate explicitly selected diagnostic, not the default inventory comparison.
3. Establish correspondence using proven container/zone-owner/zone-name/record identity or an explicit mapping whose unverified status is preserved. Identical record names or profile labels alone do not prove the records or accounts are the same.
4. Read each side with its own authorization/session and retain both observation windows. Re-authentication or identity change invalidates an in-progress comparison. Same-account sessions must be identified as such, not presented as an owner-versus-participant test.
5. Compare existence-in-view, available metadata, sharing role, and bounded change/subscription evidence. Use direct lookup for known record names rather than relying only on queries. Do not compare opaque sync tokens as version counters. Treat cross-view change-tag equality/difference as raw evidence unless comparability is proven; neither proves complete payload identity.
6. Return evidence, limitations, likely explanations with stated confidence, and the next bounded/manual diagnostic. A permission failure on one side must not discard successful evidence from the other or masquerade as a data mismatch.

Suggested diagnostic result categories:

| Category | Required evidence / interpretation |
| --- | --- |
| `matchingObservedMetadata` | Proven identity mapping and matching available metadata at stated observation times; not a transactional snapshot or full-content guarantee |
| `visibilityMismatch` | Record present in one authorized view and not observed/denied in the other; identify which distinction was actually observed |
| `environmentMismatch` | Explicitly selected contexts differ; do not call this failed synchronization |
| `queryVisibilityLagPossible` | Exact lookup succeeds while an otherwise valid indexed query misses it; delay remains a hypothesis |
| `diagnosticCursorExpired` | The provider rejected this MCP's issued cursor; no claim about the app's cursor |
| `uploadFailureNotEstablished` | Record absent in a view, without authoritative local upload evidence |
| `clientEvidenceRequired` | App queue, CKSyncEngine cursor, account state, or client logs needed |
| `manualInspectionRequired` | A specifically identified supported manual/Console/native inspection is still necessary |
| `inconclusive` | Partial reads, identity uncertainty, changing observations, or unavailable metadata prevent a stronger claim |

**Tests:** matching views; owner-only record; wrong environment; same-named unrelated zone; same account under two profiles; revoked participant; different change tags; concurrent edits between reads; partial results; differing query visibility; unavailable local cursor; unsupported share mode; and synthetic WortJagd-like records without production content.

**Exit gate:** every conclusion points to bounded tool evidence and distinguishes fact from hypothesis. No path reports upload failure or stale app cursor solely because a remote record is missing or two tokens differ.

- [x] Pure comparison engine and fixtures implemented.
- [x] Independent orchestration and evidence-based conclusions validated synthetically.

### Phase 10 - Hardening, acceptance, exact-head review, and npm release

**Goal:** publish only what was actually validated, from the reviewed immutable source.

#### 10A. Automated and live acceptance

Run the full test matrix in Section 6. Unit, contract, security, and package tests use deterministic synthetic fixtures and no live Apple credentials. Block unexpected network access in ordinary test runs. A separate operator-run acceptance harness may read a dedicated synthetic container with manually supplied credentials; it must never contact the family inventory by default.

Validate the selected backend with two consenting synthetic/test accounts and the acceptance questions in Section 7. For unsupported metadata attach the operation-level evidence and exact limitation. Record the backend/toolchain versions, environment, observation date, and reviewed source SHA. Store no unredacted captures or session artifacts in the repository.

Complete adversarial testing of malformed responses, callback/input handling where implemented, account switching, concurrency, resource exhaustion, and secret-safe errors. Remove debug code, unused auth experiments, mutation methods, and unsupported advertised features.

#### 10B. Package and CI gates

The package must contain only required `dist/`, safe `resources/`, `package.json`, `README.md`, and `LICENSE`. Check the actual tarball against this allowlist. Exclude source maps with embedded content, fixtures, source contracts/captures, credentials, state, test harnesses, and local configuration.

Install the tarball in a fresh directory outside the checkout using production dependencies only. Test executable permission/shebang, help/version, stdio startup, tool/resource discovery, offline validation, and bounded fixture-driven tool execution. The package must not depend on source-tree paths, Xcode, Swift, a globally installed TypeScript compiler, or development dependencies.

Proposed required commands:

```sh
npm ci
npm run check
npm pack --json --dry-run
```

`npm run check` must aggregate non-mutating lint/format validation if adopted, schema/policy consistency, type checking, all offline tests, clean build, package verification, and external tarball smoke tests.

Use secretless GitHub-hosted jobs for untrusted pull requests. A trusted self-hosted macOS lane may follow local governance for native consumer checks, but must not execute untrusted contributor code with accessible local credentials. Publishing uses an eligible hosted runner, not a developer's personal Mac. [N1]

#### 10C. Exact-head merge and release review

Before release, deliberately recheck the package's repository-local contracts and current npm publishing requirements.

Obtain the required ChatGPT review for the exact PR identity: repository/PR, base SHA, and head SHA. Follow the root Code Review Rules for severities and merge gating. Any code, generated contract, dependency, or release configuration change after review requires the corresponding review/gates again. Do not treat this implementation plan as that code review.

Retain review identity, CI results, capability manifest, live-evidence limitations, and final package checks in the release record. The final release commit must belong to the approved mainline and contain the reviewed changes with passing gates for that exact source. If merging or version preparation changes the reviewed source, validate and review the final identity before publishing.

#### 10D. npm publication

Reuse the reference release-event architecture, with new package identity and explicit owner authorization. Do not publish merely because implementation completed. [R6, R7]

1. Verify scope/package ownership and name availability. Neither is assumed from the existing App Store Connect package. Check whether trusted publishing can be configured before the first publication. If an owner-authenticated bootstrap is required, publish the reviewed first version exactly once, record its provenance limitations, and start automatic OIDC publication with the next new version. The first GitHub release must not blindly republish an already bootstrapped version. Do not seed a long-lived write token into CI.
2. Configure a trusted publisher for `thatfactory/cloudkit-mcp`, `publish.yml`, and the chosen `npm-publish` environment. Verify exact repository metadata and explicitly permit direct `npm publish` if retaining release-to-publication behavior. Current npm guidance distinguishes direct publishing permission from staged publishing. [N1]
3. Pin a supported release toolchain. npm's documented OIDC floor at preparation is npm 11.5.1 and Node 22.14.0; the proposed Node 24 baseline exceeds the Node floor, but verify the actual npm executable in CI. Use the provider/runner combinations supported at implementation. [N1]
4. Follow the existing tag convention: `0.1.0`, not `v0.1.0`, exactly matching `package.json`. Trigger from a published GitHub release after authorization; keep a constrained recovery path only for an already authorized release. [R6]
5. Resolve the release tag to an immutable commit, verify release-event identity, approved mainline membership, and non-draft release state, then checkout that SHA. Run clean locked installation and all release gates. Concurrent same-tag publications queue rather than cancelling one another. [R7]
6. Grant `contents: read` and `id-token: write` only where needed. Verify npm provenance on the resulting package when eligible; a public npm package alone does not guarantee provenance from a private source repository. [N1]
7. Pack once for final inspection, record its integrity, and publish that inspected package through the supported npm flow; prevent any unreviewed rebuild or generated-file change between verification and publication. Test this packaging flow rather than assuming lifecycle scripts preserve the exact bytes.
8. Install the published version into a fresh environment and repeat the credential-free smoke test. Document capabilities that have live evidence separately from those covered only by fixtures. An existing npm version is never blindly republished after a timeout: reconcile the registry's version and integrity first.

Illustrative consumer configuration after a successful release; no secret is embedded:

```json
{
  "mcpServers": {
    "cloudkit": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=@thatfactory/cloudkit-mcp@0.1.0",
        "cloudkit-mcp",
        "serve",
        "--profiles",
        "/absolute/path/to/cloudkit-profiles.json"
      ]
    }
  }
}
```

The final README must use the actual implemented CLI/schema and a released pinned version, not copy this illustrative configuration without testing it. The final README must not mention other projects like WortJagd or app-store-connect-mcp; treat it as an isolated package, which it is. Fix the badges of the final README, as they were copied from the app-store-connect-mcp project. Fill the `// TBD` sections of the final README where appropriate, or remove the section if no longer needed; you can also add sections that are missing.

**Exit gate:** all applicable MVP requirements have either demonstrated behavior or evidence-backed platform limitations; the core private/shared inventory workflow is proven; exact-head review and repository/release gates pass; the authorized package can be installed and discovered without credentials.

- [x] Deterministic transport/signing adversarial coverage complete.
- [x] Credential/session concurrency and recovery adversarial coverage complete.
- [x] Query, pagination, date/number, error, and projection adversarial coverage complete.
- [ ] Change, sharing, subscription, and comparison adversarial coverage complete.
- [ ] Privacy-safe release-candidate live acceptance complete for the configured profiles.
- [ ] Human-gated account-switch, expiry, server-key, and exact-selector evidence completed or retained as explicit limitations.
- [ ] README and public capability contracts reconciled with final evidence.
- [x] Package-content and external-install gates complete.
- [ ] Release-path byte identity and offline preflight gates complete.
- [ ] Final applicable governance and exact-head review complete.
- [ ] Owner-authorized npm bootstrap/publishing configured.
- [ ] Released artifact integrity, provenance where eligible, and post-publish smoke verified.

### Phase 11 - Optional future mutations: explicitly deferred

This phase is not required for `0.1.0` and must not be implemented as part of the read-first MVP. It requires a separate product decision and authorization. Reserve architecture boundaries, not public mutation tools or unused production code.

If writes are later justified, introduce plan-only behavior first, then separately reviewed apply/reconcile behavior, following the reference discipline. [H1, R5]

A future immutable plan must bind the container, environment, database, canonical zone owner/name, record identity, authenticated principal/epoch, policy versions, selected operations, dependencies, and relevant change tags/preconditions. Legitimate token rotation is not a new user, but reauthentication or an account switch invalidates the plan. Payloads remain private; review summaries and durable journals are redacted.

`--allow-writes` is an operator startup capability, not an agent-controlled setting. It is necessary but insufficient: the host must obtain authorization for the exact reviewed operation subset. Echoing a digest is not proof of human approval. Untrusted record text, repository contents, or model-generated confirmation cannot grant consent.

Revalidate preconditions, write a durable in-flight journal entry before dispatch, serialize overlapping operations, and verify readback. Preserve `notStarted`, `started`, `completed`, and `uncertain` outcomes with a separate rejection reason where needed. Do not replay an uncertain create, invitation operation, or destructive change. Reconciliation reads state; it does not silently execute remaining work. There is no promised global rollback or distributed lock against other CloudKit clients.

Test retry/replay hazards, partial batches, concurrent edits, expired authorization, deleted/recreated zones, lost responses, process death, journal corruption, and changed identity. A mutation must remain unreachable until planning, authorization, preconditions, recovery, and exact-head review all exist.

## 6. Mandatory validation matrix

This matrix supplements the phase-specific tests; it is not a reason to postpone testing until the end.

| Concern | Minimum scenarios |
| --- | --- |
| Offline behavior | Help/version/server discovery/static resources with absent credentials and network forbidden |
| Authentication | Wrong key/class, signature/body/path mismatch, expired user token, account switch, rotation, lost response, concurrent reuse, atomic-store failure |
| Identity | Same record/zone name in different owners/scopes/environments; owner/private versus participant/shared; identical account behind two profiles |
| Permission boundaries | Profile-denied scope, public-only credentials against private/shared, selected-field policy bypass, SDK hidden mutations, no fallback credentials |
| Query correctness | Unindexed field, missing query index, lagging index, typed filter validation, exact-name lookup contrast, precision-preserving numbers |
| Pagination | Empty pages, repeated markers, partial pages, changed query, context mismatch, bounded local remainder, nonpaginated large collections |
| Change feeds | Tombstones, per-zone partial failure, expired cursor, baseline versus history, unsupported default zone, native/web token mismatch |
| Sharing | Root versus zone-wide, caller roles, hidden participant details, revoked access, missing metadata, invited-only/public-permission variants where supported |
| Errors and transport | 401/403/429/5xx, HTTP 200 with item errors, invalid UTF-8/JSON, slow streams, redirects, URL manipulation, output bound failures |
| Privacy | Nested credentials/PII, record contents, query values, share URLs/short GUIDs, raw IDs, SDK exceptions, asset URLs, callback logs, prompt-injection payload |
| Resource limits | Excessive records/zones/participants, large fields, cursor registry exhaustion, queue exhaustion, cancellation, bounded retry guidance |
| Comparison | Partial success, non-atomic observation windows, uncertain identity mapping, unmatched metadata, missing local app evidence |
| Packaging | Clean build, allowlisted tarball, no secrets/dev dependencies, external installation, correct CLI/version/resources, protocol-only stdout |
| Release | Exact tag/source/version, post-review changes, moved tags, unauthorized release path, wrong OIDC identity, duplicate publication, integrity reconciliation |

Use injected clocks, transports, IDs, and deterministic scheduling controls rather than sleep-dependent tests. Positive live captures from a test container may be converted into reviewed synthetic contracts, but retain honest provenance and the scope of what each test proves. Do not label a mock as successful Apple integration.

## 7. Handoff acceptance questions and required evidence

| Handoff question | Tools / evidence | Acceptable limitation |
| --- | --- | --- |
| Does a named record exist, and in which environment/database/zone? | Explicit context plus `get_records`; owner-aware zone identity | Not found in the requested view, inaccessible, or unverified; no global nonexistence claim |
| Do owner and participant see the same record/change metadata? | Independently authenticated views and `compare_views`, with verified correspondence | Partial/inconclusive observations, metadata not comparable, or account verification required |
| Is a zone shared, who owns it, and what is the caller's role? | `get_zone` / `get_share`, observed topology and owner alias | Specific missing mode/role metadata from this backend; no guessed share mode |
| Are expected subscriptions and change state present? | Supported subscription class plus database/zone change evidence and coverage | Backend cannot inspect the relevant subscription class or app-local cursor |
| Is the problem upload failure, visibility mismatch, stale client cursor, or something requiring Console? | Scoped evidence, exact lookup, comparison, available change state, explicit hypotheses | Upload failure/stale app cursor not established without local client evidence; name the remaining manual inspection |

For a supported operation, permission or session failures must be actionable errors, not presented as platform limitations. For a genuine unsupported secondary capability, the agent must be able to understand the limitation from tool results alone. A still-unverified core private/shared path is a release blocker for the advertised WortJagd MVP, not a reason to weaken the security model.

## 8. Decision and evidence log to maintain in this file

Populate these during implementation. Do not replace `pending` with `verified` on the basis of documentation alone.

| Decision / evidence | Initial state | Required resolution |
| --- | --- | --- |
| Reference repository baseline | Inspected: `6d818dd57cbdf7b079388be14fb7a1cdc9060f02` | Record any deliberate baseline update |
| Authenticated-user backend | Owner/private and ordinary-participant/shared verified live on 2026-09-14: browser callbacks supplied `ckSession`; requests used the `ckSession` query parameter, replacement sessions arrived in `x-apple-cloudkit-web-auth-token`, and serialized rotation remained certain | Retain this contract in regression tests; CKTool JS remains excluded because it does not establish this ordinary-participant diagnostic surface |
| Normal participant-account authentication | Verified live on 2026-09-14 with the consenting invited participant account, without assuming developer-team enrollment | Repeat during release acceptance and account-switch testing |
| Owner/private and participant/shared named lookup | Verified live on 2026-09-14: independent exact lookups of `WortJagdFamily` / `inventory` observed matching `WJInventory` type, change tag, creation time, and modification time | Extend to selected entry records when an operator supplies their exact non-content identifiers |
| Shared-zone discovery | `changes/database` from `beginning` returned one process-bound shared-zone handle with no errors and no additional page; generic shared `zones/list` remains deliberately gated as unverified | Keep change-based discovery explicit, or separately prove and enable shared `zones/list` |
| Zone-wide share discovery/mode | `get_share` returned the explicit `unavailable` outcome from both owner and participant views for the canonical inventory record | Treat share mode/role as unavailable through this backend unless a later live contract proves otherwise |
| Native database subscriptions through selected API | Owner/private `GET subscriptions/list` returned one database subscription; shared subscription listing remains outside the documented enabled scopes | Retain the owner/private contract and its precise shared-scope limitation |
| Minimum-field upstream projection | Verified live for exact record lookup and zone changes: `desiredKeys: []` returned a `fields` dictionary with zero entries while metadata remained available | Retain a content-free wire-contract regression and do not claim that unrelated endpoints share this behavior |
| Public API-token probe | Verified live on 2026-09-14: Apple accepted the configured API token and returned the documented user-authentication challenge without authenticated database access or session mutation | Keep challenge classification narrow; it does not prove public record or zone permission |
| User credential import and storage | Owner and participant sessions were separately imported, principal-bound, and repeatedly rotated during live reads on 2026-09-14 without entering uncertain state; restarted installed-MCP probes repeated owner/private and participant/shared access with certain rotation on 2026-09-14; synthetic account-switch coverage now preserves the prior binding and makes the rotated slot unusable until explicit reauthentication | Repeat the live account-switch and expiry cases during release acceptance |
| Query/date/number/error wire contracts | Adversarial synthetic coverage validates bounded typed scalar and homogeneous `IN` filters, precision-loss rejection, exact wire dictionaries, strict record collections, identity-correlated lookup, empty partial pages, context-bound markers with cycle detection and full-page registry pressure, query-lag versus exact-lookup semantics, privacy-safe top-level and per-item errors, malformed dates and record identities, numeric-string preservation, explicit nested identity/asset redaction, unexpected-field omission, and aggregate projection exhaustion; the exact unavailable-index provider code and all live wire behavior remain pending | Resolve provider differences during live acceptance without weakening the closed registry |
| Runtime/platform support | Node 24+ with a POSIX-only credential-store claim; local Node 25 package gate passes | Add other platforms only with their own credential-store evidence |
| npm scope/name/publisher | Registry lookup found the package name unclaimed; publishing workflow is configured but authority is not assumed | Owner configures trusted publishing and separately authorizes a release |
| Full live acceptance | Two-account core read acceptance run on 2026-09-14 with CloudKit Web Services v1 and Node 25: identity probes, private zone list/lookup, shared database/zone changes, matching canonical named-record reads, empty-field projection, and owner subscription listing passed; no mutations | Complete the remaining adversarial, secondary-capability, exact-head release, and publication gates before release |
| Exact-head code review | Not performed by this plan | Record actual PR/base/head and result |
| npm publication | Not authorized or performed by this plan | Owner-authorized release with integrity and install evidence |

## 9. Sources and provenance

References below distinguish supplied requirements, observed repository patterns, and outside primary documentation. Access date for this planning audit: 2026-09-13. URLs are provided as reproducible source identifiers. These sources do not substitute for the implementation's live capability tests.

### Supplied context

**[H1] CloudKit MCP handoff.** User-provided `CloudKitMCP.md`, read in full. The later naming decision changes `cloud-kit-mcp` to `cloudkit-mcp`; its read-first scope and safety requirements remain intact. No real container identifier, deployed record schema, account credential, or verified live capability matrix was supplied.

### Reference repository at immutable commit

All R-series references use commit `6d818dd57cbdf7b079388be14fb7a1cdc9060f02` of `thatfactory/app-store-connect-mcp`.

**[R1] Package metadata and validation scripts.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/package.json`

**[R2] Architecture and trust boundaries.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/Documentation/Architecture.md`

**[R3] MCP server composition and packaged resources.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/src/server.ts`

**[R4] Bounded transport and HTTP-method effect classification.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/src/api/client.ts`

**[R5] Plan authorization, execution, uncertainty, and recovery.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/Documentation/Plan-and-Apply.md`

**[R6] Package validation and release/publication process.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/Documentation/Release.md`

**[R7] Immutable-release preflight and npm publishing workflow.** `https://github.com/thatfactory/app-store-connect-mcp/blob/6d818dd57cbdf7b079388be14fb7a1cdc9060f02/.github/workflows/publish.yml`

### Primary CloudKit documentation

**[A1] Composing Web Service Requests.** API-token, user-session, server-key, request-signing, and token-lifecycle baseline. Archived documentation; validate current behavior and exact encoding before enabling an adapter. `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html`

**[A2] Fetching Records by Record Name (`records/lookup`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/LookupRecords.html`

**[A3] Fetching Records Using a Query (`records/query`).** Indexed-query semantics, asynchronous index updates, selected fields, and continuation markers. `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/QueryingRecords.html`

**[A4] Fetching Zones (`zones/list`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/GettingAllZones.html`

**[A5] Fetching Zones by Identifier (`zones/lookup`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/GettingZonesbyIdentifier.html`

**[A6] Fetching Database Changes (`changes/database`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/FetchingDatabaseChanges(changeszone).html`

**[A7] Fetching Record Zone Changes (`changes/zone`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/FetchingRecordZoneChanges(changeszone).html`

**[A8] Types and Dictionaries.** Zone ownership, record/reference metadata, share participants, and caller participation. Archived examples contain inconsistencies; captured contracts must resolve behavior rather than silently treating every example as normative. `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/Types.html`

**[A9] Automating CloudKit Development.** CKTool JS and the distinct management/user token boundary; interactive automation user tokens. `https://developer.apple.com/icloud/cloudkit/automating/`

**[A10] Using cktool.** Official token setup and automation workflow; not a requirement to shell out to Xcode from the npm server. `https://developer.apple.com/icloud/ck-tool/`

**[A11] Fetching Subscriptions (`subscriptions/list`).** `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/GetSubscriptions.html`

**[A12] Deprecated Fetching Record Changes (`records/changes`).** Points to `changes/zone`; retained here to prevent adopting the deprecated route. `https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ChangeRecords.html`

### MCP, npm, and repository workflow

**[M1] MCP tools specification.** Use the version actually supported by the chosen official SDK and target clients; the retrieved specification was dated 2026-07-28. `https://modelcontextprotocol.io/specification/2026-07-28/server/tools`

**[N1] npm trusted publishing.** OIDC configuration, supported runners/toolchain, direct-publish permissions, and provenance eligibility. Reverify at release. `https://docs.npmjs.com/trusted-publishers/`
