"use strict";
/**
 * ANEON — CRM супроводу виграних тендерів.
 * REST API на SQLite + live-синхронізація через SSE.
 */
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const { db, uid, todayKey, DB_PATH, UPLOAD_DIR } = require("./db");
const auth = require("./auth");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "32mb" }));
app.use(cookieParser());

/* ---------------- live-синхронізація ---------------- */
const clients = new Set();
function broadcast() { for (const res of clients) { try { res.write(`data: changed\n\n`); } catch (e) {} } }

/* ---------------- авторизація ---------------- */
function currentUser(req) { return auth.userFromToken(req.cookies && req.cookies.sid); }
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Ви не увійшли." });
  req.user = u; next();
}
function setSessionCookie(res, token, expires) {
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: PROD, expires, path: "/" });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function adminId() { const r = db.prepare("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1").get(); return r ? r.id : null; }

/* ---------------- авторизація: маршрути ---------------- */
app.post("/api/auth/signup", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name) return res.status(400).json({ error: "Введіть ваше ім'я." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Схоже, email введено некоректно." });
  if (password.length < 8) return res.status(400).json({ error: "Пароль має містити щонайменше 8 символів." });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "Акаунт із таким email уже існує. Спробуйте увійти." });
  const { salt, hash } = auth.hashPassword(password);
  const id = uid();
  db.prepare(`INSERT INTO users (id,email,name,pw_hash,pw_salt,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, email, name, hash, salt, new Date().toISOString());
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  const { token, expires } = auth.createSession(id);
  setSessionCookie(res, token, expires); broadcast();
  res.json({ user: auth.publicUser(u) });
});
app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u || !auth.verifyPassword(password, u.pw_salt, u.pw_hash)) return res.status(401).json({ error: "Невірний email або пароль." });
  const { token, expires } = auth.createSession(u.id);
  setSessionCookie(res, token, expires);
  res.json({ user: auth.publicUser(u) });
});
app.post("/api/auth/logout", (req, res) => { auth.destroySession(req.cookies && req.cookies.sid); res.clearCookie("sid", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", requireAuth, (req, res) => res.json({ user: auth.publicUser(req.user) }));

app.patch("/api/me", requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().slice(0, 60);
  if (name) db.prepare("UPDATE users SET name=? WHERE id=?").run(name, req.user.id);
  broadcast();
  res.json({ user: auth.publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});
app.post("/api/me/password", requireAuth, (req, res) => {
  const current = String((req.body && req.body.current) || ""), next = String((req.body && req.body.next) || ""), cur = req.user;
  if (!auth.verifyPassword(current, cur.pw_salt, cur.pw_hash)) return res.status(400).json({ error: "Поточний пароль невірний." });
  if (next.length < 8) return res.status(400).json({ error: "Новий пароль має містити щонайменше 8 символів." });
  const { salt, hash } = auth.hashPassword(next);
  db.prepare("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?").run(salt, hash, cur.id);
  res.json({ ok: true });
});
app.post("/api/users/:id/reset-password", requireAuth, (req, res) => {
  if (req.user.id !== adminId()) return res.status(403).json({ error: "Скидати паролі може лише адміністратор." });
  const target = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Користувача не знайдено." });
  const temp = "Tender-" + Math.random().toString(36).slice(2, 8);
  const { salt, hash } = auth.hashPassword(temp);
  db.prepare("UPDATE users SET pw_salt=?, pw_hash=? WHERE id=?").run(salt, hash, target.id);
  res.json({ ok: true, tempPassword: temp, name: target.name, email: target.email });
});

/* ---------------- схеми дочірніх таблиць ---------------- */
const T = {                       // поле → тип: s=string, r=real, b=bool, u=user-id(string)
  contracts: { table: "contracts", cols: { tender_no:"s", contract_no:"s", buyer:"s", edrpou:"s", contact_person:"s", phone:"s", email:"s",
      manager_id:"u", win_date:"s", sign_date:"s", total_sum:"r", valid_until:"s", total_volume:"s", delivery_terms:"s",
      payment_terms:"s", delivery_addr:"s", tender_url:"s", status:"s", notes:"s" } },
  samples: { table: "samples", cols: { description:"s", qty:"s", specs:"s", due_date:"s", sent_date:"s", ttn:"s",
      sender_id:"u", controller_id:"u", received:"b", quality_ok:"b", remarks:"s", resend:"b" } },
  production: { table: "production", cols: { product:"s", specification:"s", dims:"s", color_print:"s", planned_qty:"s",
      contract_qty:"s", produced_qty:"s", qc_qty:"s", defect_qty:"s", start_date:"s", planned_ready:"s", actual_ready:"s", responsible_id:"u" } },
  shipments: { table: "shipments", cols: { num:"s", planned_date:"s", actual_date:"s", nomenclature:"s", qty:"r", unit:"s",
      carrier:"s", ttn:"s", address:"s", received:"b", docs_signed:"b", delay_reason:"s", responsible_id:"u" } },
  documents: { table: "documents", cols: { kind:"s", form_date:"s", send_date:"s", recv_date:"s", status:"s", responsible_id:"u" } },
  payments: { table: "payments", cols: { kind:"s", invoice_date:"s", planned_date:"s", actual_date:"s", amount:"r", responsible_id:"u" } }
};
function coerce(type, v) {
  if (type === "r") { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  if (type === "b") return v ? 1 : 0;
  if (type === "u") return v ? String(v) : null;
  return String(v == null ? "" : v).slice(0, 4000);
}
function buildSet(spec, body) {
  const sets = [], vals = [];
  for (const [col, type] of Object.entries(spec.cols)) {
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (body[camel] != null || body[col] != null) {
      sets.push(`${col}=?`); vals.push(coerce(type, body[camel] != null ? body[camel] : body[col]));
    }
  }
  return { sets, vals };
}
function rowToCamel(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return o;
}

/* дочірні записи: створити / оновити / видалити */
const CHILD_PARENT = { samples: "samples", production: "production", shipments: "shipments", documents: "documents", payments: "payments" };
app.post("/api/contracts/:cid/:child", requireAuth, (req, res, next) => {
  if (req.params.child === "files") return next(); // обробляється окремим маршрутом нижче
  const spec = T[req.params.child]; if (!spec || req.params.child === "contracts") return res.status(404).json({ error: "Невідомий розділ." });
  const c = db.prepare("SELECT id FROM contracts WHERE id=?").get(req.params.cid);
  if (!c) return res.status(404).json({ error: "Договір не знайдено." });
  const id = uid();
  db.prepare(`INSERT INTO ${spec.table} (id,contract_id,created_at) VALUES (?,?,?)`).run(id, c.id, new Date().toISOString());
  const { sets, vals } = buildSet(spec, req.body || {});
  if (sets.length) db.prepare(`UPDATE ${spec.table} SET ${sets.join(",")} WHERE id=?`).run(...vals, id);
  broadcast(); res.json({ id });
});
app.patch("/api/:child/:id", requireAuth, (req, res) => {
  const spec = T[req.params.child]; if (!spec) return res.status(404).json({ error: "Невідомий розділ." });
  const row = db.prepare(`SELECT id FROM ${spec.table} WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Запис не знайдено." });
  const { sets, vals } = buildSet(spec, req.body || {});
  if (req.params.child === "contracts") sets.push("updated_at=?"), vals.push(new Date().toISOString());
  if (sets.length) db.prepare(`UPDATE ${spec.table} SET ${sets.join(",")} WHERE id=?`).run(...vals, req.params.id);
  broadcast(); res.json({ ok: true });
});
app.delete("/api/:child/:id", requireAuth, (req, res) => {
  const spec = T[req.params.child]; if (!spec) return res.status(404).json({ error: "Невідомий розділ." });
  db.prepare(`DELETE FROM ${spec.table} WHERE id=?`).run(req.params.id);
  broadcast(); res.json({ ok: true });
});

/* створити договір */
app.post("/api/contracts", requireAuth, (req, res) => {
  const id = uid(), now = new Date().toISOString();
  db.prepare(`INSERT INTO contracts (id,buyer,manager_id,win_date,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)`)
    .run(id, String((req.body && req.body.buyer) || "").slice(0, 300), req.user.id, todayKey(), now, now);
  broadcast(); res.json({ id });
});
app.delete("/api/contracts/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM contracts WHERE id=?").run(req.params.id);
  broadcast(); res.json({ ok: true });
});

/* ---------------- файли ---------------- */
app.post("/api/contracts/:cid/files", requireAuth, (req, res) => {
  const c = db.prepare("SELECT id FROM contracts WHERE id=?").get(req.params.cid);
  if (!c) return res.status(404).json({ error: "Договір не знайдено." });
  const b = req.body || {};
  const name = String(b.name || "file").slice(0, 200);
  const data = String(b.dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
  if (!data) return res.status(400).json({ error: "Порожній файл." });
  const buf = Buffer.from(data, "base64");
  if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: "Файл завеликий (макс. 25 МБ)." });
  const ext = (name.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0];
  const fileName = uid() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
  const id = uid();
  db.prepare(`INSERT INTO attachments (id,contract_id,scope,name,mime,size,file,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, c.id, String(b.scope || "contract"), name, String(b.mime || "").slice(0, 120), buf.length, fileName, req.user.id, new Date().toISOString());
  broadcast(); res.json({ id });
});
app.get("/api/files/:id", requireAuth, (req, res) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(req.params.id);
  if (!a) return res.status(404).send("Файл не знайдено");
  const p = path.join(UPLOAD_DIR, a.file);
  if (!fs.existsSync(p)) return res.status(404).send("Файл відсутній");
  if (a.mime) res.type(a.mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  fs.createReadStream(p).pipe(res);
});
app.delete("/api/files/:id", requireAuth, (req, res) => {
  const a = db.prepare("SELECT * FROM attachments WHERE id=?").get(req.params.id);
  if (a) { try { fs.unlinkSync(path.join(UPLOAD_DIR, a.file)); } catch (e) {} db.prepare("DELETE FROM attachments WHERE id=?").run(a.id); }
  broadcast(); res.json({ ok: true });
});

/* ---------------- читання ---------------- */
function users() { return db.prepare("SELECT id,name,email FROM users ORDER BY created_at, rowid").all(); }
function userName(id) { if (!id) return ""; const u = db.prepare("SELECT name FROM users WHERE id=?").get(id); return u ? u.name : ""; }
function sum(rows, f) { return rows.reduce((a, r) => a + (parseFloat(f(r)) || 0), 0); }

function contractChildren(cid) {
  return {
    samples: db.prepare("SELECT * FROM samples WHERE contract_id=? ORDER BY created_at").all(cid).map(rowToCamel),
    production: db.prepare("SELECT * FROM production WHERE contract_id=? ORDER BY created_at").all(cid).map(rowToCamel),
    shipments: db.prepare("SELECT * FROM shipments WHERE contract_id=? ORDER BY rowid").all(cid).map(rowToCamel),
    documents: db.prepare("SELECT * FROM documents WHERE contract_id=? ORDER BY rowid").all(cid).map(rowToCamel),
    payments: db.prepare("SELECT * FROM payments WHERE contract_id=? ORDER BY rowid").all(cid).map(rowToCamel),
    attachments: db.prepare("SELECT id,scope,name,mime,size,created_at FROM attachments WHERE contract_id=? ORDER BY created_at").all(cid).map(rowToCamel)
  };
}
function contractComputed(c, ch) {
  const paid = sum(ch.payments.filter(p => p.actualDate), p => p.amount);
  const shipped = sum(ch.shipments.filter(s => s.actualDate), s => s.qty);
  return {
    paid, debt: Math.max(0, (c.total_sum || 0) - paid),
    shippedQty: shipped
  };
}

app.get("/api/contracts", requireAuth, (req, res) => {
  const list = db.prepare("SELECT * FROM contracts ORDER BY created_at DESC").all().map(c => {
    const ch = contractChildren(c.id);
    const comp = contractComputed(c, ch);
    return {
      ...rowToCamel(c), managerName: userName(c.manager_id),
      paid: comp.paid, debt: comp.debt,
      openTasks: deriveTasks(c, ch).length
    };
  });
  res.json({ me: auth.publicUser(req.user), users: users(), adminId: adminId(), contracts: list });
});

app.get("/api/contracts/:id", requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ error: "Договір не знайдено." });
  const ch = contractChildren(c.id);
  res.json({
    contract: { ...rowToCamel(c), managerName: userName(c.manager_id) },
    ...ch, computed: contractComputed(c, ch),
    users: users(), me: auth.publicUser(req.user)
  });
});

/* ---------------- задачі / дашборд ---------------- */
function deriveTasks(c, ch) {
  const tasks = [];
  const base = { contractId: c.id, buyer: c.buyer || "Без назви", contractNo: c.contract_no || "" };
  ch.samples.forEach(s => {
    if (!s.sentDate) tasks.push({ ...base, kind: "sample", title: "Відправити зразок" + (s.description ? ": " + s.description : ""),
      due: s.dueDate || "", responsibleId: s.senderId || s.controllerId });
  });
  ch.production.forEach(p => {
    if (!p.actualReady && p.plannedReady) tasks.push({ ...base, kind: "production", title: "Виробництво" + (p.product ? ": " + p.product : ""),
      due: p.plannedReady, responsibleId: p.responsibleId });
  });
  ch.shipments.forEach(s => {
    if (!s.actualDate) tasks.push({ ...base, kind: "shipment", title: "Відвантажити №" + (s.num || "") + (s.nomenclature ? " · " + s.nomenclature : ""),
      due: s.plannedDate || "", responsibleId: s.responsibleId });
  });
  ch.documents.forEach(d => {
    if (!["signed", "registered", "received"].includes(d.status)) tasks.push({ ...base, kind: "document", title: "Документ: " + (d.kind || "—"),
      due: d.recvDate || d.sendDate || d.formDate || "", responsibleId: d.responsibleId });
  });
  ch.payments.forEach(p => {
    if (!p.actualDate) tasks.push({ ...base, kind: "payment", title: "Контроль оплати" + (p.amount ? " · " + Math.round(p.amount).toLocaleString("uk-UA") + " грн" : ""),
      due: p.plannedDate || "", responsibleId: p.responsibleId });
  });
  return tasks;
}

app.get("/api/dashboard", requireAuth, (req, res) => {
  const today = todayKey();
  const in7 = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
  const all = [];
  for (const c of db.prepare("SELECT * FROM contracts WHERE status<>'closed'").all()) {
    const ch = contractChildren(c.id);
    for (const t of deriveTasks(c, ch)) {
      t.responsibleName = userName(t.responsibleId);
      t.overdue = !!(t.due && t.due < today);
      t.soon = !!(t.due && t.due >= today && t.due <= in7);
      all.push(t);
    }
  }
  const counters = {
    overdue: all.filter(t => t.overdue).length,
    week: all.filter(t => t.soon).length,
    awaitingShipment: all.filter(t => t.kind === "shipment").length,
    awaitingPayment: all.filter(t => t.kind === "payment").length
  };
  // сортування: спершу прострочені, потім за датою
  all.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ad = a.due || "9999", bd = b.due || "9999";
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  res.json({ me: auth.publicUser(req.user), counters, tasks: all });
});

/* ---------------- SSE ---------------- */
app.get("/api/events", requireAuth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders && res.flushHeaders();
  res.write(`retry: 4000\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (e) {} }, 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

/* ---------------- статика ---------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`ANEON (CRM тендерів) running on http://localhost:${PORT}`));
