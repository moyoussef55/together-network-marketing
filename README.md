# Together Network Marketing — Namecheap preparation branch

This isolated branch starts from the Hatchable v435 source snapshot and now includes the exact 12-file change set detected between Hatchable deployments v456 and v477. It remains a staging/preparation branch, not a declaration that the entire repository is byte-for-byte equivalent to Hatchable v477.

## Synced from Hatchable v456–v477

- Admin and marketer withdrawal pages and API handlers.
- Withdrawal migrations 144–150, including the v477 admin UPDATE row-level-security policy.
- File-level verification confirmed these 12 files exactly match their current Hatchable source contents.

## Important

- The original Hatchable project remains live and is the reference production version.
- This branch is based on v435 plus the v456–v477 delta; changes from v436–v455 have not been imported by this specific sync.
- The target production database must remain the same original Hatchable PostgreSQL database. Confirm external access and permissions before enabling any real writes.
- Do not run database migrations or seed scripts from this runtime against the original database; the existing schema is already managed by Hatchable.
- Existing Hatchable object-storage files are not automatically copied to Namecheap. Product photos, registration attachments, event media, and chat attachments need a verified shared-storage integration or a separate media migration before claiming full parity.
- The compatibility adapter and the synced files have not yet been deployed or end-to-end tested on Namecheap.

## Local / staging runtime

- Node.js 20 or later, below 25.
- Install dependencies with `npm install`.
- Copy `.env.example` to `.env` and configure values privately.
- Run `npm run check` for syntax validation.
- Run `npm start` to start the server.
- Open `/healthz` to check runtime status and, when `DATABASE_URL` is configured, a read-only `SELECT 1` connection check.

See [NAMECHEAP-DEPLOYMENT.md](NAMECHEAP-DEPLOYMENT.md) for the staged migration and cutover checklist.
