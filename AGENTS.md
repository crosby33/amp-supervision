# Working on amp-supervision

This repository owns the bridge and portable supervisor skill. Keep client-specific
setup in references; do not make a particular supervisor model or issue tracker mandatory.
An implementation worker works in its original thread. This repository is not authority
to dispatch an implementation child or to adopt the supervisor role.

- Keep the Bun runtime, official MCP SDK, Zod and SQLite journal. Use existing APIs
  before adding dependencies. Strict TypeScript is required.
- Run `bun install --frozen-lockfile`, `bun run check` and `bun run build:skill`.
  Tests use fake Amp executables and temporary journals; never live account credentials.
- Live acceptance is opt-in and costs inference. Do not invoke it without approval.
- Preserve ambiguous requests, journal sharing, exact request correlation and human
  approvals. Prompt rules are not a sandbox or proof of model compliance.
- Never run a credential-bearing installation from an unreviewed candidate. Do not
  change an existing installed bridge, skill, runner or journal as part of development.
- Keep private paths, account identifiers, real thread transcripts, tokens and journals
  out of commits and packages. Public Git identities must not expose personal email.
- Publishing private-derived source, releases, merging, deployment and access changes
  require the operator's approval. Review evidence is not a merge-readiness verdict.
