"use strict";
/**
 * ANEON — CRM обліку тендерів.
 * Віддає фронтенд і невеликий REST API на SQLite, з live-синхронізацією
 * через Server-Sent Events між усіма, хто увійшов.
 */
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { db, uid } = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "512kb" }));
app.use(cookieParser());

/* ---------------- live-синхронізація (SSE) ---------------- */
const clients = new Set();
function broadcast() {
  for (const res of clients) {
    try { res.write(`data: changed\n\n`); } catch (e) { /* dropped */ }
  }
}

/* ---------------- авторизація ---------------- */
function currentUser(req) { return auth.userFromToken(req.cookies && req.cookies.sid); }
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Ви не увійшли." });
  req.user = u;
  next();
}
function setSessionCookie(res, token, expires) {
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: PROD, expires, path: "/" });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Адмін робочого простору — користувач, що зареєструвався найпершим.
function adminId() {
  const r = db.prepare("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1").get();
  return r ? r.id : null;
}

/* ---------------- авторизація: маршрути ---------------- */
app.post("/api/auth/signup", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name) return res.status(400).json({ error: "Введіть ваше ім'я." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Схоже, email введено некоректно." });
  if (password.length < 8) return res.status(400).json({ error: "Пароль має містити щонайменше 8 символів." });

  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (exists) return res.status(409).json({ error: "Акаунт із таким email уже існує. Спробуйте увійти." });

  const { salt, hash } = auth.hashPassword(password);
  const id = uid();
  db.prepare(`INSERT INTO users (id,email,name,pw_hash,pw_salt,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, email, name, hash, salt, new Date().toISOString());
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  const { token, expires } = auth.createSession(id);
  setSessionCookie(res, token, expires);
  broadcast();
  res.json({ user: auth.publicUser(u) });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u || !auth.verifyPassword(password, u.pw_salt, u.pw_hash)) {
    return res.status(401).json({ error: "Невірний email або пароль." });
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

/* змінити власне ім'я */
app.patch("/api/me", requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().slice(0, 60);
  if (name) db.prepare("UPDATE users SET name=? WHERE id=?").run(name, req.user.id);
  broadcast();
  res.json({ user: auth.publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});

/* змінити власний пароль */
app.post("/api/me/password", requireAuth, (req, res) => {
  const current = String((req.body && req.body.current) || "");
  const next = String((req.body && req.body.next) || "");
  const cur = req.user;
  if (!auth.verifyPassword(current, cur.pw_salt, cur.pw_hash)) {
    return res.status(400).json({ error: "Поточний пароль невірний." });
  }
  if (next.length < 8) return res.status(400).json({ error: "Новий пароль має містити щонайменше 8 символів." });
  const { salt, hash } = auth.hashPassword(next);
  db.prepare("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?").run(salt, hash, cur.id);
  res.json({ ok: true });
});

/* адмін скидає пароль колеги на тимчасовий (без email) */
app.post("/api/users/:id/reset-password", requireAuth, (req, res) => {
  if (req.user.id !== adminId()) return res.status(403).json({ error: "Скидати паролі може лише адміністратор." });
  const target = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Користувача не знайдено." });
  const temp = "Tender-" + Math.random().toString(36).slice(2, 8);
  const { salt, hash } = auth.hashPassword(temp);
  db.prepare("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?").run(salt, hash, target.id);
  res.json({ ok: true, tempPassword: temp, name: target.name, email: target.email });
});

/* ---------------- дошка (стадії + тендери) ---------------- */
const TENDER_FIELDS = [
  "buyer", "product", "packaging", "delivery_terms", "specification",
  "req_sample", "req_order", "req_docs", "notes"
];
function tenderShape(t) {
  return {
    id: t.id, stageId: t.stage_id,
    buyer: t.buyer || "", product: t.product || "", packaging: t.packaging || "",
    deliveryTerms: t.delivery_terms || "", specification: t.specification || "",
    reqSample: t.req_sample || "", reqOrder: t.req_order || "", reqDocs: t.req_docs || "",
    contractExists: !!t.contract_exists, contractSigned: !!t.contract_signed,
    notes: t.notes || "", createdAt: t.created_at, updatedAt: t.updated_at
  };
}

app.get("/api/board", requireAuth, (req, res) => {
  const stages = db.prepare("SELECT * FROM stages ORDER BY position, rowid").all();
  const rows = db.prepare("SELECT * FROM tenders ORDER BY position, rowid").all();
  const byStage = {}; stages.forEach(s => (byStage[s.id] = []));
  rows.forEach(t => { if (byStage[t.stage_id]) byStage[t.stage_id].push(tenderShape(t)); });
  const users = db.prepare("SELECT id,name,email FROM users ORDER BY created_at, rowid").all();
  res.json({
    me: auth.publicUser(req.user),
    stages: stages.map(s => ({ id: s.id, name: s.name, tenders: byStage[s.id] })),
    users,
    adminId: adminId()
  });
});

/* ---------------- стадії ---------------- */
app.post("/api/stages", requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().slice(0, 60) || "Нова стадія";
  const max = db.prepare("SELECT COALESCE(MAX(position),-1) m FROM stages").get().m;
  const id = uid();
  db.prepare("INSERT INTO stages (id,name,position) VALUES (?,?,?)").run(id, name, max + 1);
  broadcast();
  res.json({ id });
});

app.patch("/api/stages/:id", requireAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM stages WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Стадію не знайдено." });
  const name = String((req.body && req.body.name) || "").trim().slice(0, 60);
  if (name) db.prepare("UPDATE stages SET name=? WHERE id=?").run(name, s.id);
  broadcast();
  res.json({ ok: true });
});

app.post("/api/stages/:id/move", requireAuth, (req, res) => {
  const dir = req.body && req.body.dir;
  const all = db.prepare("SELECT * FROM stages ORDER BY position, rowid").all();
  const idx = all.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Стадію не знайдено." });
  const swap = dir === "left" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= all.length) return res.json({ ok: true });
  const tx = db.transaction(() => {
    db.prepare("UPDATE stages SET position=? WHERE id=?").run(all[swap].position, all[idx].id);
    db.prepare("UPDATE stages SET position=? WHERE id=?").run(all[idx].position, all[swap].id);
  });
  tx(); broadcast();
  res.json({ ok: true });
});

app.delete("/api/stages/:id", requireAuth, (req, res) => {
  const count = db.prepare("SELECT COUNT(*) c FROM stages").get().c;
  if (count <= 1) return res.status(400).json({ error: "Має залишитись хоча б одна стадія." });
  db.prepare("DELETE FROM stages WHERE id=?").run(req.params.id); // тендери видаляються каскадно
  broadcast();
  res.json({ ok: true });
});

/* ---------------- тендери ---------------- */
app.post("/api/stages/:id/tenders", requireAuth, (req, res) => {
  const stage = db.prepare("SELECT id FROM stages WHERE id=?").get(req.params.id);
  if (!stage) return res.status(404).json({ error: "Стадію не знайдено." });
  const max = db.prepare("SELECT COALESCE(MAX(position),-1) m FROM tenders WHERE stage_id=?").get(stage.id).m;
  const id = uid(); const now = new Date().toISOString();
  const b = req.body || {};
  db.prepare(`INSERT INTO tenders (id,stage_id,buyer,product,position,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, stage.id, String(b.buyer || "").slice(0, 300), String(b.product || "").slice(0, 300), max + 1, now, now);
  broadcast();
  res.json({ id });
});

app.patch("/api/tenders/:id", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tenders WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Тендер не знайдено." });
  const b = req.body || {};
  const sets = [], vals = [];
  const map = {
    buyer: "buyer", product: "product", packaging: "packaging", deliveryTerms: "delivery_terms",
    specification: "specification", reqSample: "req_sample", reqOrder: "req_order", reqDocs: "req_docs", notes: "notes"
  };
  for (const [key, col] of Object.entries(map)) {
    if (b[key] != null) { sets.push(`${col}=?`); vals.push(String(b[key]).slice(0, 4000)); }
  }
  if (b.contractExists != null) { sets.push("contract_exists=?"); vals.push(b.contractExists ? 1 : 0); }
  if (b.contractSigned != null) { sets.push("contract_signed=?"); vals.push(b.contractSigned ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at=?"); vals.push(new Date().toISOString());
  vals.push(t.id);
  db.prepare(`UPDATE tenders SET ${sets.join(",")} WHERE id=?`).run(...vals);
  broadcast();
  res.json({ ok: true });
});

app.delete("/api/tenders/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM tenders WHERE id=?").run(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// Перемістити тендер в іншу стадію / на іншу позицію.
app.post("/api/tenders/:id/move", requireAuth, (req, res) => {
  const t = db.prepare("SELECT * FROM tenders WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Тендер не знайдено." });
  const toStage = db.prepare("SELECT id FROM stages WHERE id=?").get(req.body && req.body.stageId);
  if (!toStage) return res.status(400).json({ error: "Невідома стадія." });
  const beforeId = (req.body && req.body.beforeId) || null;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const siblings = db.prepare("SELECT id FROM tenders WHERE stage_id=? AND id<>? ORDER BY position, rowid")
      .all(toStage.id, t.id).map(r => r.id);
    let insertAt = beforeId ? siblings.indexOf(beforeId) : siblings.length;
    if (insertAt < 0) insertAt = siblings.length;
    siblings.splice(insertAt, 0, t.id);
    db.prepare("UPDATE tenders SET stage_id=?, updated_at=? WHERE id=?").run(toStage.id, now, t.id);
    siblings.forEach((id, i) => db.prepare("UPDATE tenders SET position=? WHERE id=?").run(i, id));
  });
  tx(); broadcast();
  res.json({ ok: true });
});

/* ---------------- live-потік ---------------- */
app.get("/api/events", requireAuth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders && res.flushHeaders();
  res.write(`retry: 4000\n\n`);
  res._uid = req.user.id;
  clients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (e) { /* */ } }, 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

/* ---------------- статика ---------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`ANEON (CRM тендерів) running on http://localhost:${PORT}`);
});
