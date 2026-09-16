-- ============================================================
-- Tessere punti - schema iniziale
--
-- Regole di fondo:
--   * si registrano PUNTI, non importi. L'operatore decide quanti
--     punti vale uno scontrino e li assegna: non esiste un prezzo
--     scritto che il cliente possa contestare, e le spese minime
--     non accumulano residui verso un punto che non hanno pagato.
--   * un solo PIN condiviso: il pannello si apre dalla cassa e resta
--     aperto, autenticare ogni singolo operatore sarebbe attrito
--     senza guadagno.
--   * il codice cliente e' opaco e immutabile: non contiene dati.
-- ============================================================

PRAGMA foreign_keys = ON;

-- Parametri modificabili senza toccare il codice (PIN compreso).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Un negozio solo per ora, ma store_id c'e' ovunque: aggiungerlo
-- dopo sarebbe una migrazione dolorosa, adesso costa zero.
CREATE TABLE IF NOT EXISTS stores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sessione del dispositivo, non della persona: la cassa entra una
-- volta col PIN e resta dentro per tutta la giornata.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,   -- si salva l'hash, mai il token
  label      TEXT,                  -- 'cassa', 'telefono'... solo descrittivo
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS customers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- il codice stampato sulla tessera: alfabeto senza caratteri ambigui
  code           TEXT    NOT NULL UNIQUE,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  first_name     TEXT    NOT NULL,
  last_name      TEXT,
  -- phone_norm serve alla ricerca "ho dimenticato la tessera"
  phone          TEXT,
  phone_norm     TEXT,
  email          TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_at     INTEGER,

  points_balance  INTEGER NOT NULL DEFAULT 0,  -- punti spendibili adesso
  points_lifetime INTEGER NOT NULL DEFAULT 0,  -- totale storico, solo statistica

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

-- Registro movimenti. Un errore si annulla, non si cancella: serve a
-- spiegare un saldo, non a fare da scontrino.
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('earn','redeem','adjust')),
  points_delta INTEGER NOT NULL,           -- +assegnati / -spesi
  reward_id    INTEGER REFERENCES rewards(id),
  note         TEXT,
  voided_at    INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_store_day ON transactions(store_id, created_at DESC);

-- ------------------------------------------------------------
-- Dati iniziali
-- ------------------------------------------------------------
INSERT OR IGNORE INTO stores (id, name) VALUES (1, 'Pasticceria');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('store_name',               'Pasticceria'),
  ('void_window_min',          '30'),   -- minuti entro cui annullare un movimento
  -- Tetto anti-errore di battitura: con l'inserimento diretto dei punti,
  -- un 2 che diventa 22 e' una tortina regalata senza accorgersene.
  ('max_points_per_tx',        '20'),
  ('show_rewards_to_customer', '1');
