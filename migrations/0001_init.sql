-- ============================================================
-- Golosone Tessere - schema iniziale
-- Regole di fondo:
--   * transactions e' la fonte di verita': i saldi su customers
--     sono una cache ricalcolabile.
--   * gli importi sono SEMPRE in centesimi interi, mai float.
--   * il codice cliente e' opaco e immutabile: non contiene dati.
-- ============================================================

PRAGMA foreign_keys = ON;

-- Parametri modificabili senza toccare il codice.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Un negozio solo per ora, ma la colonna store_id c'e' ovunque:
-- aggiungerla dopo sarebbe una migrazione dolorosa, adesso costa zero.
CREATE TABLE IF NOT EXISTS stores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS operators (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  name       TEXT    NOT NULL,
  pin_hash   TEXT    NOT NULL,
  pin_salt   TEXT    NOT NULL,
  -- 'admin' vede i report e gestisce i premi, 'cassa' assegna e basta.
  role       TEXT    NOT NULL DEFAULT 'cassa' CHECK (role IN ('admin','cassa')),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_operators_store ON operators(store_id, active);

CREATE TABLE IF NOT EXISTS sessions (
  -- si salva l'hash del token, mai il token in chiaro
  token_hash  TEXT    PRIMARY KEY,
  operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS customers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- il codice stampato sulla tessera: alfabeto senza caratteri ambigui
  code           TEXT    NOT NULL UNIQUE,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  first_name     TEXT    NOT NULL,
  last_name      TEXT,
  -- phone_norm serve per la ricerca "ho dimenticato la tessera"
  phone          TEXT,
  phone_norm     TEXT,
  email          TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_at     INTEGER,

  -- cache dei saldi (ricalcolabile da transactions)
  points_balance INTEGER NOT NULL DEFAULT 0,
  cents_carry    INTEGER NOT NULL DEFAULT 0,  -- resto verso il punto successivo
  lifetime_cents INTEGER NOT NULL DEFAULT 0,

  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_norm);
CREATE INDEX IF NOT EXISTS idx_customers_store ON customers(store_id, active);

CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  name        TEXT    NOT NULL,
  description TEXT,
  points_cost INTEGER NOT NULL CHECK (points_cost > 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_rewards_store ON rewards(store_id, active, sort_order);

-- Registro movimenti: append-only. Un errore si annulla con void, non si cancella.
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  operator_id  INTEGER NOT NULL REFERENCES operators(id),
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('earn','redeem','adjust')),
  amount_cents INTEGER NOT NULL DEFAULT 0,   -- solo per 'earn'
  points_delta INTEGER NOT NULL,             -- +guadagnati / -spesi
  reward_id    INTEGER REFERENCES rewards(id),
  note         TEXT,
  voided_at    INTEGER,
  voided_by    INTEGER REFERENCES operators(id),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_operator ON transactions(operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_store_day ON transactions(store_id, created_at DESC);

-- ------------------------------------------------------------
-- Dati iniziali
-- ------------------------------------------------------------
INSERT OR IGNORE INTO stores (id, name) VALUES (1, 'Pasticceria');

-- 500 centesimi = 1 punto. Modificabile da qui senza rideploy.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('cents_per_point',  '500'),
  ('store_name',       'Pasticceria'),
  ('void_window_min',  '15'),     -- minuti entro cui la cassa puo' annullare
  ('max_amount_cents', '50000');  -- tetto anti-errore di battitura: 500 EUR
