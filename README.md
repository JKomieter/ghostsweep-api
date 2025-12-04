# GhostSweep Scanner API

Background worker + API for running GhostSweep inbox scans in the background and syncing results to the database.

This service is responsible for:

- Fetching Gmail metadata using stored OAuth tokens  
- Respecting Gmail rate limits while scanning large inboxes  
- Detecting online accounts / services from email metadata  
- Enriching services (logos, domains, categories)  
- Recording breaches, services, and scan events in the database  
- Exposing a small API for triggering and monitoring scans  

The main web app calls this service to enqueue or trigger scans; the scanner does the heavy lifting in the background.

---

## Architecture

**Core flow:**

1. Web app issues a scan request (e.g. after user connects Gmail)  
2. Scanner looks up the user’s Gmail tokens and metadata in the DB  
3. Scanner walks through Gmail messages in batches (read-only)  
4. For each relevant email, it extracts:
   - sender domain  
   - service name / normalized domain  
   - timestamps and message counts  
5. Scanner upserts services + email counts into the DB  
6. Scanner cross-checks domains with breach sources and stores breach records  
7. Scanner writes a `scan_events` row to mark progress / status

---

## Tech Stack

- **Language:** Node.js + TypeScript  
- **Runtime:** Node 22 (deployed on Fly.io)  
- **Framework:** Minimal HTTP server (e.g. Express / Fastify / custom)  
- **Database:** Supabase / Postgres  
- **Auth:** Gmail OAuth 2.0 (using stored access + refresh tokens)  
- **Queue / Jobs:** In-process job runner or cron-style worker  
- **Deployment:** Fly.io (background app, `ghostsweep-api`)

> Note: Adjust the framework name in this README to match what you’re actually using.

---

## Folder Structure (example)

```text
.
├─ src/
│  ├─ server.ts           # Server entry
│  ├─ app.ts             # HTTP routes + middlewares
│  ├─ utils/
│  │  ├─ cache.ts      
│  │  ├─ encryption.ts 
│  │  ├─ extraction.ts 
│  │  ├─ get-breaches.ts     # Breach lookup logic
│  │  ├─ get-users.ts
│  │  ├─ get-email-metadata.ts
│  │  ├─ helpers.ts
│  │  ├─ notify.ts
│  │  ├─ summarize-by-domain.ts
│  ├─ supabase
│  ├─ worker.ts # Main scan job
├─ package.json
├─ tsconfig.json
├─ .env.example
└─ README.md



## Environmental Veriables

```

PORT=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

TOKEN_ENCRYPTION_KEY=
HIBP_API_KEY=

RESEND_API_KEY=

LOGO_DEV_PUBLISHABLE_KEY=

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

```
