"use strict";
/**
 * SQLite-сховище для CRM супроводу виграних тендерів.
 * Один спільний простір: усі зареєстровані бачать ті самі договори.
 */
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
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

  /* 1. Картка виграного тендера / договору */
  CREATE TABLE IF NOT EXISTS contracts (
    id              TEXT PRIMARY KEY,
    tender_no       TEXT DEFAULT '',
    contract_no     TEXT DEFAULT '',
    buyer           TEXT DEFAULT '',
    edrpou          TEXT DEFAULT '',
    contact_person  TEXT DEFAULT '',
    phone           TEXT DEFAULT '',
    email           TEXT DEFAULT '',
    manager_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    win_date        TEXT DEFAULT '',
    sign_date       TEXT DEFAULT '',
    total_sum       REAL DEFAULT 0,
    valid_until     TEXT DEFAULT '',
    total_volume    TEXT DEFAULT '',
    plan_qty        REAL DEFAULT 0,
    unit            TEXT DEFAULT '',
    delivery_terms  TEXT DEFAULT '',
    payment_terms   TEXT DEFAULT '',
    delivery_addr   TEXT DEFAULT '',
    tender_url      TEXT DEFAULT '',
    status          TEXT DEFAULT 'active',   -- active | closed
    stage           TEXT DEFAULT 'new',      -- стадія воронки супроводу
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  /* 2. Зразки продукції */
  CREATE TABLE IF NOT EXISTS samples (
    id            TEXT PRIMARY KEY,
    contract_id   TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    description   TEXT DEFAULT '',
    qty           TEXT DEFAULT '',
    specs         TEXT DEFAULT '',
    due_date      TEXT DEFAULT '',
    sent_date     TEXT DEFAULT '',
    ttn           TEXT DEFAULT '',
    sender_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    controller_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    received      INTEGER DEFAULT 0,
    quality_ok    INTEGER DEFAULT 0,
    remarks       TEXT DEFAULT '',
    resend        INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  /* 3. Виробництво */
  CREATE TABLE IF NOT EXISTS production (
    id            TEXT PRIMARY KEY,
    contract_id   TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    product       TEXT DEFAULT '',
    specification TEXT DEFAULT '',
    dims          TEXT DEFAULT '',   -- товщина / ширина / довжина
    color_print   TEXT DEFAULT '',
    planned_qty   TEXT DEFAULT '',
    contract_qty  TEXT DEFAULT '',
    produced_qty  TEXT DEFAULT '',
    qc_qty        TEXT DEFAULT '',
    defect_qty    TEXT DEFAULT '',
    start_date    TEXT DEFAULT '',
    planned_ready TEXT DEFAULT '',
    actual_ready  TEXT DEFAULT '',
    responsible_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL
  );

  /* 4. Відвантаження (журнал) */
  CREATE TABLE IF NOT EXISTS shipments (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    num            TEXT DEFAULT '',
    planned_date   TEXT DEFAULT '',
    actual_date    TEXT DEFAULT '',
    nomenclature   TEXT DEFAULT '',
    qty            REAL DEFAULT 0,
    unit           TEXT DEFAULT 'кг',
    carrier        TEXT DEFAULT '',
    ttn            TEXT DEFAULT '',
    address        TEXT DEFAULT '',
    received       INTEGER DEFAULT 0,
    docs_signed    INTEGER DEFAULT 0,
    delay_reason   TEXT DEFAULT '',
    responsible_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL
  );

  /* 5. Документи (чек-лист) */
  CREATE TABLE IF NOT EXISTS documents (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    kind           TEXT DEFAULT '',   -- тип документа
    form_date      TEXT DEFAULT '',
    send_date      TEXT DEFAULT '',
    recv_date      TEXT DEFAULT '',
    status         TEXT DEFAULT 'todo', -- todo | ready | sent | received | registered | signed
    responsible_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL
  );

  /* 6. Оплати (кілька записів, якщо частинами) */
  CREATE TABLE IF NOT EXISTS payments (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    kind           TEXT DEFAULT 'payment', -- prepay | payment
    invoice_date   TEXT DEFAULT '',
    planned_date   TEXT DEFAULT '',
    actual_date    TEXT DEFAULT '',
    amount         REAL DEFAULT 0,
    responsible_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL
  );

  /* Файли (скани, ТТН, фото) */
  CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    scope       TEXT DEFAULT 'contract',
    ref_id      TEXT DEFAULT '',     -- id конкретного запису (відвантаження/документа…) або ''
    name        TEXT DEFAULT '',
    mime        TEXT DEFAULT '',
    size        INTEGER DEFAULT 0,
    file        TEXT NOT NULL,       -- ім'я файлу в UPLOAD_DIR
    uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );

  /* Довільні задачі (окремо від стандартних блоків) */
  CREATE TABLE IF NOT EXISTS custom_tasks (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    title          TEXT DEFAULT '',
    due_date       TEXT DEFAULT '',
    responsible_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    done           INTEGER DEFAULT 0,
    created_at     TEXT NOT NULL
  );

  /* Коментарі співробітників */
  CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    text        TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  );

  /* Історія зміни термінів */
  CREATE TABLE IF NOT EXISTS date_history (
    id          TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    scope       TEXT DEFAULT '',
    field       TEXT DEFAULT '',
    old_val     TEXT DEFAULT '',
    new_val     TEXT DEFAULT '',
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
`);

/* ---------- легкі міграції (безпечно щозапуску) ---------- */
const cCols = db.prepare("PRAGMA table_info(contracts)").all().map(c => c.name);
if (!cCols.includes("plan_qty")) db.exec("ALTER TABLE contracts ADD COLUMN plan_qty REAL DEFAULT 0");
if (!cCols.includes("unit")) db.exec("ALTER TABLE contracts ADD COLUMN unit TEXT DEFAULT ''");
if (!cCols.includes("stage")) db.exec("ALTER TABLE contracts ADD COLUMN stage TEXT DEFAULT 'new'");
const aCols = db.prepare("PRAGMA table_info(attachments)").all().map(c => c.name);
if (!aCols.includes("ref_id")) db.exec("ALTER TABLE attachments ADD COLUMN ref_id TEXT DEFAULT ''");

/* ---------- перший запуск: приклад договору ---------- */
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM contracts").get().c;
  if (n > 0) return;
  const now = new Date().toISOString();
  const T = todayKey();
  const cid = uid();
  db.prepare(`INSERT INTO contracts
    (id,tender_no,contract_no,buyer,edrpou,contact_person,phone,email,win_date,sign_date,total_sum,valid_until,total_volume,plan_qty,unit,delivery_terms,payment_terms,delivery_addr,tender_url,status,notes,created_at,updated_at)
    VALUES (@id,@tender_no,@contract_no,@buyer,@edrpou,@contact_person,@phone,@email,@win_date,@sign_date,@total_sum,@valid_until,@total_volume,@plan_qty,@unit,@delivery_terms,@payment_terms,@delivery_addr,@tender_url,'active','',@now,@now)`)
    .run({
      id: cid, tender_no: "UA-2026-001234", contract_no: "Д-57", buyer: "КП «Міська лікарня №4»",
      edrpou: "01234567", contact_person: "Петренко О.І.", phone: "+380 67 123 45 67", email: "zakupivli@lik4.ua",
      win_date: addDays(T, -10), sign_date: addDays(T, -5), total_sum: 480000, valid_until: addDays(T, 60),
      total_volume: "20 000 пар", plan_qty: 20000, unit: "пар", delivery_terms: "партіями, до 30 днів", payment_terms: "відстрочка 14 днів",
      delivery_addr: "м. Київ, вул. Лікарняна, 4, склад", tender_url: "https://prozorro.gov.ua/tender/...", now
    });
  db.prepare(`INSERT INTO samples (id,contract_id,description,qty,specs,due_date,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(uid(), cid, "Рукавички нітрилові, розмір M", "5 пар", "ДСТУ, без пудри", addDays(T, 2), now);
  db.prepare(`INSERT INTO shipments (id,contract_id,num,planned_date,nomenclature,qty,unit,address,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid(), cid, "1", addDays(T, 7), "Рукавички нітрилові M", 5000, "пар", "м. Київ, вул. Лікарняна, 4", now);
  db.prepare(`INSERT INTO documents (id,contract_id,kind,status,created_at) VALUES (?,?,?,?,?)`)
    .run(uid(), cid, "Договір", "signed", now);
  db.prepare(`INSERT INTO payments (id,contract_id,kind,planned_date,amount,created_at) VALUES (?,?,?,?,?,?)`)
    .run(uid(), cid, "payment", addDays(T, 21), 480000, now);
}
seedIfEmpty();

module.exports = { db, uid, todayKey, addDays, DB_PATH, UPLOAD_DIR };
