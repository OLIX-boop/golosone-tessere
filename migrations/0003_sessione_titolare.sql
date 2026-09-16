-- Il pannello titolare ha un PIN proprio, distinto da quello di cassa.
--
-- Con un solo PIN condiviso, chiunque stia in cassa potrebbe cambiare la
-- soglia del premio o leggere gli incassi. Il PIN titolare si usa di rado e
-- fuori dalla fila, quindi non aggiunge attrito dove conta.
--
-- Da qui in avanti le migrazioni sono ADDITIVE: le tessere stampate portano
-- codici che non possono piu' essere rigenerati.
ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'cassa';
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope, expires_at);
