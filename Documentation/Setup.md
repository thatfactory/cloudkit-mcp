# CloudKit MCP setup

CloudKit MCP keeps non-secret policy in a profile file and secrets in a separate owner-only credential store. Agents may use the configured MCP tools, but initial credential import is deliberately an interactive terminal step so secrets never enter chat, MCP arguments, environment variables, or repository files.

## Requirements

- Node.js 24 or newer.
- A CloudKit container and credentials for each view you want to inspect.
- A POSIX system for the built-in credential store. Windows credential storage is not currently claimed.

For private or shared Web Services access, provide a CloudKit API token and an already-acquired web-authentication token. CloudKit MCP does not automate Apple's login redirect or callback flow. Apple documents obtaining a web token through that flow or from a signed-in native app with `CKFetchWebAuthTokenOperation`.

## Create a profile file

Profiles are immutable startup policy. A tool call cannot expand their scopes, record types, query fields, or readable payload fields.

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
        "allowedTypes": [],
        "queryableFields": [],
        "readablePayloadFields": [],
        "discloseRecordNames": false,
        "discloseZoneNames": false
      }
    }
  ]
}
```

Keep this non-secret file outside the repository if it contains project-specific identifiers. Use absolute paths when configuring the MCP server.

Record policy is deny-by-default:

- Empty `allowedTypes` makes `query_records` unavailable.
- Empty `queryableFields` disables filtered queries; an allowed type may still use a zero-filter query.
- Empty `readablePayloadFields` makes `read_record_fields` unavailable while metadata-only exact lookup remains usable.
- Names remain opaque unless their individual disclosure flags are enabled.

## Import credentials once

Run this in a private interactive terminal. Replace the paths and profile ID; never paste the requested secret into chat or a command argument.

```sh
npx --yes --package=@thatfactory/cloudkit-mcp@0.1.0 cloudkit-mcp auth import \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

The prompt disables terminal echo. The store creates one owner-only slot for the profile's `credentialRef`. Keep the store outside repositories and synchronized folders.

Safe credential state can be checked without revealing its contents:

```sh
npx --yes --package=@thatfactory/cloudkit-mcp@0.1.0 cloudkit-mcp auth status \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

`auth remove` deletes only the selected local slot; it does not claim to revoke a remote Apple credential.

## Authentication modes

### Public API token

Use `authenticationMode: "api-token-public"` with `allowedScopes: ["public"]`. A successful `probe_access` may prove only Apple's documented user-authentication challenge: `apiTokenAccepted: true`, `userAuthenticationRequired: true`, and `accessible: false`. It does not prove authenticated public database access.

### Web user

Use `authenticationMode: "web-user"` for explicitly allowed public, private, or shared scopes. The credential contains both the API token and an already-acquired web-authentication token. Successful calls rotate Apple's replacement session atomically; uncertain or expired sessions fail closed until reauthentication.

### Server key

Server-key signing for public reads is implemented and synthetically verified, but it is not live verified in `0.1.0`.

## First connection check

After configuring Codex or Claude Code, ask the agent to call `get_context` first. It reads only offline policy. Then ask it to call `probe_access` for one explicit profile and scope. Continue to database tools only when the probe establishes the expected access; an API-token-only authentication challenge is not database authorization.

