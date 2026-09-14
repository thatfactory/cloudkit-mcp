<p align="center">
  <a href="https://developers.openai.com/codex/mcp"><img alt="Codex MCP" src="https://img.shields.io/badge/Codex-MCP-1F70C1.svg?logo=icloud&logoColor=white"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code/mcp"><img alt="Claude MCP" src="https://img.shields.io/badge/Claude-MCP-D97757.svg?logo=claude&logoColor=white"></a>
  <a href="https://en.wikipedia.org/wiki/MIT_License"><img alt="License" src="https://img.shields.io/badge/License-MIT-67ac5b.svg?logo=googledocs&logoColor=white"></a>
  <a href="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/nightly.yml"><img alt="Nightly" src="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/nightly.yml/badge.svg"></a>
</p>

# CloudKit MCP

Inspect and debug account-relative CloudKit databases, records, zones, sharing, subscriptions, and change state through a secure, read-only MCP server. ☁️

> [!IMPORTANT]
> Version `0.1.0` is an implementation candidate until its live CloudKit and npm release gates are completed. Synthetic tests do not claim access to a real container or prove ordinary owner-to-participant sharing behavior.

## Safety model

- The distributed server contains no CloudKit mutation operation and rejects `--allow-writes`.
- Remote requests come from a closed operation registry and use only `https://api.apple-cloudkit.com`; redirects are rejected.
- Profiles are immutable startup policy. Tool calls cannot expand scopes, record types, queryable fields, or payload fields.
- User sessions are serialized across processes. CloudKit's single-use replacement token is committed atomically before another request can use the slot; uncertain sessions fail closed until reauthentication.
- Credentials remain in an explicitly configured owner-only local directory and never appear in profile files, MCP parameters, stdout, diagnostics, fixtures, or the npm package. The POSIX file store is access-controlled but not inherently encrypted.
- Record, zone, account, and cursor identifiers are projected as process-local opaque handles or keyed aliases by default. `read_record_fields` is the only payload-reading tool and requires exact policy-enabled fields.
- Returned record content is untrusted data, never instructions to change policy or invoke another tool.

## Requirements

- Node.js 24 or newer.
- A CloudKit container and the provider-specific credential material for the selected profile.
- POSIX ownership and mode semantics for the built-in local credential store. Windows credential storage is not claimed.
- An API token plus an already-acquired web-authentication token for private/shared user access, or a server-to-server key/API token for permitted public reads.

CloudKit web-authentication login/callback automation is intentionally not implemented yet. Obtain the initial token through an official, separately controlled interactive flow and import it only through the hidden terminal prompt. Never paste credentials into an MCP request, chat, environment variable, command argument, or repository file.

## Configuration

Profiles contain policy and credential references, never secret values:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "owner-development",
      "containerId": "iCloud.com.example.application",
      "environment": "development",
      "backend": "web-services",
      "authenticationMode": "web-user",
      "credentialRef": "owner-development",
      "allowedScopes": ["private"],
      "recordPolicy": {
        "allowedTypes": ["ExampleRecord"],
        "queryableFields": ["stableID"],
        "readablePayloadFields": [],
        "discloseRecordNames": false,
        "discloseZoneNames": false
      }
    }
  ]
}
```

Empty `allowedTypes` makes `query_records` unavailable for that profile. Empty `queryableFields` disables filtered queries, but an allowed record type can still use a zero-filter query. Empty `readablePayloadFields` keeps `read_record_fields` unavailable while metadata-only exact lookup remains usable. Add policy entries only for explicitly selected, privacy-safe schema elements.

Use absolute paths when starting the server. There are no credential environment variables and no automatic `.env`, browser-cookie, Keychain-enumeration, or repository configuration discovery paths.

## Authentication commands

The profile file is non-secret policy: it names the CloudKit container and environment, selects allowed database scopes, and allowlists record types and fields. You create it once for the container you want to inspect. `id` is a local human-readable label used in MCP calls and CLI commands; it is not assigned by Apple and may be changed as long as references use the same value. `credentialRef` is the local secret-slot name and may match `id` for a simple one-profile setup.

The `--credential-store` value is an absolute path to a private local directory managed by CloudKit MCP. It is not downloaded from Apple. `auth import` creates the directory with owner-only permissions and writes one credential slot per profile while reading secret values from hidden terminal prompts. Keep this directory outside the repository and do not synchronize it.

```sh
cloudkit-mcp auth import \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials

cloudkit-mcp auth status \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

`auth import` requires an interactive terminal and reads secrets with echo disabled. `auth remove` deletes only the chosen local slot; it does not claim to revoke the remote Apple credential.

For a first live test, use an `api-token-public` profile with `allowedScopes: ["public"]`. Create the reusable API token in CloudKit Dashboard under the selected container's API Access page, then import it using the command above. Calling `probe_access` with this profile validates the container, environment, and API token through Apple's documented authentication challenge without exposing its redirect URL. A successful token-only probe reports `apiTokenAccepted: true`, `userAuthenticationRequired: true`, and `accessible: false`; authenticated database access has not occurred yet.

Private and shared views require `web-user` and both that API token and a short-lived web-authentication token. Some public operations may also require user authentication depending on the container and operation. This version imports an already-acquired web token but does not implement Apple's sign-in redirect or callback flow. Apple documents obtaining one through the authentication redirect flow or, from a signed-in native app, `CKFetchWebAuthTokenOperation`.

After import, verify the safe local state without revealing the credential:

```sh
cloudkit-mcp auth status \
  --profile public-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store "/absolute/private/path/cloudkit-credentials"
```

Then start the server with those same two paths and call `get_context` followed by `probe_access` from your MCP client. `get_context` is offline and confirms the loaded policy before any authentication or CloudKit request occurs. Continue to `list_zones` only after `probe_access` reports authenticated access; an API-token-only authentication challenge does not prove zone access.

## Codex setup

Until a release is published, build the checked-out source and configure its absolute executable path:

```json
{
  "mcpServers": {
    "cloudkit": {
      "command": "/absolute/path/to/cloudkit-mcp/dist/index.js",
      "args": [
        "serve",
        "--profiles",
        "/absolute/path/to/cloudkit-profiles.json",
        "--credential-store",
        "/absolute/private/path/cloudkit-credentials"
      ]
    }
  }
}
```

After an authorized `0.1.0` npm release, replace the command with `npx` and pin `--package=@thatfactory/cloudkit-mcp@0.1.0` before the executable name.

## Claude Code setup

```sh
claude mcp add cloudkit -- \
  /absolute/path/to/cloudkit-mcp/dist/index.js serve \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

## Available tools

| Tool | Purpose |
| --- | --- |
| `get_context` | Offline profiles, policy, and capability state without credential or network access |
| `probe_access` | Minimal authentication/current-principal probe; a public API token may yield only the documented user-authentication challenge |
| `list_zones` | Bounded zone discovery for an enabled documented scope |
| `get_zone` | Exact owner-aware zone lookup |
| `get_records` | Metadata-first lookup of at most 20 exact records |
| `query_records` | Bounded typed indexed query with policy-enabled filters |
| `read_record_fields` | Explicit access to at most 10 policy-enabled payload fields |
| `get_share` | Privacy-safe share mode, role, permission, and participant-state summaries |
| `list_subscriptions` | Safe structural subscription summaries for supported scopes |
| `get_database_changes` | Changed-zone evidence using process-bound cursors |
| `get_zone_changes` | Record changes and tombstones using process-bound cursors |
| `compare_views` | Exact-record comparison using two authorized views and independent `leftZone`/`rightZone` selectors |

Generic shared `zones/list`/`zones/lookup` and shared subscription listing remain capability-gated because the published API documentation does not establish them. Shared-zone discovery instead uses the verified `changes/database` workflow. A tool reports an unverified limitation rather than interpreting it as an empty result.

Historical, operation-specific implementation and live-evidence scope is available from `cloudkit://capabilities`; `get_context` reports only configured offline profile policy, and `probe_access` proves only the selected authentication/current-principal check. Current evidence includes private/shared exact record lookup and shared change reads. It does not include live query wire behavior, live server-key signing, private change feeds, authenticated public database reads, or available share topology for the canonical live record.

## Example prompts

- “Show the configured CloudKit profiles and explain which capabilities are documented, implemented, live verified, and currently authorized.”
- “Look up these exact record names in the owner private view and participant shared view, then compare only the available metadata.”
- “Inspect the selected zone's share topology without returning participant identities or share URLs.”
- “Read zone changes from the beginning and explain exactly what bounded coverage the returned cursor provides.”

Change tools use an explicit discriminated start: `{ "kind": "beginning" }` or `{ "kind": "cursor", "handle": "..." }`. The Web Services implementation does not advertise `currentBaseline` because the reviewed public contract does not establish a distinct non-scanning baseline operation. It also does not retry requests automatically; safe errors instead state whether a caller retry is eligible.

## Local development

Release-event identity and the final tarball byte-identity path are tested without credentials or publication. These checks do not authorize an npm release; a future authorized workflow publishes only the exact tarball it inspected and smoke-tested.

```sh
npm ci
npm run check
npm pack --json --dry-run
```

`npm run check` performs schema/policy consistency, strict type checking, credential-free deterministic tests, a clean build, package-content verification, and installation/execution from a real tarball outside the checkout. Ordinary tests block or inject networking and contain synthetic data only.

Architecture decisions, capability gates, test expectations, and release evidence are maintained in [Documentation/ImplementationPlan.md](Documentation/ImplementationPlan.md). Approved dependency exceptions are recorded in [Documentation/Dependencies.md](Documentation/Dependencies.md).
