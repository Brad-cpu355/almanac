# Almanac

A personal planner: a chronological agenda of your events, plus a year
calendar for adding them. Static frontend in `public/`, a small JSON API
in `src/worker.js`, events stored in Cloudflare D1. Same shape as your
other tools: GitHub repo → Cloudflare Worker, deployed on every push to
`main`.

## 1. Local setup

```bash
npm install
npx wrangler login
```

## 2. Create the D1 database

```bash
npm run db:create
```

This prints a `database_id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Then apply the schema, both locally (for `wrangler dev`) and to the real
remote database:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## 3. Try it locally

```bash
npm run dev
```

Opens on `http://localhost:8787` — the whole app runs against your local
D1 copy.

## 4. First deploy

```bash
npm run deploy
```

This publishes `almanac.<your-subdomain>.workers.dev`. Confirm it loads
and that adding an event survives a refresh (i.e. D1 is actually wired
up) before moving on.

## 5. Push to GitHub for auto-deploy

Create the repo, push this project, then add two repository secrets
(**Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN` — a token scoped to *Workers Scripts: Edit* and
  *Account: Cloudflare Workers: Edit* for your account (Cloudflare
  dashboard → My Profile → API Tokens → Create Token).
- `CLOUDFLARE_ACCOUNT_ID` — found on the right side of any Workers page
  in the Cloudflare dashboard.

From then on, every push to `main` runs `.github/workflows/deploy.yml`
and redeploys automatically — no manual `wrangler deploy` needed.

## 6. Put it behind Zero Trust Access

Same pattern as your Idea Vault and Commonplace Book — this locks the
app to just you instead of anyone with the URL:

1. Cloudflare dashboard → **Zero Trust** → **Access → Applications** →
   **Add an application** → **Self-hosted**.
2. Set the application domain to your Worker's route (the
   `workers.dev` URL, or a custom domain if you attach one under
   **Workers & Pages → almanac → Settings → Domains & Routes**).
3. Add a policy that allows only your email (one-time PIN, or your
   existing Google/GitHub login method — whatever the other two apps
   use).
4. Save. The next visit to the URL will prompt for that login before
   ever reaching the Worker.

No code changes needed for this — it's enforced at Cloudflare's edge,
in front of the Worker.

## How it's organized

```
almanac/
├── public/index.html      the entire frontend — agenda + year views, no build step
├── src/worker.js           /api/events (GET, POST, PUT, DELETE) backed by D1
├── schema.sql              the events table
├── wrangler.toml           Worker + D1 + static-assets config
└── .github/workflows/      deploy.yml — auto-deploy on push to main
```

Each event is one D1 row: `title`, `date` (`YYYY-MM-DD`), optional
`time` (`HH:MM`), `category` (personal / work / family / birthday /
other), `recurring` (repeats every year on that month/day), and
optional `notes`.

The frontend polls `/api/events` every 25 seconds and on tab focus, so
an event added on your phone shows up here shortly after — no
websockets or Durable Objects needed for something this low-traffic.
If the Worker is unreachable it falls back to the last copy it saw
(cached in `localStorage`) and flags itself as offline in the header
rather than pretending to be in sync.
