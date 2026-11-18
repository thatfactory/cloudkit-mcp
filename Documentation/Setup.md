# CloudKit MCP setup

CloudKit MCP keeps non-secret startup policy in a profile file and secrets in a separate owner-only credential store. Set up credentials first, register `serve`, then check the intended account through MCP. Registration does not sign in to Apple or import credentials.

## Requirements

- Node.js 24 or newer and a POSIX system for the built-in credential store.
- A CloudKit container and credentials for each account view.
- A local browser for automatic Post Message recovery. Headless systems can use manual import.

## Create a profile file

Profiles are immutable startup policy. A tool call cannot expand scopes, record types, query fields, or readable payload fields. A `credentialRef` may be shared only within the same container, environment, and authentication mode.

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

Use absolute paths. Keep project-specific profile files outside the repository, and the credential store outside repositories and synchronized folders.

Record policy is deny-by-default:

- Empty `allowedTypes` makes `query_records` unavailable.
- Empty `queryableFields` disables filtered queries; an allowed type may still use a zero-filter query.
- Empty `readablePayloadFields` makes `read_record_fields` unavailable while metadata-only exact lookup remains usable.
- Names remain opaque unless their individual disclosure flags are enabled.

## Import credentials once

Run this in a private interactive terminal. Neither secret belongs in chat, command arguments, MCP arguments, or environment variables.

```sh
npx --yes --package=@thatfactory/cloudkit-mcp@0.3.0 cloudkit-mcp auth import \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

For `web-user`, two separate hidden prompts appear:

1. **CloudKit API token:** the API token created in CloudKit Console → the intended container and environment → Tokens & Keys. It identifies the Web Services configuration.
2. **CloudKit web authentication token:** a fresh Apple-issued `ckWebAuthToken` or `ckSession` for the intended Apple Account. The API token is not this user-session token.

Obtain the initial web token through an existing supported callback consumer for that API token, or a signed-in native app using `CKFetchWebAuthTokenOperation`. [Apple documents token acquisition and rotation](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html). Check the API token's **Sign in Callback** setting:

- **Post Message:** Apple sends the token to the page that opened the sign-in window. It is not a token to find in the address bar. A supported callback consumer receives the message; do not paste its contents into chat.
- **URL Redirect:** Apple sends the token to the configured return URL. Use that existing trusted callback consumer. The connector's automatic recovery supports Post Message; URL Redirect configurations use manual import.

Import creates or explicitly replaces the selected owner-only slot, starts a new principal epoch, and supersedes any recovery attempt. Ctrl+C at either prompt cancels locally, restores the terminal, exits with code 130, and leaves existing credentials unchanged. Import does not contact Apple or prove the tokens work.

Safe local status is available without contacting Apple:

```sh
npx --yes --package=@thatfactory/cloudkit-mcp@0.3.0 cloudkit-mcp auth status \
  --profile owner-development \
  --profiles /absolute/path/to/cloudkit-profiles.json \
  --credential-store /absolute/private/path/cloudkit-credentials
```

`available` means the slot can be read; `usable` means it contains a session eligible for use. `principalBound` reports whether a current-user probe established the intended principal. `recovery` reports safe recovery progress. A saved slot may be available while its session is suspended.

`auth remove` deletes only the selected local slot and supersedes recovery. It does not revoke a remote Apple credential.

## Register and check the connector

The README's Codex and Claude Code commands run `serve` against the existing profile and credential store. They do not perform the import above. Restart the MCP client after changing its server command or package version.

Call `get_context` first. It reads only offline policy and static recovery guidance. Then call `probe_access` for one explicit profile and allowed scope. A successful web-user probe binds the current principal. Continue to database tools only when the probe establishes the expected access.

## Automatic session recovery

`serve` defaults to `--recovery-mode post-message`. When an established web-user session expires or becomes uncertain, the connector starts one recovery attempt for its credential slot. Concurrent requests join that attempt, including requests from other server processes.

1. The connector opens a temporary local recovery page.
2. Click **Open Apple sign-in** and use the same Apple Account as the affected profile. Apple may ask for sign-in, two-factor verification, or consent. A browser popup permission may also be needed.
3. The page receives the supported Apple callback directly. The connector verifies the intended principal and durably stores Apple's replacement session token.
4. The agent calls `recover_session` with `action: "status"`. After `succeeded`, it may retry a read proven `notStarted` once. A completed or uncertain request retains its original outcome; a fresh observation must be initiated deliberately.

Tokens never need to be copied or pasted during supported recovery. Recovery does not change the profile's read permissions or switch accounts. Same-account recovery preserves the principal epoch and existing handle context; normal handle expiration still applies. Explicit account changes require manual import and invalidate the previous epoch.

Use `recover_session` with `action: "cancel"` and the returned `attemptId` to cancel the selected attempt. Closing the sign-in window or cancelling the page also cancels. Attempts time out after ten minutes. Cancelled or failed attempts remain unavailable until an explicit `action: "start"` or manual import; repeated failed reads do not repeatedly open windows.

For an API token restricted to specific origins, configure a permitted loopback origin and a fixed `serve --recovery-port <port>` matching it. The default port is ephemeral (`0`). The challenge carries the local page's actual origin. The connector does not change the API token's callback or origin settings. If that configuration cannot support a local Post Message flow, use `--recovery-mode manual` and hidden-terminal import.

Missing API configuration, an unbound legacy principal, unsafe storage, or an unverifiable legacy lock requires local setup or repair. Existing version-one slots migrate under their lease. Suspended slots retain the API configuration and principal binding, while consumed web tokens are removed. Proven-dead lock owners can be reclaimed; lock age alone never authorizes reuse.

For immediate data inspection, read [Troubleshooting](../resources/troubleshooting.md). CloudKit Console's **Act As iCloud Account** is independent of the MCP session.

## Other authentication modes

### Public API token

Use `authenticationMode: "api-token-public"` with `allowedScopes: ["public"]`. A successful `probe_access` may prove only Apple's documented user-authentication challenge: `apiTokenAccepted: true`, `userAuthenticationRequired: true`, and `accessible: false`. It does not prove authenticated public database access. Automatic user-session recovery does not apply to this mode.

### Web user

Use `authenticationMode: "web-user"` for explicitly allowed public, private, or shared scopes. The API token is retained separately from session usability so expired or uncertain sessions can recover for the previously verified account.

### Server key

Server-key signing for public reads is implemented and synthetically verified. Historical acceptance has not established live verification for this mode.
