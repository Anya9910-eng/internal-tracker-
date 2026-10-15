"use strict";
/** Password hashing (scrypt) + session helpers. No external crypto deps. */
const crypto = require("crypto");
const { db, uid } = require("./db");

const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString("hex");
  const a = Buffer.from(h, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 864e5);
  db.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)")
    .run(token, userId, now.toISOString(), exp.toISOString());
  return { token, expires: exp };
}

function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id) || null;
}

function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
}

/** Public shape of a user — never leak password hash/salt. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status || "",
    shift: u.shift || "day",
    emojis: safeJson(u.emojis, ["🧹"]),
    showStreak: !!u.show_streak,
    paused: !!u.paused,
    streakDays: u.streak_days || 0,
    lastClose: u.last_close || "",
    stats: safeJson(u.stats, { closed: 0, sweptDust: 0, early: false, night: false, deepClean: false })
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

module.exports = { hashPassword, verifyPassword, createSession, userFromToken, destroySession, publicUser, safeJson, SESSION_DAYS };
