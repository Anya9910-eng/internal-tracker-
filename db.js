"use strict";
/**
 * SQLite-сховище для CRM обліку тендерів.
 * Один спільний робочий простір: усі, хто зареєструвався, бачать ту саму дошку.
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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stages (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenders (
    id               TEXT PRIMARY KEY,
    stage_id         TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    buyer            TEXT DEFAULT '',   -- Найменування покупця
    product          TEXT DEFAULT '',   -- Найменування товару
    packaging        TEXT DEFAULT '',   -- Пакування
    delivery_terms   TEXT DEFAULT '',   -- Строки поставки
    specification    TEXT DEFAULT '',   -- Специфікація
    req_sample       TEXT DEFAULT '',   -- Реквізити для відправки зразка
    req_order        TEXT DEFAULT '',   -- Реквізити для відправки замовлення
    req_docs         TEXT DEFAULT '',   -- Реквізити для відправки документів
    contract_exists  INTEGER DEFAULT 0, -- Договір є / немає
    contract_signed  INTEGER DEFAULT 0, -- підписаний / не підписаний
    notes            TEXT DEFAULT '',
    position         INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
`);

/* ---------- перший запуск: стадії за замовчуванням + приклади ---------- */
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM stages").get().c;
  if (n > 0) return;
  const insStage = db.prepare("INSERT INTO stages (id,name,position) VALUES (?,?,?)");
  const insTender = db.prepare(`INSERT INTO tenders
    (id,stage_id,buyer,product,packaging,delivery_terms,specification,req_sample,req_order,req_docs,contract_exists,contract_signed,notes,position,created_at,updated_at)
    VALUES (@id,@stage_id,@buyer,@product,@packaging,@delivery_terms,@specification,@req_sample,@req_order,@req_docs,@contract_exists,@contract_signed,@notes,@position,@now,@now)`);
  const now = new Date().toISOString();

  const stages = [
    ["Новий запит", [
      { buyer: "КП «Міська лікарня №4»", product: "Рукавички нітрилові, розмір M", packaging: "100 шт/упаковка, 10 уп/коробка",
        delivery_terms: "до 15 днів після підписання", specification: "ДСТУ, нітрил, без пудри",
        req_sample: "", req_order: "", req_docs: "", contract_exists: 0, contract_signed: 0 }
    ]],
    ["Зразок надіслано", [
      { buyer: "ТОВ «АгроПостач»", product: "Мішки поліпропіленові 50 кг", packaging: "по 500 шт у кіпі",
        delivery_terms: "20 днів", specification: "біла тканина, 70 г/м²",
        req_sample: "Нова Пошта, відділення №3, Київ, отримувач — Іваненко І.І., +380XXXXXXXXX",
        req_order: "", req_docs: "", contract_exists: 0, contract_signed: 0 }
    ]],
    ["Договір", [
      { buyer: "Departament освіти м. Львів", product: "Папір офісний А4, 80 г/м²", packaging: "500 арк/пачка, 5 пачок/коробка",
        delivery_terms: "по графіку, партіями до 30.12", specification: "клас C, білизна 146%",
        req_sample: "надіслано", req_order: "самовивіз зі складу, Львів, вул. Промислова 12",
        req_docs: "Оригінали — на юр. адресу, копії — email buh@dep.lviv.ua",
        contract_exists: 1, contract_signed: 0, notes: "Чекаємо підпис з боку замовника" }
    ]],
    ["Поставка", []],
    ["Завершено", []]
  ];

  const seed = db.transaction(() => {
    stages.forEach(([name, items], si) => {
      const sid = uid();
      insStage.run(sid, name, si);
      items.forEach((t, ti) => insTender.run({
        id: uid(), stage_id: sid,
        buyer: t.buyer || "", product: t.product || "", packaging: t.packaging || "",
        delivery_terms: t.delivery_terms || "", specification: t.specification || "",
        req_sample: t.req_sample || "", req_order: t.req_order || "", req_docs: t.req_docs || "",
        contract_exists: t.contract_exists ? 1 : 0, contract_signed: t.contract_signed ? 1 : 0,
        notes: t.notes || "", position: ti, now
      }));
    });
  });
  seed();
}
seedIfEmpty();

module.exports = { db, uid, todayKey, addDays, DB_PATH };
