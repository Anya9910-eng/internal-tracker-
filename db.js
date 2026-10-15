"use strict";
/**
 * SQLite storage for the Hilton Crew Board.
 * One shared workspace: all signed-up users see the same board.
 */
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const uid = () => crypto.randomBytes(9).toString("base64url");
const todayKey = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// Key for "which week is it" — the date of this week's Monday. Used to reset weekly columns.
const mondayKey = (d = new Date()) => { const x = new Date(d); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); return x.toISOString().slice(0, 10); };
const pad2 = n => String(n).padStart(2, "0");
const fmtLocal = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();       // m is 0-based
// The anchor day-of-month to use this period (anchor 0 or >lastDay means "last day").
const monthlyDue = (y, m, anchor) => (!anchor || anchor > daysInMonth(y, m)) ? daysInMonth(y, m) : anchor;
// Period key for a recurrence cadence + optional anchor. A recurring task resets when this key changes.
//  - week:    anchor = weekday (0=Mon … 6=Sun); key is the date of the most recent such weekday.
//  - month:   anchor = day of month (1–31, 0 = last day); key is the most recent such date.
//  - quarter: anchor = day of month in the quarter's first month (0 = last day).
const recurKey = (recur, anchor, d = new Date()) => {
  anchor = (anchor == null || anchor === "") ? null : parseInt(anchor, 10);
  if (recur === "day") return fmtLocal(d);
  if (recur === "week") {
    const wd = (d.getDay() + 6) % 7;                 // 0=Mon … 6=Sun
    const target = (anchor == null ? 0 : ((anchor % 7) + 7) % 7);
    const back = (wd - target + 7) % 7;
    const x = new Date(d); x.setDate(x.getDate() - back);
    return fmtLocal(x);
  }
  if (recur === "month") {
    const due = monthlyDue(d.getFullYear(), d.getMonth(), anchor);
    if (d.getDate() >= due) return fmtLocal(new Date(d.getFullYear(), d.getMonth(), due));
    const pm = new Date(d.getFullYear(), d.getMonth(), 1); pm.setDate(0); // last day of previous month
    return fmtLocal(new Date(pm.getFullYear(), pm.getMonth(), monthlyDue(pm.getFullYear(), pm.getMonth(), anchor)));
  }
  if (recur === "quarter") {
    const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
    const due = monthlyDue(d.getFullYear(), qStartMonth, anchor);
    const thisQ = new Date(d.getFullYear(), qStartMonth, due);
    if (d >= thisQ) return fmtLocal(thisQ);
    const pm = new Date(d.getFullYear(), qStartMonth - 3, 1);   // previous quarter's first month
    return fmtLocal(new Date(pm.getFullYear(), pm.getMonth(), monthlyDue(pm.getFullYear(), pm.getMonth(), anchor)));
  }
  return "";
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    pw_hash       TEXT NOT NULL,
    pw_salt       TEXT NOT NULL,
    status        TEXT DEFAULT '',
    emojis        TEXT DEFAULT '["🧹"]',
    show_streak   INTEGER DEFAULT 1,
    paused        INTEGER DEFAULT 0,
    streak_days   INTEGER DEFAULT 0,
    last_close    TEXT DEFAULT '',
    stats         TEXT DEFAULT '{"closed":0,"sweptDust":0,"early":false,"night":false,"deepClean":false}',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS columns (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    column_id   TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title       TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    done        INTEGER DEFAULT 0,
    dust        INTEGER DEFAULT 3,
    priority    TEXT DEFAULT 'med',
    urgency     TEXT DEFAULT '',
    project     TEXT DEFAULT '',
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    link        TEXT DEFAULT '',
    counts_goal INTEGER DEFAULT 0,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS goal (
    id            TEXT PRIMARY KEY,
    title         TEXT DEFAULT '',
    start         TEXT DEFAULT '',
    deadline      TEXT DEFAULT '',
    team_emoji    TEXT DEFAULT '🛎️',
    finish_emoji  TEXT DEFAULT '🏆',
    rewards       TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS goals (
    id            TEXT PRIMARY KEY,
    title         TEXT DEFAULT '',
    start         TEXT DEFAULT '',
    deadline      TEXT DEFAULT '',
    team_emoji    TEXT DEFAULT '🛎️',
    finish_emoji  TEXT DEFAULT '🏆',
    rewards       TEXT DEFAULT '[]',
    position      INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS task_reactions (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_reaction ON task_reactions(task_id,user_id,emoji);

  CREATE TABLE IF NOT EXISTS nudges (
    id         TEXT PRIMARY KEY,
    from_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    to_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    emoji      TEXT DEFAULT '',
    text       TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

/* ---------- lightweight migrations (safe to run every boot) ---------- */
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes("due_date")) {
  db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT ''");
}
if (!taskCols.includes("goal_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN goal_id TEXT");
}
// Per-task recurrence: '' | 'day' | 'week' | 'month' | 'quarter'
if (!taskCols.includes("recur")) {
  db.exec("ALTER TABLE tasks ADD COLUMN recur TEXT DEFAULT ''");
}
if (!taskCols.includes("recur_reset")) {
  db.exec("ALTER TABLE tasks ADD COLUMN recur_reset TEXT DEFAULT ''");
}
if (!taskCols.includes("recur_anchor")) {
  db.exec("ALTER TABLE tasks ADD COLUMN recur_anchor INTEGER");  // weekday or day-of-month; null = default
}
const colCols = db.prepare("PRAGMA table_info(columns)").all().map(c => c.name);
if (!colCols.includes("weekly")) db.exec("ALTER TABLE columns ADD COLUMN weekly INTEGER DEFAULT 0");
if (!colCols.includes("last_reset")) db.exec("ALTER TABLE columns ADD COLUMN last_reset TEXT DEFAULT ''");
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("shift")) db.exec("ALTER TABLE users ADD COLUMN shift TEXT DEFAULT 'day'");

// One-time: convert the old per-column "weekly" model to per-task weekly recurrence.
const weeklyCols = db.prepare("SELECT id FROM columns WHERE weekly=1").all();
if (weeklyCols.length) {
  const tx = db.transaction(() => {
    for (const c of weeklyCols) {
      db.prepare("UPDATE tasks SET recur='week', recur_reset=?, done=0 WHERE column_id=? AND IFNULL(recur,'')=''")
        .run(mondayKey(), c.id);
    }
    db.prepare("UPDATE columns SET weekly=0 WHERE weekly=1").run();
  });
  tx();
}

// Migrate the old single-goal table into the multi-goal table (once).
const goalsCount = db.prepare("SELECT COUNT(*) c FROM goals").get().c;
if (goalsCount === 0) {
  const old = db.prepare("SELECT * FROM goal WHERE id='main'").get();
  if (old) {
    db.prepare(`INSERT INTO goals (id,title,start,deadline,team_emoji,finish_emoji,rewards,position,created_at)
                VALUES (?,?,?,?,?,?,?,0,?)`).run(
      old.id || "main", old.title, old.start, old.deadline, old.team_emoji, old.finish_emoji,
      old.rewards, new Date().toISOString());
    db.prepare("UPDATE tasks SET goal_id=? WHERE counts_goal=1 AND (goal_id IS NULL OR goal_id='')")
      .run(old.id || "main");
  }
}

/* ---------- first-run seed: default lists + example tasks ---------- */
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM columns").get().c;
  if (n > 0) return;
  const insCol = db.prepare("INSERT INTO columns (id,name,position) VALUES (?,?,?)");
  const gid = uid();
  const insTask = db.prepare(`INSERT INTO tasks
    (id,column_id,title,notes,done,dust,priority,due_date,project,assignee_id,link,counts_goal,goal_id,recur,recur_reset,recur_anchor,position,created_at,updated_at)
    VALUES (@id,@column_id,@title,'',@done,@dust,@priority,@due_date,@project,NULL,'',@counts_goal,@goal_id,@recur,@recur_reset,@recur_anchor,@position,@now,@now)`);
  const now = new Date().toISOString();
  const T = todayKey();

  const cols = [
    ["To do", [
      { title: "Prep VIP arrival — Suite 1203", dust: 5, priority: "high", due_date: T, project: "Guest experience", counts_goal: 1 },
      { title: "Restock minibars — floors 8–12", dust: 8, priority: "med", due_date: T, project: "Housekeeping", counts_goal: 1 },
      { title: "Confirm airport shuttle schedule", dust: 2, priority: "low", due_date: addDays(T, 4), project: "Front desk", counts_goal: 0 }
    ]],
    ["In progress", [
      { title: "Resolve AC complaint — room 907", dust: 6, priority: "high", due_date: addDays(T, -1), project: "Engineering", counts_goal: 1 },
      { title: "Update breakfast buffet signage", dust: 3, priority: "med", due_date: addDays(T, 3), project: "F&B", counts_goal: 1 }
    ]],
    ["Done", [
      { title: "Night audit reconciliation", dust: 4, priority: "med", due_date: "", project: "Front desk", counts_goal: 1, done: 1 },
      { title: "Lost & found weekly log", dust: 2, priority: "low", due_date: "", project: "Front desk", counts_goal: 1, done: 1 }
    ]]
  ];

  // Recurring example tasks (live in the Recurring view, grouped by cadence).
  const recurring = [
    { recur: "day",     title: "Lobby & entrance walk-through", dust: 2, priority: "med" },
    { recur: "day",     title: "Count the front-desk float", dust: 2, priority: "med" },
    { recur: "day",     title: "Verify guest-ready rooms with housekeeping", dust: 3, priority: "high" },
    { recur: "week",    anchor: 0, title: "Fire alarm & extinguisher check", dust: 4, priority: "high" },   // Monday
    { recur: "week",    anchor: 2, title: "Deep-clean lobby glass & doors", dust: 5, priority: "med" },      // Wednesday
    { recur: "week",    anchor: 4, title: "Linen inventory count", dust: 6, priority: "med" },               // Friday
    { recur: "month",   anchor: 1,  title: "Test the emergency generator", dust: 5, priority: "high" },       // 1st
    { recur: "month",   anchor: 0,  title: "Deep-clean guest-room carpets", dust: 7, priority: "med" },       // last day
    { recur: "quarter", anchor: 1,  title: "Full fire-safety audit", dust: 8, priority: "high" },
    { recur: "quarter", anchor: 15, title: "Review vendor contracts & rates", dust: 6, priority: "med" }
  ];

  const seed = db.transaction(() => {
    const colIds = [];
    cols.forEach(([name, tasks], ci) => {
      const cid = uid(); colIds.push(cid);
      insCol.run(cid, name, ci);
      tasks.forEach((t, ti) => insTask.run({
        id: uid(), column_id: cid, title: t.title, done: t.done ? 1 : 0, dust: t.dust,
        priority: t.priority, due_date: t.due_date, project: t.project,
        counts_goal: t.counts_goal, goal_id: t.counts_goal ? gid : null,
        recur: "", recur_reset: "", recur_anchor: null, position: ti, now
      }));
    });
    // recurring tasks live on the first list and are also surfaced in the Recurring view
    recurring.forEach((t, ti) => insTask.run({
      id: uid(), column_id: colIds[0], title: t.title, done: 0, dust: t.dust,
      priority: t.priority, due_date: "", project: "",
      counts_goal: 0, goal_id: null, recur: t.recur, recur_reset: recurKey(t.recur, t.anchor),
      recur_anchor: (t.anchor == null ? null : t.anchor), position: 1000 + ti, now
    }));
    db.prepare(`INSERT INTO goals (id,title,start,deadline,team_emoji,finish_emoji,rewards,position,created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(
      gid, "Q4 Guest Satisfaction Push", todayKey(), addDays(todayKey(), 28), "🛎️", "🏆",
      JSON.stringify([
        { label: "Team lunch 🍱", pct: 25 },
        { label: "$50 gift card each 🎁", pct: 50 },
        { label: "Early off a Friday 🏖️", pct: 75 }
      ]),
      now
    );
  });
  seed();
}
seedIfEmpty();

module.exports = { db, uid, todayKey, addDays, mondayKey, recurKey, DB_PATH };
