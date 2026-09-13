# Dependencies

The repository owner explicitly approved the runtime and development dependencies required to implement the supplied plan on 2026-09-13.

## Runtime

| Dependency | Version policy | Purpose | Native or first-party alternative |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | Exact `1.30.0` | Official TypeScript implementation of MCP server framing, stdio transport, tools, and resources | Reimplementing the protocol would increase interoperability and security risk and would contradict the implementation plan's official-SDK requirement |
| `zod` | Exact `4.6.2` | Runtime validation for untrusted configuration, MCP inputs, and CloudKit response projections; required peer dependency of the MCP SDK | Repository-owned validation remains responsible for policy semantics, but replacing the supported schema layer would duplicate a large security-sensitive surface |

Both packages use permissive licenses and are pinned exactly for reproducibility. Updates require an intentional compatibility and security review.

## Development tooling

TypeScript `7.0.2`, tsx `4.23.13`, and Node type declarations are development-only compiler/test tooling. They are excluded from the production tarball and are validated by the package allowlist smoke test.

No package may expand into CloudKit authentication, credential storage, arbitrary networking, telemetry, or mutation behavior. Those boundaries remain repository-owned.
