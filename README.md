# Together Network Marketing

Source export from Hatchable project `together-network`, live version **v521** (snapshot: 2026-10-19).

This repository contains application source, Hatchable configuration, and source migrations. It intentionally excludes secrets, database credentials, and production user-data exports.

## Runtime and Namecheap

The API files currently use Hatchable runtime APIs (for example, imports from `hatchable`). This export is **not yet a standalone Node.js/Namecheap deployment package**. Running it outside Hatchable requires a separately tested runtime compatibility layer, authentication/session handling, and verified database/storage connectivity.

Keep any external hosting copy in a separate directory. Do not run the migrations against production data as part of a code export without reviewing them first.
