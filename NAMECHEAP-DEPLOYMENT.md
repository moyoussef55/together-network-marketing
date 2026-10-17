# Namecheap runtime preparation (isolated branch)

This branch is a compatibility-preparation workspace for the Hatchable v435 source snapshot. It does not change or deploy the original Hatchable project. Do not merge it into main until the test checklist passes.

## Critical data-safety rules

- Production must use the original Hatchable PostgreSQL database, not an imported copy. Direct network access and credentials must be confirmed with Hatchable before enabling writes from Namecheap.
- Do not run migrations/*.sql or seed.sql against the original database. This source snapshot assumes its schema already exists.
- Do not put real credentials, tokens, or user exports in GitHub. Set them only in the Namecheap server environment.
- Keep the Hatchable site live and unchanged while preparing and testing this runtime.
- Existing Hatchable object-storage objects are not present in the Git source snapshot. The local storage adapter can store new uploads on Namecheap, but existing media keys will not resolve until shared storage is proven or existing media are migrated with a verified export/import process.

## Runtime scope

The source imports db, storage, config, and email from the Hatchable SDK. This branch adds a Node/Express runtime and a local compatibility package for those APIs. Database compatibility can be tested with read-only SELECT 1; storage and SMTP need separate configuration. Existing Hatchable media is a known parity gate: the adapter's local disk storage handles new uploads, but does not magically fetch existing Hatchable objects. The local adapter is not a guarantee that every Hatchable-managed behavior is automatically reproduced.

## Initial setup on Namecheap

1. In Namecheap cPanel, open **Setup Node.js App** and confirm the hosting plan supports Node.js 20+ and persistent writable storage.
2. Create a separate staging application rooted at the repository folder; choose Node.js 20.x and set the startup file to `server.js`. Do not point the app at a current production document root.
3. Upload/clone branch `namecheap-runtime-prep` into that staging folder.
4. Run `npm install` in staging. Generate and commit a lockfile after dependency resolution is verified.
5. Create `.env` from `.env.example`, fill in credentials privately through the server environment settings, and keep `.env` outside public web access.
6. Run `npm run check`, restart the Node.js application, and open `/healthz`. Test database connectivity only after Hatchable confirms the external endpoint and permissions; prefer a read-only account for initial verification.
7. Verify how to access existing Hatchable object storage. Do not cut over if stored product images, event media, registration documents, or support attachments are missing.
8. Validate all API and page flows with test accounts before allowing production writes.


## Cron

Configure Namecheap Cron Jobs to POST /api/jobs/network-bv-weekly with Authorization: Bearer <CRON_SECRET>. The runtime should translate that authenticated request into the scheduler marker expected by the existing handler. Never expose the secret in browser code or a public URL.

## Cutover gate

Do not switch DNS or route users to Namecheap until external DB access, auth/session behavior, existing-media access, upload/download URLs, email delivery, OneSignal push, the weekly BV job, and critical admin/marketer flows have been verified. This branch is a staging artifact, not a production-ready declaration.
