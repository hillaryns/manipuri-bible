# Manipuri Bible

A bilingual Manipuri (Roman-script) + English Bible reader, with verse-by-verse audio recordings.

## Monorepo

- `apps/web` — React + Vite web app
- `apps/api` — server-side API.Bible proxy for NKJV chapter requests
- `apps/mobile` — Expo / React Native app
- `packages/shared` — shared Bible types and starter content
- Supabase — Postgres, Authentication and Storage

## Requirements

- Node.js 20+
- pnpm 9+
- A Supabase project
- For mobile development: Expo Go or an Android emulator

## Setup

```bash
pnpm install
```

Create a Supabase project and copy its project URL and publishable key into
`apps/web/.env` using the `VITE_` variable names in `.env.example`. For mobile, put
the corresponding `EXPO_PUBLIC_` variables in `apps/mobile/.env`. Only use a
publishable key in frontend and mobile apps; never put a secret or service-role key
in either app.

The web and mobile apps initialize their Supabase clients from these environment
variables. Enable row-level security and define policies for any tables and storage
buckets before using them. Authentication can be added when bookmarks and sync are
implemented.

### NKJV API proxy

The NKJV text is fetched on demand from API.Bible by the Node server in `apps/api`;
it is not stored in Supabase or included in frontend bundles. Set `API_BIBLE_KEY`
in the server environment (or in the ignored project-root `.env.local` for local
development). Do not use a `VITE_` or `EXPO_PUBLIC_` prefix for this credential.
The server loads the root `.env.local` when it exists; deployment environments
should provide `API_BIBLE_KEY` as a server-side secret.

Run the API server and web app in separate terminals:

```bash
pnpm dev:api
pnpm dev:web
```

In development, Vite forwards `/api` requests to the local API server. Fetch a
chapter with `GET /api/nkjv/chapters/JHN.3`; the response includes the API.Bible
chapter object with verse-number and verse-span markup. `/health` reports whether
the server has a key configured, without returning the key. Run
`pnpm test:api-access` to verify the server credential and access to the configured
NKJV Bible ID without printing the credential.

Chapter responses are cached in server memory for five minutes only; the cache is
bounded and is not written to disk or Supabase. This proxy does not bulk-download
text. Confirm the API.Bible license associated with the API key permits your
application's intended NKJV display and caching before deployment.

### Run the web app

```bash
pnpm dev:web
```

### Run the mobile app

```bash
pnpm dev:mobile
```

## Supabase data model (planned)

Use a `books` table for book metadata:
```json
{
  "id": "matthew",
  "name": "Matthew",
  "testament": "new",
  "order": 40,
  "chapterCount": 28
}
```

Use a `verses` table keyed by `book_id`, `chapter` and `verse`:
```json
{
  "book_id": "matthew",
  "chapter": 1,
  "verse": 1,
  "manipuriRoman": "Text supplied from the licensed translation",
  "english": "English translation text",
  "audioPath": "manipuri/matthew/1/1.mp3",
  "audioStatus": "pending"
}
```

Store audio in a Supabase Storage bucket and keep its object path in `audioPath`,
not a hard-coded download URL, so URLs can be resolved securely and refreshed.

## Content and attribution

The initial content import is intentionally not included yet. Before importing a translation,
verify the exact source edition, licence notice, attribution requirements and any required
copyright/translator notices. Keep the source's attribution and mark any edits. The New
Testament source identified for evaluation is ANOUBA WAREPNABA; the Old Testament needs
a separately verified source. Do not assume that one licence covers other translations.

## Audio workflow

Each recording should be linked to a stable `bookId / chapter / verse` reference.
Keep the original recording unchanged; store an optimized playback copy separately if needed.
Track language, speaker consent, recording status and file path in metadata.

## Next milestones

1. Confirm the exact Manipuri Roman-script edition and its attribution text.
2. Obtain an English translation with compatible reuse rights.
3. Import books, chapters and verses into Supabase.
4. Add upload tooling for your verse recordings.
5. Add offline downloads, bookmarks, reading progress and accessibility controls.
