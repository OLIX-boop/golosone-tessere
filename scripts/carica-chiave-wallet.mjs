/**
 * Carica la chiave del service account Google come segreto del Worker.
 *
 * Esiste per togliere di mezzo un passaggio scomodo: il JSON di Google
 * contiene una chiave PEM su piu' righe, e passarla a mano a `wrangler secret`
 * e' un invito a rovinarla. Qui viene letta, controllata e codificata in
 * base64 prima di partire.
 *
 *   npm run wallet:chiave -- C:\\percorso\\service-account.json
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const percorso = process.argv[2];

if (!percorso) {
  console.error(`
Serve il percorso del file JSON scaricato da Google.

  npm run wallet:chiave -- "C:\\Users\\andre\\Downloads\\service-account.json"

Il file si scarica dalla console Google Cloud, nella sezione degli account
di servizio: e' quello che comincia con {"type":"service_account",...
`);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(readFileSync(percorso, 'utf8'));
} catch (err) {
  console.error(`\nNon riesco a leggere il file:\n  ${percorso}\n  ${err.message}\n`);
  process.exit(1);
}

// Meglio accorgersene qui che davanti a un errore di Google fra tre passaggi.
if (json.type !== 'service_account' || !json.client_email || !json.private_key) {
  console.error(`
Questo non sembra il file giusto.

Deve essere il JSON di un ACCOUNT DI SERVIZIO, con dentro "type":
"service_account", "client_email" e "private_key".

Trovato invece: ${JSON.stringify(Object.keys(json)).slice(0, 120)}
`);
  process.exit(1);
}

const base64 = Buffer.from(JSON.stringify(json)).toString('base64');

console.log(`\nAccount di servizio: ${json.client_email}`);
console.log(`Lo carico su Cloudflare come segreto GOOGLE_WALLET_SA...\n`);

const esito = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', 'secret', 'put', 'GOOGLE_WALLET_SA'],
  { input: base64, stdio: ['pipe', 'inherit', 'inherit'] },
);

if (esito.status !== 0) {
  console.error('\nCaricamento non riuscito. Sei collegato? Prova: npx wrangler login\n');
  process.exit(esito.status ?? 1);
}

console.log(`
Fatto.

Ora manca solo l'ID emittente: si incolla nel pannello titolare,
scheda Impostazioni, riquadro Google Wallet.
`);
