# Hilton Crew Board

A gamified internal team tracker for Hilton crews — a kanban board wrapped in light
gamification (streaks, achievements, a shared goal, floating "dust bunnies") to keep a
shift crew motivated.

This is a **multi-user, self-hosted** app: real email + password sign-up, a shared board
everyone works off, and live updates across everyone's screens. It's a plain Node server
plus SQLite — no external services, no API keys.

> There's also a standalone, offline, single-file version in [`demo/index.html`](demo/index.html)
> (no login, saves to your own browser) if you just want to poke at the UI.

## Features

- **Real accounts** — email + password sign-up and login, hashed passwords (scrypt),
  secure session cookies.
- **One shared board** — columns, tasks, the goal, and everyone's profile live in the
  database and are shared by the whole crew.
- **Assignees are real people** — the assignee dropdown is the list of people who've
  actually signed up. That's how the board knows who's on the team.
- **Live sync** — changes broadcast over Server-Sent Events, so everyone's board updates
  in real time.
- **World clocks** (McLean HQ, London, Dubai, Riyadh, Egypt) and a per-device focus timer.
- **Weekly recurring lists** — mark any column as "weekly" (🔁) and its tasks
  auto-uncheck every Monday, so standing checklists reset for the new week.
- **Day / Night shifts** — each crew member sets their shift; the crew roster
  groups by shift and names show a ☀️ / 🌙 badge.
- **Road to the goal** — a shared goal with a deadline, a progress timeline, and reward
  chests that unlock at % milestones.
- **Dust** — each task has a "dust" grind rating; open dust drifts along the bottom as
  dust bunnies and gets swept away when a task is finished.
- **Streaks & achievements** — per-user shift streak (with a leave/sick pause) and
  hospitality-themed badges: First check-in, On a roll, Housekeeping hero, Diamond status,
  Deep clean, Spotless, Early check-in, Night auditor, Week on fire.

## Run it

Requires **Node.js 18+**.

```bash
npm install
npm start
# → http://localhost:3000
```

Open the URL, click **Create an account**, and you're in. Everyone who signs up shares
the same board.

### Configuration (optional)

Copy `.env.example` to `.env` (or set these in your process manager / shell):

| Variable     | Default      | Purpose |
|--------------|--------------|---------|
| `PORT`       | `3000`       | Port the server listens on. |
| `DB_PATH`    | `./data.db`  | Where the SQLite database file is stored. |
| `NODE_ENV`   | —            | Set to `production` when behind HTTPS so session cookies are marked `Secure`. |

The SQLite file (`data.db`) is created automatically on first run and seeded with a few
example tasks and a starter goal. Back it up to keep your data.

## Deploying on a VPS (quick version)

1. Install Node 18+ on the server.
2. Copy the project up (or `git clone`), then `npm install`.
3. Run it under a process manager so it restarts on reboot/crash, e.g. **pm2**:
   ```bash
   npm install -g pm2
   NODE_ENV=production PORT=3000 pm2 start server.js --name crew-board
   pm2 save && pm2 startup
   ```
4. Put a reverse proxy in front for HTTPS (Caddy or Nginx). Example Caddyfile:
   ```
   board.yourhotel.com {
       reverse_proxy localhost:3000
   }
   ```
   Caddy gets you an automatic TLS certificate. Then set `NODE_ENV=production` so cookies
   are `Secure`.

A tiny VPS is plenty — this comfortably runs on 1 vCPU / 1 GB RAM. SQLite handles a
single-hotel crew with room to spare.

## Notes & limits

- **One shared workspace.** Everyone who signs up joins the same board. (Separate
  teams / invite codes would be a follow-up.)
- **No email sending**, so there's no password-reset email yet — keep that in mind for a
  production rollout. Password resets, roles/permissions, and drag-and-drop card ordering
  are natural next steps.
- **Trademark.** This uses the Hilton name and an "H" mark for an internal pilot/demo.
  Get sign-off before using the branding on anything public-facing.

## Project layout

```
server.js        Express app: REST API + SSE + static serving
db.js            SQLite schema, helpers, first-run seed
auth.js          password hashing + session helpers
public/index.html  the front-end (login screen + board)
demo/index.html    standalone offline single-file version
```

## License

MIT
