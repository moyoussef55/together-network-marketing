# Namecheap runtime preparation (isolated branch)

This branch is a compatibility-preparation workspace based on the Hatchable v435 source snapshot. The withdrawal-related change set from Hatchable v456 through v477 has been synced into this branch (12 files). It does not change or deploy the original Hatchable project. Do not merge it into `main` or switch production traffic until the test checklist passes.

## Critical data-safety rules

- Production must use the original Hatchable PostgreSQL database, not an imported copy. Direct network access and credentials must be confirmed before enabling direct database writes from Namecheap.
- Do not run `migrations/*.sql` or `seed.sql` against the original database. Hatchable already manages that schema and these migration files are included here for source parity/audit only.
- Do not put real credentials, tokens, or user exports in GitHub. Set them only in the Namecheap server environment.
- Keep the Hatchable site live and unchanged while preparing and testing this runtime.
- Existing Hatchable object-storage objects are not present in the Git source snapshot. The local storage adapter can store new uploads on Namecheap, but does not automatically fetch existing Hatchable objects. Existing media keys require a verified shared-storage integration or migration.

## Synced change set

- `api/admin/marketers.js`
- `api/marketer/withdrawals.js`
- `public/marketer/withdraw/index.html`
- `api/admin/withdrawals.js`
- `public/admin/withdrawals/index.html`
- `migrations/144_submit_network_withdrawal.sql` through `migrations/150_withdrawal_admin_update_policy.sql`

This sync is specifically the v456→v477 delta. The branch baseline remains v435, so changes from v436→v455 are not included by this sync.

## Runtime setup / staged deployment

1. In Namecheap cPanel, open **Setup Node.js App** and confirm the hosting plan supports Node.js 20+ and persistent writable storage.
2. Back up the current application folder before changing anything. The previously identified target path is `/home/togeiign/marketing-network`; verify it is still the active app root before deploying.
3. Use a separate staging application rooted at a staging folder; choose Node.js 20.x and startup file `server.js`. Do not point the staging app at the current production document root.
4. Pull/clone branch `namecheap-runtime-prep` into that staging folder and install dependencies with `npm install`.
5. Configure environment variables privately in cPanel. Never commit `.env` or credentials to GitHub.
6. Run `npm run check`, restart the staging Node.js application, and open `/healthz`.
7. Verify database connectivity, authentication/session behavior, media access, email, OneSignal, weekly BV scheduling, and critical admin/marketer flows using test accounts.
8. Do not run migrations or seed scripts against the original Hatchable database. Do not switch DNS or production traffic until every cutover gate has passed.

## Cron

Configure Namecheap Cron Jobs to POST `/api/jobs/network-bv-weekly` with an authorization secret stored server-side. Never expose the secret in browser code or a public URL.

## Cutover gate

Do not switch DNS or route users to Namecheap until external database access, auth/session behavior, existing-media access, upload/download URLs, email delivery, OneSignal push, the weekly BV job, and critical admin/marketer flows have been verified. This branch is a staging artifact, not a production-ready declaration.
