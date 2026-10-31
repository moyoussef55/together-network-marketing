# Together Network Marketing — Namecheap staging branch

This branch is based directly on the existing Namecheap runtime-preparation branch and carries the reviewed Hatchable v656 source changes that are relevant to the Namecheap Node runtime.

## Source transfer scope

- The recent Hatchable source set was inspected and compared with the Namecheap base.
- The branch retains the Namecheap runtime adapter and existing hosting configuration.
- The deployable API/library batch is limited to:
  - `api/admin/marketers.js`
  - `api/admin/password-reset.js`
  - `api/admin/register-agent.js`
  - `api/agent-document.js`
  - `api/marketer/withdrawals.js`
  - `api/network/register-agent.js`
  - `lib/agent-welcome-email.js`
  - `lib/network-update.js`
- Files shared already with the Namecheap base are retained without duplicate changes.

## Explicit exclusions

- Hatchable-only local marketer import endpoints and their admin UI are not part of the Namecheap deployment allowlist.
- SQL migrations 155, 157, 158, 159 and 160 are retained as source/audit material only. They are **not executed** on Namecheap or against the original Hatchable database.
- `hatchable.toml` is source configuration, not a Namecheap runtime deployment file.
- No source-import JSON, member/marketer data, wallet balances, database dumps, seed data, backups, secrets, or binary storage exports are included in the Namecheap file transfer.
- The existing remember-me login UI was already synchronized to the Namecheap live files previously; it is not re-deployed by this batch.

## Deployment workflow

The workflow `.github/workflows/deploy-namecheap-v656-api-batch.yml` is configured to run only when one of the eight allowlisted API/library files changes on `namecheap-runtime-prep`. It installs dependencies, runs the production dependency audit, syntax checks, password-hash compatibility test, and a local runtime smoke test before opening an SSH connection. It transfers only the allowlist, creates timestamped backups of the existing server files, installs atomically, verifies file contents, and requests a Node application restart.

This workflow is a bounded file sync, not a complete Hatchable v656 runtime migration. It does not change Node package dependencies, server.js, environment variables, database schema, stored media, or DNS.

## Production data guardrails

- Keep production on the original Hatchable PostgreSQL database; do not point Namecheap at a new or empty database.
- Never run `migrations/*.sql` or `seed.sql` against that database as part of this file sync.
- Existing Hatchable object-storage files are not copied by this workflow. Media availability must be verified separately.
- If pre-deployment checks fail, SSH secrets are missing, or file verification fails, the workflow stops before reporting success. A failed atomic install restores the backed-up files.
