"use strict";
/**
 * Hilton Crew Board — server.
 * Serves the front-end and a small REST API backed by SQLite, with
 * Server-Sent Events for live board sync across everyone signed in.
 */
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { db, uid, todayKey, addDays } = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

/* ---------------- live sync (SSE) ---------------- */
const clients = new Set();
function broadcast() {
  for (const res of clients) {
    try { res.write(`data: changed\n\n`); } catch (e) { /* dropped */ }
  }
}

/* ---------------- auth middleware ---------------- */
function currentUser(req) { return auth.userFromToken(req.cookies && req.cookies.sid); }
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  req.user = u;
  next();
}
function setSessionCookie(res, token, expires) {
  res.cookie("sid", token, {
    httpOnly: true, sameSite: "lax", secure: PROD,
    expires, path: "/"
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------- auth routes ---------------- */
app.post("/api/auth/signup", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (exists) return res.status(409).json({ error: "An account with that email already exists. Try signing in." });

  const { salt, hash } = auth.hashPassword(password);
  const id = uid();
  db.prepare(`INSERT INTO users (id,email,name,pw_hash,pw_salt,created_at)
              VALUES (?,?,?,?,?,?)`).run(id, email, name, hash, salt, new Date().toISOString());
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  const { token, expires } = auth.createSession(id);
  setSessionCookie(res, token, expires);
  broadcast(); // new crew member shows up in assignee lists
  res.json({ user: auth.publicUser(u) });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u || !auth.verifyPassword(password, u.pw_salt, u.pw_hash)) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  const { token, expires } = auth.createSession(u.id);
  setSessionCookie(res, token, expires);
  res.json({ user: auth.publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => {
  auth.destroySession(req.cookies && req.cookies.sid);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

/* update own profile */
app.patch("/api/me", requireAuth, (req, res) => {
  const b = req.body || {};
  const cur = req.user;
  const name = b.name != null ? String(b.name).trim().slice(0, 60) || cur.name : cur.name;
  const status = b.status != null ? String(b.status).slice(0, 80) : cur.status;
  let emojis = cur.emojis;
  if (Array.isArray(b.emojis)) emojis = JSON.stringify(b.emojis.slice(0, 3).map(String));
  const showStreak = b.showStreak != null ? (b.showStreak ? 1 : 0) : cur.show_streak;
  const paused = b.paused != null ? (b.paused ? 1 : 0) : cur.paused;
  db.prepare(`UPDATE users SET name=?,status=?,emojis=?,show_streak=?,paused=? WHERE id=?`)
    .run(name, status, emojis, showStreak, paused, cur.id);
  broadcast();
  res.json({ user: auth.publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(cur.id)) });
});

/* ---------------- board read ---------------- */
function goalProgress() {
  const g = db.prepare("SELECT * FROM goal WHERE id='main'").get();
  if (!g) return null;
  const linked = db.prepare("SELECT done FROM tasks WHERE counts_goal=1").all();
  const total = linked.length;
  const done = linked.filter(t => t.done).length;
  return { ...g, rewards: auth.safeJson(g.rewards, []), done, total, pct: total ? Math.round(done / total * 100) : 0 };
}

app.get("/api/board", requireAuth, (req, res) => {
  const cols = db.prepare("SELECT * FROM columns ORDER BY position, rowid").all();
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY position, rowid").all();
  const byCol = {};
  cols.forEach(c => (byCol[c.id] = []));
  tasks.forEach(t => {
    if (!byCol[t.column_id]) return;
    byCol[t.column_id].push({
      id: t.id, title: t.title, notes: t.notes, done: !!t.done, dust: t.dust,
      priority: t.priority, urgency: t.urgency, project: t.project,
      assigneeId: t.assignee_id, link: t.link, countsGoal: !!t.counts_goal
    });
  });
  const users = db.prepare("SELECT id,name,emojis,status,show_streak,streak_days FROM users ORDER BY name").all()
    .map(u => ({ id: u.id, name: u.name, emojis: auth.safeJson(u.emojis, ["🧹"]), status: u.status || "",
                 streakDays: u.show_streak ? u.streak_days : null }));
  res.json({
    me: auth.publicUser(req.user),
    columns: cols.map(c => ({ id: c.id, name: c.name, tasks: byCol[c.id] })),
    goal: goalProgress(),
    users
  });
});

/* ---------------- columns ---------------- */
app.post("/api/columns", requireAuth, (req, res) => {
  const max = db.prepare("SELECT COALESCE(MAX(position),-1) m FROM columns").get().m;
  const id = uid();
  db.prepare("INSERT INTO columns (id,name,position) VALUES (?,?,?)")
    .run(id, String(req.body.name || "New list").slice(0, 60), max + 1);
  broadcast(); res.json({ id });
});

app.patch("/api/columns/:id", requireAuth, (req, res) => {
  const r = db.prepare("UPDATE columns SET name=? WHERE id=?")
    .run(String(req.body.name || "").slice(0, 60), req.params.id);
  if (!r.changes) return res.status(404).json({ error: "List not found" });
  broadcast(); res.json({ ok: true });
});

app.post("/api/columns/:id/move", requireAuth, (req, res) => {
  const dir = req.body.dir === "l" ? -1 : 1;
  const cols = db.prepare("SELECT id,position FROM columns ORDER BY position, rowid").all();
  const i = cols.findIndex(c => c.id === req.params.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cols.length) return res.json({ ok: true });
  const tx = db.transaction(() => {
    cols.forEach((c, idx) => db.prepare("UPDATE columns SET position=? WHERE id=?").run(idx, c.id));
    db.prepare("UPDATE columns SET position=? WHERE id=?").run(j, cols[i].id);
    db.prepare("UPDATE columns SET position=? WHERE id=?").run(i, cols[j].id);
  });
  tx(); broadcast(); res.json({ ok: true });
});

app.delete("/api/columns/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM columns WHERE id=?").run(req.params.id);
  broadcast(); res.json({ ok: true });
});

/* ---------------- tasks ---------------- */
app.post("/api/columns/:id/tasks", requireAuth, (req, res) => {
  const col = db.prepare("SELECT id FROM columns WHERE id=?").get(req.params.id);
  if (!col) return res.status(404).json({ error: "List not found" });
  const max = db.prepare("SELECT COALESCE(MAX(position),-1) m FROM tasks WHERE column_id=?").get(req.params.id).m;
  const id = uid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id,column_id,title,dust,priority,position,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, req.params.id, "", 3, "med", max + 1, now, now);
  broadcast(); res.json({ id });
});

const PRIOS = new Set(["low", "med", "high"]);
app.patch("/api/tasks/:id", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Task not found" });
  const b = req.body || {};
  const f = {
    title: b.title != null ? String(b.title).slice(0, 300) : t.title,
    notes: b.notes != null ? String(b.notes).slice(0, 4000) : t.notes,
    dust: b.dust != null ? Math.max(0, Math.min(99, parseInt(b.dust, 10) || 0)) : t.dust,
    priority: b.priority != null && PRIOS.has(b.priority) ? b.priority : t.priority,
    urgency: b.urgency != null ? String(b.urgency).slice(0, 60) : t.urgency,
    project: b.project != null ? String(b.project).slice(0, 60) : t.project,
    link: b.link != null ? String(b.link).slice(0, 600) : t.link,
    counts_goal: b.countsGoal != null ? (b.countsGoal ? 1 : 0) : t.counts_goal,
    assignee_id: t.assignee_id
  };
  if (b.assigneeId !== undefined) {
    f.assignee_id = b.assigneeId ? String(b.assigneeId) : null;
    if (f.assignee_id && !db.prepare("SELECT 1 FROM users WHERE id=?").get(f.assignee_id)) f.assignee_id = null;
  }
  db.prepare(`UPDATE tasks SET title=@title,notes=@notes,dust=@dust,priority=@priority,urgency=@urgency,
              project=@project,link=@link,counts_goal=@counts_goal,assignee_id=@assignee_id,updated_at=@now
              WHERE id=@id`).run({ ...f, now: new Date().toISOString(), id: t.id });
  broadcast(); res.json({ ok: true });
});

/* toggle done — credits the acting user's streak + achievements */
app.post("/api/tasks/:id/toggle", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Task not found" });
  const nowDone = t.done ? 0 : 1;
  db.prepare("UPDATE tasks SET done=?,updated_at=? WHERE id=?").run(nowDone, new Date().toISOString(), t.id);

  let unlocked = [];
  if (nowDone) unlocked = creditClose(req.user, t);
  broadcast();
  res.json({ ok: true, done: !!nowDone, unlocked });
});

function creditClose(user, task) {
  const stats = auth.safeJson(user.stats, { closed: 0, sweptDust: 0, early: false, night: false, deepClean: false });
  const before = achievementsFor(user.streak_days, stats).filter(a => a.on).map(a => a.id);
  stats.closed++;
  stats.sweptDust += task.dust;
  if (task.dust >= 10) stats.deepClean = true;
  const h = new Date().getHours();
  if (h >= 5 && h < 8) stats.early = true;
  if (h >= 0 && h < 5) stats.night = true;

  let streak = user.streak_days || 0;
  let lastClose = user.last_close || "";
  if (!user.paused) {
    const tk = todayKey();
    if (lastClose !== tk) {
      streak = (lastClose === addDays(tk, -1)) ? streak + 1 : 1;
      lastClose = tk;
    }
  }
  db.prepare("UPDATE users SET stats=?,streak_days=?,last_close=? WHERE id=?")
    .run(JSON.stringify(stats), streak, lastClose, user.id);

  const after = achievementsFor(streak, stats);
  const beforeSet = new Set(before);
  return after.filter(a => a.on && !beforeSet.has(a.id)).map(a => ({ id: a.id, name: a.name, ic: a.ic }));
}

/** Achievement rules — mirror of the client list, kept here so unlocks are authoritative. */
function achievementsFor(streakDays, s) {
  return [
    { id: "first",   ic: "🛎️", name: "First check-in",    on: s.closed >= 1 },
    { id: "ten",     ic: "🔟", name: "On a roll",          on: s.closed >= 10 },
    { id: "fifty",   ic: "🧽", name: "Housekeeping hero",  on: s.closed >= 50 },
    { id: "hundred", ic: "💎", name: "Diamond status",     on: s.closed >= 100 },
    { id: "deep",    ic: "⛰️", name: "Deep clean",         on: !!s.deepClean },
    { id: "spot",    ic: "✨", name: "Spotless",           on: s.sweptDust >= 50 },
    { id: "early",   ic: "🌅", name: "Early check-in",     on: !!s.early },
    { id: "night",   ic: "🌙", name: "Night auditor",      on: !!s.night },
    { id: "fire",    ic: "🔥", name: "Week on fire",       on: streakDays >= 7 }
  ];
}

app.delete("/api/tasks/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  broadcast(); res.json({ ok: true });
});

/* ---------------- goal ---------------- */
app.put("/api/goal", requireAuth, (req, res) => {
  const b = req.body || {};
  const rewards = Array.isArray(b.rewards) ? b.rewards.slice(0, 3).map(r => ({
    label: String(r.label || "").slice(0, 80),
    pct: Math.max(1, Math.min(100, parseInt(r.pct, 10) || 25))
  })) : [];
  db.prepare(`INSERT INTO goal (id,title,start,deadline,team_emoji,finish_emoji,rewards)
    VALUES ('main',@title,@start,@deadline,@team,@finish,@rewards)
    ON CONFLICT(id) DO UPDATE SET title=@title,start=@start,deadline=@deadline,
      team_emoji=@team,finish_emoji=@finish,rewards=@rewards`).run({
    title: String(b.title || "Goal").slice(0, 120),
    start: String(b.start || todayKey()),
    deadline: String(b.deadline || addDays(todayKey(), 21)),
    team: String(b.teamEmoji || "🛎️").slice(0, 8),
    finish: String(b.finishEmoji || "🏆").slice(0, 8),
    rewards: JSON.stringify(rewards)
  });
  broadcast(); res.json({ ok: true });
});

app.delete("/api/goal", requireAuth, (req, res) => {
  db.prepare("DELETE FROM goal WHERE id='main'").run();
  broadcast(); res.json({ ok: true });
});

/* ---------------- SSE ---------------- */
app.get("/api/events", requireAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.flushHeaders && res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.write("data: hello\n\n");
  clients.add(res);
  const ka = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch (e) {} }, 25000);
  req.on("close", () => { clearInterval(ka); clients.delete(res); });
});

/* ---------------- static front-end ---------------- */
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Hilton Crew Board running on http://localhost:${PORT}`);
});
