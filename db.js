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
`);

/* ---------- lightweight migrations (safe to run every boot) ---------- */
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes("due_date")) {
  db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT ''");
}
if (!taskCols.includes("goal_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN goal_id TEXT");
}
const colCols = db.prepare("PRAGMA table_info(columns)").all().map(c => c.name);
if (!colCols.includes("weekly")) db.exec("ALTER TABLE columns ADD COLUMN weekly INTEGER DEFAULT 0");
if (!colCols.includes("last_reset")) db.exec("ALTER TABLE columns ADD COLUMN last_reset TEXT DEFAULT ''");
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("shift")) db.exec("ALTER TABLE users ADD COLUMN shift TEXT DEFAULT 'day'");

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
    (id,column_id,title,notes,done,dust,priority,due_date,project,assignee_id,link,counts_goal,goal_id,position,created_at,updated_at)
    VALUES (@id,@column_id,@title,'',@done,@dust,@priority,@due_date,@project,NULL,'',@counts_goal,@goal_id,@position,@now,@now)`);
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

  // A standing weekly checklist that auto-unchecks every Monday.
  const weeklyTasks = [
    { title: "Fire alarm & extinguisher check", dust: 4, priority: "high" },
    { title: "Deep-clean lobby glass & doors", dust: 5, priority: "med" },
    { title: "Weekly linen inventory count", dust: 6, priority: "med" },
    { title: "Pool & spa chemical log", dust: 3, priority: "med" },
    { title: "Back-of-house walkthrough", dust: 4, priority: "med" },
    { title: "Team huddle + next week's roster", dust: 2, priority: "low" }
  ];

  const seed = db.transaction(() => {
    // weekly column first so the crew sees the standing checklist up top
    const wid = uid();
    db.prepare("INSERT INTO columns (id,name,position,weekly,last_reset) VALUES (?,?,?,1,?)")
      .run(wid, "Weekly recurring", 0, mondayKey());
    weeklyTasks.forEach((t, ti) => insTask.run({
      id: uid(), column_id: wid, title: t.title, done: 0, dust: t.dust,
      priority: t.priority, due_date: "", project: "Recurring",
      counts_goal: 0, goal_id: null, position: ti, now
    }));

    cols.forEach(([name, tasks], ci) => {
      const cid = uid();
      insCol.run(cid, name, ci + 1);
      tasks.forEach((t, ti) => insTask.run({
        id: uid(), column_id: cid, title: t.title, done: t.done ? 1 : 0, dust: t.dust,
        priority: t.priority, due_date: t.due_date, project: t.project,
        counts_goal: t.counts_goal, goal_id: t.counts_goal ? gid : null, position: ti, now
      }));
    });
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

module.exports = { db, uid, todayKey, addDays, mondayKey, DB_PATH };
