# Study Quest sync server

Two ways to run the guild leaderboard backend. Both speak the exact same
tiny API — the app just needs the base URL. The canonical API paths are
`/api/guilds/*`; the legacy `/api/rooms/*` paths are accepted as aliases.

Every guild also gets a public, read-only leaderboard page at
`/guild/<code>` — share it with anyone; joining still requires the app.

## Option A — Cloudflare Worker (recommended)

Free tier, no maintenance, always online. Limits used by a typical friend
group: well under 1% of the free allowance.

1. Create a free account at <https://dash.cloudflare.com/sign-up> (email is enough).
2. From this `worker/` folder in a terminal:

   ```bash
   npx wrangler login            # opens a browser to authorize
   npx wrangler d1 create study-quest
   ```

3. Copy the `database_id` from the output into `wrangler.toml`
   (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).
4. Create the table and deploy:

   ```bash
   npx wrangler d1 execute study-quest --remote --file schema.sql
   npx wrangler deploy
   ```

5. Wrangler prints your URL, e.g. `https://study-quest-sync.<your-subdomain>.workers.dev`.
   Paste that into the Study Quest Friends tab (or set it as `DEFAULT_SYNC_URL`
   in `sync.js` before packaging builds for friends).

## Option B — local mock / self-hosted

No account, no deploy — runs on any machine with Node:

```bash
node worker/mock-server.js
# → http://127.0.0.1:8787
```

Rooms live in memory (they vanish when the process stops). Fine for testing
and LAN use; deploy the Worker for a real friend group.

## API (both implementations)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/guilds` | `{userId, name}` | `{code, secret, members[]}` |
| POST | `/api/guilds/:code/members` | `{userId, secret?, name, stats}` | `{secret?, members[]}` — issues a secret on first join |
| GET | `/api/guilds/:code` | — | `{members[], serverTime}` |
| POST | `/api/guilds/:code/leave` | `{userId, secret}` | `{ok}` |
| GET | `/guild/:code` | — | public HTML leaderboard page |

(`stats = { todaySeconds, weekSeconds, streak, level, totalSeconds }`.
The legacy `/api/rooms/*` aliases of the first four paths still work.
Members not seen for 30 days are dropped. Max 50 members per guild.
The secret is issued once at join and stored server-side only as a SHA-256
hash; every sync must present it.)

`stats = { todaySeconds, weekSeconds, streak, level, totalSeconds }`.
Members not seen for 30 days are dropped. Max 50 members per room.
The secret is issued once at join and stored server-side only as a SHA-256
hash; every sync must present it.
