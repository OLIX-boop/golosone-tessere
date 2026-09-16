-- Catalogo premi di partenza. Sono solo un esempio ragionevole:
-- si cambiano dal pannello titolare senza toccare il codice.
INSERT INTO rewards (store_id, name, description, points_cost, sort_order) VALUES
  (1, 'Caffe omaggio',        'Un caffe al banco',                     5,  1),
  (1, 'Cornetto omaggio',     'Un cornetto a scelta',                 10,  2),
  (1, 'Pasticcini 200g',      'Vassoietto di pasticceria mignon',     25,  3),
  (1, 'Torta 6 persone',      'Torta a scelta dal banco',             60,  4);
