# Namecheap deployment preparation and bounded source sync

## What this release does

The Namecheap runtime-prep branch receives a bounded set of API/library source updates from Hatchable v656. The eight deployed files are:

- `api/admin/marketers.js`
- `api/admin/password-reset.js`
- `api/admin/register-agent.js`
- `api/agent-document.js`
- `api/marketer/withdrawals.js`
- `api/network/register-agent.js`
- `lib/agent-welcome-email.js`
- `lib/network-update.js`

The transfer is performed by `.github/workflows/deploy-namecheap-v656-api-batch.yml` after a push to `namecheap-runtime-prep` changes one of those paths.

## What is deliberately not deployed

- Hatchable-only local marketer-import APIs and the local-import admin page.
- SQL migrations 155, 157, 158, 159, and 160 (audit/source parity only; never auto-executed).
- `hatchable.toml`, seed files, database exports, marketer records, wallet balances, private credentials, backups, and storage archives.
- Static UI files. The previous remember-me admin login page was already synchronized separately; this batch avoids retriggering the broad static-UI deployment workflow.

## Safety checks and deployment behavior

Before SSH, the workflow:
1. Installs the repository dependencies using Node.js 20.
2. Runs `npm audit --omit=dev --audit-level=high`.
3. Runs the repository-wide Node syntax check.
4. Tests PBKDF2 password hashing and legacy password verification.
5. Starts the Namecheap Node runtime locally in the runner and checks the health route, home page, login page, and expected method behavior for the admin login route.

Then it:
1. Pins the previously verified SSH host key and loads the existing Namecheap SSH key from GitHub Actions secrets.
2. Transfers only the eight allowlisted source files to a private staging directory.
3. Checks the live app root and all target files.
4. Creates timestamped backups beside every existing target.
5. Installs the new files atomically and verifies each installed file against the staged source.
6. Touches the application's restart marker and reports the backup paths.

An unsuccessful preflight stops before transfer. A failed file install invokes the rollback handler using the backups. GitHub Actions must report a successful run before this sync can be considered complete.

## Critical database and storage rules

- Keep production connected to the original Hatchable PostgreSQL database unless a separately designed and tested migration plan is approved.
- Do not execute `migrations/*.sql` or `seed.sql` against the original database as part of this sync.
- The code transfer does not migrate media or copy existing Hatchable object-storage files.
- No wallet balance, settlement, BV, marketer, or other member data is modified by this workflow.

## Scope limit

This is an API/library file sync, not a complete migration of the entire Hatchable v656 runtime to Namecheap. It intentionally leaves the Node server entrypoint, compatibility adapter, dependencies, environment values, static pages, database, existing media, and DNS untouched.
