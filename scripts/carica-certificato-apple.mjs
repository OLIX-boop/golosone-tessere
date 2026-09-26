/**
 * Carica il certificato Apple come segreto del Worker.
 *
 * Esiste per le stesse ragioni di quello di Google, moltiplicate per tre: qui
 * i pezzi non sono uno ma quattro (chiave, certificato, intermedio Apple e
 * chiave del push), arrivano in formati diversi, e due di loro devono
 * combaciare fra loro. Sbagliarne uno si scopre solo davanti a un iPhone che
 * si rifiuta di aprire il pass senza dire perche'.
 *
 * Quindi qui si controlla tutto PRIMA di caricare:
 *   * che la chiave privata corrisponda davvero a quel certificato;
 *   * che il certificato sia un Pass Type ID e non un altro certificato Apple;
 *   * che non sia gia' scaduto.
 *
 * Pass Type ID e Team ID non si chiedono: stanno scritti dentro il
 * certificato, e leggerli da li' toglie di mezzo l'unico modo di farli
 * discordare.
 *
 *   npm run apple:certificato -- --chiave pass.key --certificato pass.cer
 *                                [--apns AuthKey_XXXXXXXXXX.p8] [--wwdr AppleWWDRCAG4.cer]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { WWDR_G4 } from '../src/apple-wwdr.ts';

/**
 * Tetto di Cloudflare per un singolo segreto. Non e' un numero tondo e non e'
 * documentato in modo evidente: si scopre quando il caricamento fallisce.
 */
const LIMITE_SEGRETO = 5 * 1024;

const USO = `
Servono almeno la chiave privata e il certificato scaricato da Apple.

  npm run apple:certificato -- --chiave pass.key --certificato pass.cer

Facoltativi:
  --apns AuthKey_XXXXXXXXXX.p8   chiave per le notifiche (senza, il pass si
                                 aggiorna solo quando il cliente lo tira giu')
  --wwdr AppleWWDRCAG4.cer       altro intermedio Apple, se un giorno il G4
                                 che sta nel codice non bastasse piu'

I due file obbligatori si producono cosi', da questa stessa cartella:

  openssl genrsa -out pass.key 2048
  MSYS2_ARG_CONV_EXCL="*" openssl req -new -key pass.key -out pass.csr \\
    -subj "/emailAddress=TUA@EMAIL/CN=Tessere/C=IT"

Poi si carica pass.csr su developer.apple.com, alla voce Identifiers ->
Pass Type IDs, e si riscarica il certificato come pass.cer.
`;

// ------------------------------------------------------------------ argomenti

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith('--')) continue;
  args[k.slice(2)] = process.argv[i + 1];
}

if (!args.chiave || !args.certificato) {
  console.error(USO);
  process.exit(1);
}

function leggi(percorso, cosa) {
  try {
    return readFileSync(percorso);
  } catch (err) {
    console.error(`\nNon riesco a leggere ${cosa}:\n  ${percorso}\n  ${err.message}\n`);
    process.exit(1);
  }
}

/** Apple consegna i certificati in DER. Se non e' gia' PEM, lo diventa qui. */
function versoPem(buf, etichetta) {
  const testo = buf.toString('utf8');
  if (testo.includes('-----BEGIN')) return testo;
  const b64 = buf.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ${etichetta}-----\n${b64}\n-----END ${etichetta}-----\n`;
}

// ---------------------------------------------------------------- certificato

const certPem = versoPem(leggi(args.certificato, 'il certificato'), 'CERTIFICATE');

let cert;
try {
  cert = new X509Certificate(certPem);
} catch (err) {
  console.error(`\nQuesto non sembra un certificato: ${err.message}\n`);
  process.exit(1);
}

// Il soggetto arriva come righe "CHIAVE=valore".
const soggetto = Object.fromEntries(
  cert.subject.split('\n').map((r) => {
    const i = r.indexOf('=');
    return [r.slice(0, i).trim(), r.slice(i + 1).trim()];
  }),
);

const passTypeId = soggetto.UID;
const teamId = soggetto.OU;

if (!passTypeId?.startsWith('pass.')) {
  console.error(`
Questo non e' un certificato Pass Type ID.

Dentro dovrebbe esserci un UID che comincia per "pass.". Trovato invece:
  ${cert.subject.replace(/\n/g, ', ')}

Attenzione a non confondersi con il certificato di sviluppo o con quello
delle notifiche: qui serve quello creato sotto Identifiers -> Pass Type IDs.
`);
  process.exit(1);
}

const scadenza = new Date(cert.validTo);
if (scadenza < new Date()) {
  console.error(`\nIl certificato e' scaduto il ${scadenza.toLocaleDateString('it-IT')}. Va rinnovato su developer.apple.com.\n`);
  process.exit(1);
}

// ------------------------------------------------------------------- chiave

const keyRaw = leggi(args.chiave, 'la chiave privata');
let keyPem;
try {
  // Normalizza a PKCS#8: e' l'unico formato che Web Crypto sa importare.
  keyPem = createPrivateKey(keyRaw).export({ type: 'pkcs8', format: 'pem' });
} catch (err) {
  console.error(`\nLa chiave privata non si legge: ${err.message}\n`);
  process.exit(1);
}

// Il controllo che vale di piu': chiave e certificato devono essere una coppia.
// Se non lo sono, la firma esce formalmente valida ma iOS la rifiuta.
const daChiave = createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
const daCert = cert.publicKey.export({ type: 'spki', format: 'der' });
if (!daChiave.equals(daCert)) {
  console.error(`
La chiave privata non corrisponde a questo certificato.

Succede quando si rigenera la chiave dopo aver caricato il CSR: il
certificato scaricato da Apple vale solo per la chiave con cui e' nato il
CSR. Se hai ancora quella chiave, usa quella; altrimenti rifai il giro.
`);
  process.exit(1);
}

// -------------------------------------------------------------------- WWDR

// L'intermedio di norma non entra nel segreto: e' pubblico e sta nel codice.
// Si accetta un file solo per il giorno in cui Apple cambiasse intermedio.
const wwdrPem = args.wwdr
  ? versoPem(leggi(args.wwdr, "l'intermedio Apple"), 'CERTIFICATE')
  : versoPem(Buffer.from(WWDR_G4.replace(/\s+/g, ''), 'base64'), 'CERTIFICATE');

try {
  const wwdr = new X509Certificate(wwdrPem);
  if (cert.checkIssued && !cert.checkIssued(wwdr)) {
    console.warn(`
Attenzione: l'intermedio non risulta essere quello che ha emesso il tuo
certificato (${wwdr.subject.replace(/\n/g, ', ')}).

Apple ne ha piu' di uno. Scarica quello giusto dalla pagina delle autorita'
di certificazione Apple e ripassalo con --wwdr: se sbagliato, iPhone rifiuta
il pass senza spiegare perche'.
`);
  }
} catch { /* l'intermedio non si legge: il controllo salta, la firma no */ }

// -------------------------------------------------------------------- APNs

let apnsKeyId = null;
let apnsKey = null;
if (args.apns) {
  apnsKey = leggi(args.apns, 'la chiave APNs').toString('utf8');
  // Il nome del file di Apple e' AuthKey_<KEYID>.p8: l'identificativo sta li'.
  const dalNome = basename(args.apns).match(/AuthKey_([A-Z0-9]{10})/i);
  apnsKeyId = args.apnsKeyId ?? dalNome?.[1] ?? null;
  if (!apnsKeyId) {
    console.error(`
Non riesco a ricavare l'identificativo della chiave APNs dal nome del file.

Rinomina il file come lo consegna Apple (AuthKey_XXXXXXXXXX.p8) oppure
aggiungi --apnsKeyId XXXXXXXXXX.
`);
    process.exit(1);
  }
  try {
    createPrivateKey(apnsKey);
  } catch (err) {
    console.error(`\nLa chiave APNs non si legge: ${err.message}\n`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ caricamento

/**
 * Via intestazioni e a capo: resta il solo base64, che e' gia' la forma
 * compatta del certificato. Il Worker rimette a posto quel che serve.
 *
 * Non si ricodifica niente in base64 una seconda volta: un segreto di Worker
 * non puo' superare i 5,1 kB, e incartare un PEM dentro un altro base64 lo
 * gonfia di un terzo, che qui e' la differenza fra starci e non starci.
 */
const nudo = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

const pacchetto = {
  passTypeId,
  teamId,
  cert: nudo(certPem),
  key: nudo(keyPem),
  // l'intermedio entra nel segreto SOLO se ne e' stato passato uno diverso da
  // quello che il codice ha gia' dentro
  ...(args.wwdr ? { wwdr: nudo(wwdrPem) } : {}),
  ...(apnsKeyId
    ? {
        apnsKeyId,
        // normalizzata a PKCS#8: e' l'unica forma che Web Crypto sa importare
        apnsKey: createPrivateKey(apnsKey).export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      }
    : {}),
};

const payload = JSON.stringify(pacchetto);

console.log(`
Pass Type ID : ${passTypeId}
Team ID      : ${teamId}
Scade il     : ${scadenza.toLocaleDateString('it-IT')}
Notifiche    : ${apnsKeyId ? `si (chiave ${apnsKeyId})` : 'no - il pass si aggiornera solo a strappo'}
Intermedio   : ${args.wwdr ? 'quello passato con --wwdr, dentro il segreto' : 'il G4 che sta nel codice'}
Dimensione   : ${(payload.length / 1024).toFixed(1)} kB su un tetto di ${(LIMITE_SEGRETO / 1024).toFixed(1)} kB
`);

if (payload.length > LIMITE_SEGRETO) {
  console.error(`
Il pacchetto non ci sta: Cloudflare rifiuta i segreti sopra i ${(LIMITE_SEGRETO / 1024).toFixed(1)} kB.

${args.wwdr
  ? 'Prova senza --wwdr: quello nel codice non occupa spazio nel segreto.'
  : 'Sta succedendo qualcosa di inatteso, perche senza --wwdr il pacchetto\ndovrebbe stare intorno ai 4 kB. Controlla che --chiave punti a una chiave\nRSA da 2048 bit e non a una piu lunga.'}
`);
  process.exit(1);
}

console.log('Lo carico su Cloudflare come segreto APPLE_WALLET_CERT...\n');

// shell: true serve su Windows, dove npx e' uno script e non un eseguibile.
const esito = spawnSync('npx wrangler secret put APPLE_WALLET_CERT', {
  input: payload,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true,
});

if (esito.error) {
  console.error(`\nNon sono riuscito ad avviare wrangler: ${esito.error.message}\n`);
  process.exit(1);
}
if (esito.status !== 0) {
  console.error(`
Caricamento non riuscito (codice ${esito.status}).

Le due cause piu' comuni sono: non essere collegati (npx wrangler login) o
non aver ancora pubblicato il Worker (npx wrangler deploy).
`);
  process.exit(esito.status ?? 1);
}

console.log(`
Fatto. Non c'e' altro da configurare: Pass Type ID e Team ID viaggiano dentro
il certificato, quindi il pannello titolare dovrebbe gia' dire "Attivo".

Ricorda che il certificato Apple scade dopo un anno: quando succede, il
pulsante smette di funzionare e va rifatto questo giro. I pass gia' nei
telefoni continuano ad aggiornarsi, perche' i loro token non dipendono dal
certificato.
`);
