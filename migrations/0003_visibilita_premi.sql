-- Se il premio si ritira e basta in negozio, elencarlo sulla pagina cliente
-- puo' essere superfluo. Lo rendiamo un interruttore invece di una scelta
-- fissa: '1' mostra il traguardo al cliente, '0' lascia solo il saldo punti.
INSERT OR IGNORE INTO settings (key, value) VALUES ('show_rewards_to_customer', '1');
