import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "akmotors.sqlite");
export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  price INTEGER NOT NULL,
  mileage INTEGER,
  transmission TEXT,
  fuel TEXT,
  color TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','SOLD')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS car_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  car_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL,
  sold_price INTEGER NOT NULL,
  sold_at TEXT NOT NULL DEFAULT (datetime('now')),
  buyer_name TEXT,
  notes TEXT,
  FOREIGN KEY (car_id) REFERENCES cars(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cars_status ON cars(status);
CREATE INDEX IF NOT EXISTS idx_car_images_car_id ON car_images(car_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_car_id ON sales(car_id);
`);

db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_cars_updated_at
AFTER UPDATE ON cars
FOR EACH ROW
BEGIN
  UPDATE cars SET updated_at = datetime('now') WHERE id = OLD.id;
END;
`);

export function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export const SETTINGS_KEYS = {
  COMPANY_NAME: "company.name",
  COMPANY_PHONE: "company.phone",
  COMPANY_EMAIL: "company.email",
  COMPANY_ADDRESS: "company.address",
  COMPANY_CURRENCY_CODE: "company.currency_code",
  COMPANY_CURRENCY_SYMBOL: "company.currency_symbol"
};

export function seedDefaultSettings() {
  // Old placeholder defaults (used to safely migrate existing installs)
  const OLD_DEFAULTS = {
    [SETTINGS_KEYS.COMPANY_NAME]: ["AK Motors", "AK MOTORS"],
    [SETTINGS_KEYS.COMPANY_PHONE]: ["+00 000 000 000", "+000 00000000", ""],
    [SETTINGS_KEYS.COMPANY_EMAIL]: ["sales@akmotors.example", ""],
    [SETTINGS_KEYS.COMPANY_ADDRESS]: [
      "Your City, Your Country",
      "Your Street, YourCity, Your Country",
      ""
    ],
    [SETTINGS_KEYS.COMPANY_CURRENCY_CODE]: ["", "USD", "HKD"],
    [SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL]: ["", "HK$", "$"]
  };

  // New defaults requested
  const NEW_DEFAULTS = {
    [SETTINGS_KEYS.COMPANY_NAME]: "AK MOTORS",
    [SETTINGS_KEYS.COMPANY_PHONE]: "852 91054784",
    [SETTINGS_KEYS.COMPANY_EMAIL]: "akmotorsbs@gmail.com",
    [SETTINGS_KEYS.COMPANY_ADDRESS]:
      "2794 Wing Ning Lei, Wang Toi Shan, Pat Heung, Kam Tin, Yuen Long, New Territory, Hong Kong",
    [SETTINGS_KEYS.COMPANY_CURRENCY_CODE]: "HKD",
    [SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL]: "HK$"
  };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  );
  const get = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const tx = db.transaction(() => {
    // First-time seed
    insert.run(SETTINGS_KEYS.COMPANY_NAME, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_NAME]);
    insert.run(SETTINGS_KEYS.COMPANY_PHONE, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_PHONE]);
    insert.run(SETTINGS_KEYS.COMPANY_EMAIL, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_EMAIL]);
    insert.run(SETTINGS_KEYS.COMPANY_ADDRESS, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_ADDRESS]);
    insert.run(SETTINGS_KEYS.COMPANY_CURRENCY_CODE, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_CURRENCY_CODE]);
    insert.run(SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL, NEW_DEFAULTS[SETTINGS_KEYS.COMPANY_CURRENCY_SYMBOL]);

    // Safe migration: update only if value is still the old placeholder
    for (const k of Object.values(SETTINGS_KEYS)) {
      const row = get.get(k);
      const current = row?.value;
      const oldList = OLD_DEFAULTS[k] || [];
      if (oldList.includes(current)) {
        setSetting(k, NEW_DEFAULTS[k]);
      }
    }
  });
  tx();
}

export function getSettingsMap() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
  ).run(key, value);
}

