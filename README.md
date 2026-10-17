# Together Network Marketing — Namecheap preparation branch

This branch starts from the Hatchable v435 source snapshot and adds a Node.js/Express runtime adapter for staging on Namecheap.

## Important

- The original Hatchable project is unchanged and remains the reference production version.
- The target production database must remain the same original Hatchable PostgreSQL database. Confirm external access and permissions before enabling any real writes.
- No database migrations or seed scripts are run by the new runtime.
- Existing Hatchable object-storage files are not automatically copied to Namecheap. Product photos, registration attachments, event media, and chat attachments need a verified shared storage integration or a separate media migration before claiming full parity.
- The compatibility adapter is a first preparation step; it does not yet prove production readiness.

## Local / staging runtime

- Node.js 20 or later, below 25.
- Install dependencies with `npm install`.
- Copy `.env.example` to `.env` and configure values privately.
- Run `npm run check` for syntax validation.
- Run `npm start` to start the server.
- Open `/healthz` to check runtime status and, when `DATABASE_URL` is configured, a read-only `SELECT 1` connection check.

See [NAMECHEAP-DEPLOYMENT.md](NAMECHEAP-DEPLOYMENT.md) for the staged migration and cutover checklist.
