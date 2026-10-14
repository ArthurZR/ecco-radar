# eccö RADAR

A private web app for discovering, curating and captioning cultural and visual references for eccö.
One editor (or a small team) signs in, explores public sources, decides what fits, researches it, and
prepares captions. **RADAR never publishes anything.** Approval and "manually published" are records of
what the editor did by hand outside the app.

- `server/`: TypeScript API (Fastify, PostgreSQL) plus a background worker for explorations.
- `web/`: React + TypeScript + Vite single-page app.
- `docs/ARCHITECTURE.md`: how the pieces fit, data model, ranking, security.
- `docs/SOURCES.md`: each source adapter, what it needs, and its verification status.

## Local setup

Requirements: Node 20+ (22 recommended) and PostgreSQL 14+.

```bash
npm install
cp .env.example server/.env          # then edit: DATABASE_URL, SESSION_SECRET, SOURCE_CONTACT
createdb radar_dev                   # or: createuser -P radar && createdb -O radar radar_dev
npm run migrate                      # applies server/src/db/migrations/*.sql
npm run create-user -w server -- you@example.com "Your name"   # prompts for a password (12+ chars)
npm run dev                          # API on :8787, web on http://localhost:5173
```

The worker runs inside the API process by default (`RUN_WORKER=true`). To run it separately set
`RUN_WORKER=false` for the API and start `npm run worker -w server`.

### Checks

GitHub Actions (`.github/workflows/ci.yml`) runs the same checks on every pull request and on `main`.

```bash
npm run typecheck
npm run lint
npm test            # server tests use TEST_DATABASE_URL (default postgres://radar:radar@localhost:5432/radar_test)
npm run build
npm run e2e         # browser tests; needs the build above and a Chromium (`npx playwright install chromium`)
```

`npm run e2e` starts the API with the built web app on port 8790 against the test database, seeds five
SYNTHETIC references and blocks all outbound HTTP. The browser tests sign in, triage the feed with the
keyboard, write a note, take a caption through to "manually published", import and roll back a
synthetic X file, and change the AI limit. Every test also fails if the browser contacts any origin
other than RADAR itself.

Server tests empty their database on every run, so they only accept a database whose name contains
"test" and ignore `DATABASE_URL`. They use a real PostgreSQL database and fake HTTP responses shaped like each API; they never
call external services. Test fixtures are synthetic and labelled as such.

## Credentials

All keys live in the server environment only. Nothing secret is sent to the browser or committed.

| Variable | Needed for | Where to get it |
|---|---|---|
| `SESSION_SECRET` | Sessions (required) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SOURCE_CONTACT` | Wikimedia, Internet Archive and AIC ask for a contact in the User-Agent | An email address you read |
| `FLICKR_API_KEY` | Flickr adapter | https://www.flickr.com/services/api/misc.api_keys.html |
| `TUMBLR_API_KEY` | Tumblr adapter | OAuth consumer key from https://www.tumblr.com/oauth/apps |
| `ANTHROPIC_API_KEY` | AI caption drafts, rewrites, experimental query suggestions | https://console.anthropic.com |

AI use is capped by a daily token limit (200,000 tokens per rolling 24 hours by default), set in
**Settings → AI provider**. It counts the tokens the provider reports for every call, from Caption
Studio and from exploration alike; once reached, AI requests are refused with that reason until usage
falls below the limit. This is the measurable part of AI cost; RADAR does not convert it to money.

Without an AI key, Caption Studio still assembles restrained captions from source facts and you can
write your own. Even with a key, external AI stays off until you enable it in Settings.

## Importing analytics

Use **Insights → Imports**. Upload the CSV, confirm what kind of file it is, check the column mapping,
choose the account (Instagram exports can contain other accounts; those rows are skipped and counted),
preview, then commit. Raw rows are kept for audit, the same file cannot be committed twice, and any
import can be rolled back.

- Instagram post export: one row per post, stored with its own metrics.
- X account overview: one row per day of **account-level totals**. These are stored separately and are
  never attributed to individual posts.

Do not commit analytics files. `*.csv` and `data/` are git-ignored. Paths to your files are never part
of the application; you upload them through the UI.

## Deploying

The simplest path is one small VM (or any Docker host) with HTTPS in front:

```bash
cp .env.example .env     # set SESSION_SECRET, APP_ORIGIN=https://radar.your-domain, POSTGRES_PASSWORD, keys
docker compose up -d --build
docker compose exec app node dist/db/migrate-cli.js
docker compose exec app node dist/auth/create-user-cli.js you@example.com "Your name"
```

The app listens on `127.0.0.1:8787`; put Caddy or nginx in front for TLS
(`reverse_proxy 127.0.0.1:8787` in Caddy is enough). In production the session cookie is `Secure`, so
the site must be served over HTTPS, and `APP_ORIGIN` must match the public URL exactly because
state-changing requests from any other origin are refused. The Dockerfile and compose file have not
been run in the environment this was built in; treat them as a starting point and check the first build.

The app needs outbound HTTPS to the source APIs you enable (see `docs/SOURCES.md`) and to
`api.anthropic.com` if AI is used.

## Backups and recovery

Everything lives in PostgreSQL. Back it up daily and before upgrades:

```bash
pg_dump --format=custom --file=radar-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" radar-YYYY-MM-DD.dump
```

With Docker: `docker compose exec db pg_dump -U radar -Fc radar > radar-$(date +%F).dump`.
Keep copies off the server. Reference IDs come from a database sequence, so restoring a backup keeps
every `#00001`-style ID and never reissues one.

## Known limitations

- **Live sources are unverified.** The adapters were built against each API's documented response
  format and tested with recorded-shape fixtures, but the build environment had no outbound network.
  Each source shows *unverified* until **Sources → Test connection** succeeds from your server.
- **Visual analysis is colour and tone only.** Each preview image is downloaded once and reduced to a
  local colour/tone vector (`colour-tone-v1`) and a perceptual hash (`dhash-64`). These drive
  "visually similar", visual duplicate detection and visual affinity, but they do not recognise
  subjects or style. Turn it off in Settings if you prefer. Text similarity uses a local lexical
  model (`lexical-hash-v1`), not a neural embedding; the `EmbeddingProvider` interface is where a real
  model would plug in.
- **No pgvector.** Embeddings are stored as arrays and compared in the application. That is fine for
  tens of thousands of references; see `docs/ARCHITECTURE.md` for the scaling path.
- **Instagram is not a source.** Its API does not allow searching other accounts, and scraping is not
  permitted. Instagram data only enters through your own exported analytics.
- **Images are hot-linked** from their sources with no referrer; RADAR does not store copies.
- The UI is light-mode only for now.
