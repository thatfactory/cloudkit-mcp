<p align="center">
  <a href="https://developers.openai.com/codex/mcp"><img alt="Codex MCP" src="https://img.shields.io/badge/Codex-MCP-1F70C1.svg?logo=icloud&logoColor=white"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code/mcp"><img alt="Claude MCP" src="https://img.shields.io/badge/Claude-MCP-D97757.svg?logo=claude&logoColor=white"></a>
  <a href="https://en.wikipedia.org/wiki/MIT_License"><img alt="License" src="https://img.shields.io/badge/License-MIT-67ac5b.svg?logo=googledocs&logoColor=white"></a>
  <a href="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/nightly.yml"><img alt="Nightly" src="https://github.com/thatfactory/cloudkit-mcp/actions/workflows/nightly.yml/badge.svg"></a>
</p>

# CloudKit MCP

Give Codex, Claude Code, and other MCP clients a safe, read-only view into CloudKit. Inspect records and zones, follow change state, check subscriptions, and compare what two accounts can see—without handing database mutation access to the agent. ☁️

CloudKit MCP is especially useful for questions like:

- “Did this record reach CloudKit, and can the invited participant see it?”
- “Do the owner/private and participant/shared views have matching metadata?”
- “Which zones changed, and what bounded change evidence is available?”
- “Is this likely a server-visibility issue or something that still needs client-side sync evidence?”

## Quick start

You need Node.js 24+, a CloudKit container, a non-secret profile file, and credentials for each account view you want to inspect. Credential import is the only required interactive terminal step; secrets are read with echo disabled and never belong in chat or MCP arguments.

See **[Setup](https://github.com/thatfactory/cloudkit-mcp/blob/main/Documentation/Setup.md)** for the profile format, credential import, and authentication modes.

### Codex

Run this once, replacing both paths:

```sh
codex mcp add cloudkit -- \
  npx --yes --package=@thatfactory/cloudkit-mcp@0.1.1 \
  cloudkit-mcp serve \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

Restart Codex after changing MCP configuration so the new server process is loaded.

### Claude Code

```sh
claude mcp add cloudkit -- \
  npx --yes --package=@thatfactory/cloudkit-mcp@0.1.1 \
  cloudkit-mcp serve \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

Then ask your agent to call `get_context` before `probe_access`. The first call confirms offline policy; the second verifies one explicit account and database scope.

## What your agent can inspect

- Public, private, and shared views allowed by each profile.
- Owner-aware zones and exact record metadata.
- Policy-bounded indexed queries and selected payload fields.
- Privacy-safe sharing and subscription structure where supported.
- Database and zone changes through opaque, process-bound cursors.
- Independently authenticated owner/participant views of the same exact records.

The server ships no CloudKit mutation tool, and `--allow-writes` is rejected. Profiles are deny-by-default startup policy: an agent cannot expand scopes, record types, queryable fields, payload fields, or identity disclosure.

See **[Capabilities and limitations](https://github.com/thatfactory/cloudkit-mcp/blob/main/Documentation/Capabilities.md)** for the complete tool list, live-evidence boundaries, and guidance for interpreting results. MCP clients can also read the packaged `cloudkit://capabilities` resource.

## Safety at a glance

- Credentials stay in an explicitly configured owner-only local directory.
- Credentials never appear in profiles, tool results, stdout, fixtures, or the npm package.
- Web-user requests serialize session rotation and fail closed when session state is uncertain.
- Provider identities and cursors are opaque by default.
- Remote requests use a closed read-only registry and only Apple's fixed CloudKit Web Services origin.
- Record content is treated as untrusted data, never agent instructions.

## Example prompts

- “Show my configured profiles and explain what each one permits.”
- “Compare these exact records through the owner private and participant shared views using independently selected zones.”
- “Read changes for this shared zone and explain what the returned coverage does and does not prove.”
- “Check the available subscription structure without returning identifiers or notification payloads.”

## Development

```sh
npm ci
npm run check
```

The full check covers schema and policy consistency, strict type checking, deterministic security and contract tests, a clean build, package-content verification, and installation/execution from a real tarball outside the checkout.

Approved dependency exceptions are documented in **[Dependencies](https://github.com/thatfactory/cloudkit-mcp/blob/main/Documentation/Dependencies.md)**.
