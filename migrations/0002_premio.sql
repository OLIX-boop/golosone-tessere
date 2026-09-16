-- Catalogo premi.
--
-- Per ora ce n'e' uno solo: la tortina. Resta comunque una riga di tabella e
-- non un valore scritto nel codice, cosi' si cambia nome e soglia con un
-- comando, e aggiungerne altri non richiede toccare nulla.
INSERT INTO rewards (store_id, name, description, points_cost, sort_order) VALUES
  (1, 'Tortina', 'Una tortina a scelta', 20, 1);
