-- Dispositivi che hanno installato un pass Apple.
--
-- Lo schema ricalca quello gia' presente in produzione: due registrazioni
-- reali esistevano prima di questo codice, e cambiare i nomi delle colonne le
-- avrebbe orfanate.
--
-- Serve a sapere a chi mandare la notifica quando i punti cambiano, e a
-- rispondere alla domanda "cos'e' cambiato da quando ho guardato?" che iOS fa
-- quando il cliente tira giu' la tessera per aggiornarla.
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
CREATE INDEX IF NOT EXISTS idx_apple_serial ON apple_registrations(serial_number);
