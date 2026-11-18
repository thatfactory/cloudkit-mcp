# CloudKit authentication and data inspection

## Choose the shortest supported path

Call `get_context`, then `probe_access` for the intended profile and scope. If authentication fails, inspect the returned `recovery` separately from the triggering request's `execution`.

- `starting`, `awaitingUser`, or `verifying`: the connector is handling recovery. Let the operator complete Apple's sign-in or verification in the local page, then check `recover_session` with `action: "status"`.
- `succeeded`: retry a read proven `notStarted` once after revalidating its inputs and handles. For a completed or uncertain request, initiate a fresh observation deliberately; recovery does not turn its earlier outcome into success.
- `failed`, `cancelled`, or `manualRequired`: follow the safe reason. Use an explicit recovery restart after fixing the cause, or hidden-terminal `auth import`. Do not extract credentials from browser storage, invent one-off login helpers, or ask for tokens in chat.

When the immediate question is “are these records visible to this account?”, CloudKit Console can answer it even while MCP recovery needs attention. Use Apple's built-in account inspection before designing another authentication mechanism.

## CloudKit Console: Act As iCloud Account

1. Open CloudKit Console using the developer account authorized for the container.
2. Select the intended **container and Development or Production environment**. Match the build and diagnostic question; do not infer the environment from the account.
3. Choose **Act As iCloud Account** → **Open Sign In Window**. The operator signs in with the intended test or user account and completes Apple's prompts.
4. Confirm the **Acting as iCloud Account** banner and the intended account before inspecting the relevant database, zone, and records. Developer Console sign-in alone does not select another account's private database.
5. Inspect only the data needed for the authorized diagnostic. Keep account identifiers, record contents, and temporary URLs out of logs and public evidence.

Changing containers or environments, entering schema tools, or stopping the acting-as session ends that account context. Reconfirm the banner after navigation. Acting as another account does not decrypt its encrypted fields. These are boundaries of [Apple's Act As iCloud walkthrough](https://developer.apple.com/videos/play/wwdc2022/10115/?time=163).

The Console session and the MCP credential store are independent. Successful Console sign-in does not restore the MCP session, and Console cookies or tokens are not a credential-export interface. Use the Console when it can answer the immediate question; use MCP recovery for subsequent MCP reads.

## Interpret evidence accurately

Prefer exact-record lookup when the record names and owner-aware zone are already known. Queries depend on indexes; an empty query, missing index, inaccessible view, or unavailable operation does not establish that an upload failed. If a Console query needs an index, report that limitation and use an existing exact-lookup path or MCP `get_records` after recovery. Do not alter schema solely to complete a read-only diagnostic.

Matching metadata is bounded server-visibility evidence. It does not establish payload equality, client checkpoint correctness, notification delivery, or that an app applied a change. Keep those questions separate from authentication recovery.

## Manual setup and local repair

`serve` registers the connector against an existing store. `auth import` is the manual fallback and requests two distinct hidden inputs for a web-user profile: the container/environment API token and a fresh Apple-issued web token. Post Message delivers the web token to the opener page; URL Redirect delivers it to the configured return URL. Check that setting rather than telling an operator to search for a token in the wrong place.

Use `auth status` to distinguish a readable slot (`available`) from an eligible session (`usable`). Import does not validate against Apple; follow it with `probe_access` to bind the intended account. Ctrl+C during import is a local cancellation and changes no credentials.

For `principalMismatch`, sign in with the previously bound account. An account change requires an explicitly initiated manual import with a new epoch. For `principalUnbound` or missing configuration, establish the intended account through manual setup. For `browserUnavailable` or an incompatible URL Redirect/origin configuration, use manual mode or correct the supported Post Message configuration. An origin-restricted token may need a fixed `--recovery-port`.

For local storage failures or a legacy lock with unverifiable ownership, repair the owner-only store and inspect running processes before removing any lock. A timestamp alone does not prove that a rotating-token request stopped. The connector can reclaim only locks whose recorded owner is provably gone.
