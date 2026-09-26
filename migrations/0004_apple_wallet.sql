-- Pass Apple che si aggiornano da soli.
--
-- Per mandare un aggiornamento bisogna sapere QUALI telefoni hanno quella
-- tessera: il pass, una volta installato, chiama il Worker e si registra.
-- Da qui le due tabelle, con la relazione molti-a-molti che ci sta in mezzo:
-- una famiglia puo' tenere la stessa tessera su due telefoni, e un telefono
-- puo' avere piu' tessere del negozio.
--
-- Non c'e' niente di personale qui dentro: un identificativo di dispositivo
-- che genera Apple, un token di push e il codice della tessera.
--
-- Migrazione ADDITIVA, come la 0003: non tocca le tabelle esistenti e non
-- rigenera codici gia' stampati.

CREATE TABLE IF NOT EXISTS apple_devices (
  device_library_id TEXT PRIMARY KEY,   -- lo assegna Apple, non lo scegliamo noi
  push_token        TEXT NOT NULL,      -- cambia nel tempo: si riscrive a ogni registrazione
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS apple_registrations (
  device_library_id TEXT NOT NULL REFERENCES apple_devices(device_library_id) ON DELETE CASCADE,
  -- il numero di serie del pass E' il codice tessera: uno solo da ricordare
  serial_number     TEXT NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (device_library_id, serial_number)
);

-- Serve al push: dato un codice tessera, trovare i telefoni da svegliare.
CREATE INDEX IF NOT EXISTS idx_apple_reg_serial ON apple_registrations(serial_number);

-- Chiave da cui si derivano i token di autenticazione dei pass.
--
-- Si genera qui, una volta, invece di stare fra i segreti del Worker: non
-- permette di emettere tessere, protegge solo la lettura di un saldo che il
-- QR mostra gia' a chiunque abbia il link. Sta separata dal certificato
-- perche' i certificati Apple scadono ogni anno, e legare i token al
-- certificato vorrebbe dire che al primo rinnovo tutti i pass gia'
-- consegnati smetterebbero di aggiornarsi.
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('apple_auth_key', lower(hex(randomblob(32))));
