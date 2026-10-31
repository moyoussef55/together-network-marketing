# Namecheap deployment preparation

## Current branch status

The draft sync branch overlays 27 recently changed files from Hatchable project v656 onto the existing Namecheap runtime-preparation branch. All 27 files were verified byte-for-byte against Hatchable. Seventeen paths differ from the Namecheap branch; ten already matched.

This does **not** mean the whole Namecheap runtime is now v656. The existing Node runtime baseline remains `435.0.0-namecheap-prep`, and older source changes outside the 27-file delta have not been fully exported or compatibility-tested. Keep this branch in review/staging; do not treat it as a full production release.

## Critical data-safety rules

- Production must use the original Hatchable PostgreSQL database unless a separate migration plan is designed and tested. Do not point production at an imported or empty copy.
- Do not run `migrations/*.sql` or `seed.sql` against the original Hatchable database. The SQL files are included for source parity/audit only; Hatchable already manages its schema.
- Do not commit credentials, tokens, environment files, or marketer/customer exports. Configure real values only in the private Namecheap environment.
- Keep the Hatchable site live and unchanged while preparing and testing Namecheap.
- Existing Hatchable object-storage objects are not present in Git. The local storage adapter does not automatically fetch existing Hatchable media.

## Synced source delta

The current v656 sync branch contains 27 recently changed files covering:
- Admin/marketer authentication and security hardening.
- Marketer/network registration, access, withdrawal, and related library logic.
- Local marketer-import preview, audit, reconciliation and apply handlers plus the admin page.
- SQL source files 155, 157, 158, 159 and 160 for audit/source parity only.
- The admin gateway page.

No member data, wallet balances, source-import JSON, database dumps, seed data, backups, secrets, or binary storage exports were transferred.

## Runtime setup / staged deployment

1. In cPanel, confirm the supported Node version and persistent writable storage.
2. Back up the active application directory before changing anything. The previously identified live path is `/home/togeiign/marketing-network`; verify it is still the active root.
3. Create or use a separate staging Node.js application. Do not point staging at the current production document root.
4. Install dependencies in staging and run `npm run check`.
5. Run runtime smoke tests and compare the new APIs against the Namecheap `hatchable` compatibility adapter.
6. Verify read-only database connectivity, authentication/session behavior, media access, uploads, email, OneSignal, weekly BV scheduling, and critical admin/marketer flows with test accounts.
7. Review and explicitly allowlist the temporary local-import endpoints before deploying them. They are not automatically included in the existing Namecheap static/API workflows.
8. Do not run migrations or seed scripts. Do not switch production traffic until every cutover gate passes.

## Existing deployment workflows

The existing GitHub Actions workflows deploy only selected, allowlisted pages or handlers when matching paths are pushed to `namecheap-runtime-prep`. They do not deploy this complete 27-file delta. A successful workflow for one file is not proof that the remaining code has been deployed or tested.

## Cutover gate

Do not switch DNS or route users to Namecheap until the full source inventory, runtime compatibility, external DB access, auth/session behavior, existing-media access, upload/download URLs, email delivery, OneSignal push, weekly BV job, and critical admin/marketer flows have been verified. This branch is a staged source change, not a production-ready declaration.
