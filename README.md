# Together Network Marketing — Namecheap staging branch

This branch keeps the existing Namecheap Node.js runtime-preparation baseline (package version `435.0.0-namecheap-prep`) and overlays a reviewed 27-file source delta from Hatchable project version v656.

## What was synced

- 27 Hatchable source files last changed between 2026-10-29 and 2026-10-31.
- All 27 files were re-read from Hatchable and verified byte-for-byte against this branch.
- 17 paths differ from the existing Namecheap runtime-prep branch; the other 10 already matched.
- The delta includes security/authentication changes, marketer/network APIs, the local marketer-import admin tooling, related libraries, and SQL migration files 155, 157, 158, 159, and 160.
- The target branch's existing Node.js runtime, compatibility adapter, deployment workflows, and configuration were retained.

## Important scope limit

This is **not** a complete Hatchable v656 source export or a production-ready Namecheap deployment. Only the recent 27-file delta was added. Older source changes outside this delta were not re-exported here, and the Node runtime remains versioned `435.0.0-namecheap-prep`. No compatibility run or end-to-end staging test has been completed for the complete delta.

## Data and database safety

- No marketer source export, customer/member data, wallet records, balance histories, database dump, seed data, backups, or credentials were committed.
- `migrations/*.sql` are included for source parity and audit only. **Do not run migrations or `seed.sql` on Namecheap or against the original Hatchable database.**
- Keep production on the original Hatchable PostgreSQL database unless a separately tested migration plan is approved.
- Existing Hatchable object-storage media are not copied into Git; media access requires a verified shared-storage integration or separate migration.

## Before any deployment

1. Keep this branch as a staging/review branch; do not merge to the live deployment branch merely to make these files appear on Namecheap.
2. Review the temporary local-import endpoints (`api/admin/local-import-*.js` and `public/admin/local-import.html`) and decide whether they belong on Namecheap at all.
3. Run the Node.js syntax check and runtime smoke tests on a separate staging application with non-production test accounts.
4. Verify compatibility of the new API/library files with the Namecheap `hatchable` adapter, authentication/session behavior, database access, storage/media, email, OneSignal, cron, and critical admin/marketer flows.
5. Only then prepare a complete allowlisted deployment with a fresh server backup and a verified rollback path.

The existing push-triggered Namecheap workflows deploy only selected paths; they do not deploy this full 27-file delta. This branch and its draft pull request have not changed the live Namecheap server.
