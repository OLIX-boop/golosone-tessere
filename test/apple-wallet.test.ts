import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify as verifySig } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, crc32 } from '../src/zip.ts';
import { signDetached } from '../src/pkcs7.ts';
import { providerToken } from '../src/apns.ts';
import {
  authToken,
  buildPkpass,
  passJson,
  readConfig,
  readConfigDetailed,
  tokenValido,
  type AppleConfig,
} from '../src/apple-wallet.ts';
import { sha256Hex } from '../src/auth.ts';
import app from '../src/index.ts';
import { CERT_PROVA, CHIAVE_PROVA, WWDR_PROVA } from './certificati-di-prova.ts';

/**
 * Un pass Apple sbagliato non da' errori: iPhone lo rifiuta e basta, senza
 * dire cosa non andava. Non esiste un messaggio da leggere, e provare a
 * tentativi significa un giro di deploy per ipotesi.
 *
 * Quindi qui si verifica tutto quello che si puo' verificare da fermi: che
 * l'archivio sia un vero ZIP, che la firma regga a OpenSSL, e che dentro il
 * pass ci siano le chiavi senza le quali non si torna piu' indietro.
 */

const config: AppleConfig = {
  passTypeId: 'pass.test.golosone',
  teamId: 'TEAM123456',
  certPem: CERT_PROVA,
  keyPem: CHIAVE_PROVA,
  wwdrPem: WWDR_PROVA,
  apns: null,
  storeName: 'Pasticceria Golosone',
  origin: 'https://tessere.pasticceria.workers.dev',
  authKey: 'chiave-di-prova-non-segreta',
};

// Codice di 8 caratteri dall'alfabeto vero: e' il formato che gira davvero.
const tessera = { code: 'K7H9M2PQ', firstName: 'Anna', points: 13 };

/** OpenSSL non c'e' ovunque: dove manca, i test che lo usano si saltano. */
const openssl = spawnSync('openssl', ['version']).status === 0;

/**
 * Manifesto finto, con gli a capo come quello vero.
 *
 * Gli a capo non sono un dettaglio: con un contenuto tutto su una riga il
 * test passerebbe anche usando il comando di verifica sbagliato, perche' e'
 * solo andando a capo che OpenSSL, senza -binary, riscrive il contenuto e la
 * firma smette di tornare.
 */
const MANIFESTO_FINTO = '{\n  "pass.json": "aabb"\n}';

// ===================================================================== ZIP

/**
 * Lettore minimo, scritto apposta per i test: parte dall'indice in fondo,
 * come farebbe un lettore vero. Se gli scostamenti fossero sbagliati non
 * troverebbe niente.
 */
function leggiZip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'fine dell indice non trovata');

  const quanti = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();

  for (let i = 0; i < quanti; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50, 'voce di indice malformata');
    const crcAtteso = dv.getUint32(at + 16, true);
    const size = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const locale = dv.getUint32(at + 42, true);
    const nome = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen));

    // dalla voce di indice si salta all'intestazione del file e si legge il dato
    assert.equal(dv.getUint32(locale, true), 0x04034b50, `intestazione di ${nome} malformata`);
    const nomeLocale = dv.getUint16(locale + 26, true);
    const extraLocale = dv.getUint16(locale + 28, true);
    const inizio = locale + 30 + nomeLocale + extraLocale;
    const dati = buf.subarray(inizio, inizio + size);

    assert.equal(crc32(dati), crcAtteso, `CRC sbagliato per ${nome}`);
    out.set(nome, dati);
    at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  return out;
}

test('l archivio si rilegge e ogni file torna identico', () => {
  const enc = new TextEncoder();
  const dentro = zip([
    { name: 'pass.json', data: enc.encode('{"a":1}') },
    { name: 'icon.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) },
    { name: 'manifest.json', data: enc.encode('{}') },
  ]);
  const letto = leggiZip(dentro);
  assert.deepEqual([...letto.keys()], ['pass.json', 'icon.png', 'manifest.json']);
  assert.equal(new TextDecoder().decode(letto.get('pass.json')!), '{"a":1}');
});

test('lo stesso contenuto produce gli stessi byte', () => {
  const enc = new TextEncoder();
  const uno = zip([{ name: 'a.txt', data: enc.encode('ciao') }]);
  const due = zip([{ name: 'a.txt', data: enc.encode('ciao') }]);
  assert.deepEqual(uno, due);
});

test('un archivio vuoto resta un archivio valido', () => {
  assert.equal(leggiZip(zip([])).size, 0);
});

// ================================================================== firma

test('la firma del manifesto verifica con la chiave del certificato', async () => {
  const contenuto = new TextEncoder().encode('{"pass.json":"aabb"}');
  const firma = await signDetached(
    { certPem: CERT_PROVA, keyPem: CHIAVE_PROVA, wwdrPem: WWDR_PROVA },
    contenuto,
  );

  // Dentro la struttura si cercano gli attributi firmati e la firma, e si
  // verifica il legame fra i due: e' esattamente quel che fa iOS.
  const der = Buffer.from(firma);
  const impronta = createHash('sha256').update(contenuto).digest();
  assert.ok(der.includes(impronta), 'l impronta del manifesto non e negli attributi');
  assert.ok(der.length > 1000, 'la firma non contiene i certificati');
});

test('OpenSSL accetta la firma come CMS valido', { skip: !openssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
  // Con gli a capo, come il manifesto vero: senza, il test passerebbe
  // anche con una firma che si rompe appena il contenuto va a capo.
  const contenuto = new TextEncoder().encode(MANIFESTO_FINTO);
  const firma = await signDetached(
    { certPem: CERT_PROVA, keyPem: CHIAVE_PROVA, wwdrPem: WWDR_PROVA },
    contenuto,
  );
  writeFileSync(join(dir, 'manifest.json'), contenuto);
  writeFileSync(join(dir, 'sig.der'), firma);
  writeFileSync(join(dir, 'ca.pem'), WWDR_PROVA);

  const esito = spawnSync(
    'openssl',
    ['cms', '-verify', '-inform', 'DER', '-in', join(dir, 'sig.der'),
     '-content', join(dir, 'manifest.json'), '-CAfile', join(dir, 'ca.pem'),
     '-purpose', 'any', '-binary', '-out', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    { encoding: 'utf8' },
  );
  assert.equal(esito.status, 0, `OpenSSL ha rifiutato la firma:\n${esito.stderr}`);
});

test('una firma su un manifesto diverso non verifica', { skip: !openssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
  const firma = await signDetached(
    { certPem: CERT_PROVA, keyPem: CHIAVE_PROVA, wwdrPem: WWDR_PROVA },
    new TextEncoder().encode(MANIFESTO_FINTO),
  );
  // il manifesto cambia di un carattere: la firma non deve piu' tornare
  writeFileSync(join(dir, 'manifest.json'), MANIFESTO_FINTO.replace('aabb', 'aabc'));
  writeFileSync(join(dir, 'sig.der'), firma);
  writeFileSync(join(dir, 'ca.pem'), WWDR_PROVA);

  const esito = spawnSync(
    'openssl',
    ['cms', '-verify', '-inform', 'DER', '-in', join(dir, 'sig.der'),
     '-content', join(dir, 'manifest.json'), '-CAfile', join(dir, 'ca.pem'),
     '-purpose', 'any', '-binary', '-out', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    { encoding: 'utf8' },
  );
  assert.notEqual(esito.status, 0, 'la firma ha verificato su un contenuto manomesso');
});

// =============================================================== pass.json

test('il pass porta le chiavi obbligatorie di Apple', async () => {
  const p = JSON.parse(await passJson(config, tessera));
  for (const k of ['formatVersion', 'passTypeIdentifier', 'teamIdentifier',
                   'organizationName', 'description', 'serialNumber']) {
    assert.ok(p[k], `manca la chiave obbligatoria ${k}`);
  }
  assert.equal(p.formatVersion, 1);
  assert.equal(p.serialNumber, tessera.code);
  assert.equal(p.storeCard.primaryFields[0].value, 13);
});

/**
 * Questo e' il test che protegge la decisione da cui non si torna indietro:
 * un pass senza queste due chiavi nasce congelato, e non c'e' modo di
 * aggiungergliele dopo. I pass gia' consegnati resterebbero fermi per sempre.
 */
test('il pass nasce collegato al servizio di aggiornamento', async () => {
  const p = JSON.parse(await passJson(config, tessera));
  assert.equal(p.webServiceURL, `${config.origin}/wallet-apple`);
  assert.ok(p.authenticationToken?.length >= 16, 'token di autenticazione assente o troppo corto');
});

test('il QR del pass porta allo stesso indirizzo della tessera di cartone', async () => {
  const p = JSON.parse(await passJson(config, tessera));
  assert.equal(p.barcodes[0].message, `${config.origin}/c/${tessera.code}`);
  assert.equal(p.barcodes[0].messageEncoding, 'iso-8859-1');
  assert.equal(p.barcodes[0].altText, tessera.code);
});

test('il traguardo compare solo se c e un premio da raggiungere', async () => {
  const senza = JSON.parse(await passJson(config, tessera));
  assert.deepEqual(senza.storeCard.auxiliaryFields, []);

  const con = JSON.parse(
    await passJson(config, { ...tessera, nextReward: { name: 'Tortina', points_cost: 20 } }),
  );
  assert.equal(con.storeCard.auxiliaryFields[0].value, 'Tortina fra 7 punti');
});

test('una tessera senza nome non lascia il campo vuoto', async () => {
  const p = JSON.parse(await passJson(config, { ...tessera, firstName: null }));
  assert.equal(p.storeCard.secondaryFields[0].value, 'Cliente');
});

// ============================================================ token del pass

test('il token del pass e stabile e diverso per ogni tessera', async () => {
  const a1 = await authToken(config, 'K7H9M2PQ');
  const a2 = await authToken(config, 'K7H9M2PQ');
  const b = await authToken(config, 'K7H9M2PR');
  assert.equal(a1, a2, 'lo stesso codice deve dare sempre lo stesso token');
  assert.notEqual(a1, b);
});

/**
 * I certificati Apple scadono ogni anno. Se il token dipendesse dal
 * certificato, al primo rinnovo tutti i pass gia' nei telefoni comincerebbero
 * a ricevere 401 e smetterebbero di aggiornarsi, senza che nessuno se ne
 * accorga finche' un cliente non se ne lamenta.
 */
test('il token non cambia se cambia il certificato', async () => {
  const rinnovato = { ...config, certPem: WWDR_PROVA };
  assert.equal(await authToken(config, 'K7H9M2PQ'), await authToken(rinnovato, 'K7H9M2PQ'));
});

// =================================================================== pkpass

/** Finti asset: restituiscono byte riconoscibili senza uscire in rete. */
const finti = {
  fetch: async (url: string) => {
    const p = new URL(url).pathname;
    if (!p.startsWith('/pass/')) return new Response('', { status: 404 });
    // byte diversi per nome, cosi' si vede se finiscono nel posto sbagliato
    return new Response(new Uint8Array([p.length, 1, 2, 3]));
  },
} as any;

test('il pkpass contiene pass.json, manifesto, firma e immagini', async () => {
  const file = leggiZip(await buildPkpass(config, tessera, finti));
  for (const atteso of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'logo.png']) {
    assert.ok(file.has(atteso), `manca ${atteso} dentro il pkpass`);
  }
});

/**
 * La striscia e' la fascia dietro il numero dei punti. Senza, la tessera e'
 * un rettangolo di colore piatto - ed e' esattamente com'era prima, quando
 * il pacchetto conteneva solo icona e logo.
 */
test('il pkpass porta la striscia e le tre densita di ogni immagine', async () => {
  const file = leggiZip(await buildPkpass(config, tessera, finti));
  for (const atteso of [
    'icon.png', 'icon@2x.png', 'icon@3x.png',
    'logo.png', 'logo@2x.png', 'logo@3x.png',
    'strip.png', 'strip@2x.png', 'strip@3x.png',
  ]) {
    assert.ok(file.has(atteso), `manca ${atteso}: la tessera uscirebbe spoglia o sfocata`);
  }
});

test('il manifesto copre ogni file e le impronte tornano', async () => {
  const file = leggiZip(await buildPkpass(config, tessera, finti));
  const manifest = JSON.parse(new TextDecoder().decode(file.get('manifest.json')!));

  // manifesto e firma non elencano se stessi: lo dice il formato
  const elencabili = [...file.keys()].filter((n) => n !== 'manifest.json' && n !== 'signature');
  assert.deepEqual(Object.keys(manifest).sort(), elencabili.sort());

  for (const [nome, impronta] of Object.entries(manifest)) {
    const atteso = createHash('sha1').update(Buffer.from(file.get(nome)!)).digest('hex');
    assert.equal(impronta, atteso, `impronta sbagliata per ${nome}`);
  }
});

test('senza icona il pass si costruisce lo stesso, ma senza immagini', async () => {
  const file = leggiZip(await buildPkpass(config, tessera, undefined));
  assert.ok(file.has('pass.json'));
  assert.ok(!file.has('icon.png'));
});

/**
 * Regressione, scoperta solo in produzione: la CDN di Cloudflare non serve
 * una chiocciola cosi' com'e', risponde 307 e rimanda a `%40`. Un 307 qui non
 * e' `ok`, quindi l'immagine veniva scartata in silenzio e il pass usciva
 * senza icona - cioe' rifiutato da iOS, senza spiegazioni. In locale non si
 * vedeva: il runtime di sviluppo la chiocciola la serve.
 */
test('i file chiesti alla CDN non contengono la chiocciola', async () => {
  const chiesti: string[] = [];
  const spia = {
    fetch: async (url: string) => {
      chiesti.push(new URL(url).pathname);
      return new Response(new Uint8Array([1, 2, 3, 4]));
    },
  } as any;

  const file = leggiZip(await buildPkpass(config, tessera, spia));

  assert.ok(chiesti.length > 0, 'non e stata chiesta nessuna immagine');
  for (const p of chiesti) {
    assert.ok(!p.includes('@'), `${p} verrebbe reindirizzato dalla CDN e perso`);
  }
  // dentro il pass i nomi con la chiocciola invece ci vogliono: li' li pretende Apple
  assert.ok(file.has('icon@2x.png'), 'dentro il pass i nomi Apple devono restare');
  assert.ok(file.has('logo@3x.png'));
});

test('se un immagine manca il pass si costruisce lo stesso, senza quella', async () => {
  const senzaStriscia = {
    fetch: async (url: string) =>
      new URL(url).pathname.includes('/strip')
        ? new Response('', { status: 404 })
        : new Response(new Uint8Array([1, 2, 3, 4])),
  } as any;
  const file = leggiZip(await buildPkpass(config, tessera, senzaStriscia));
  assert.ok(file.has('icon.png'), 'l icona c era e doveva restare');
  assert.ok(!file.has('strip.png'), 'la striscia mancante non deve entrare vuota');
  assert.ok(file.has('signature'), 'un immagine in meno non deve impedire la firma');
});

// ============================================================ configurazione

const segreto = (extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      passTypeId: 'pass.test.golosone',
      teamId: 'TEAM123456',
      cert: CERT_PROVA,
      key: CHIAVE_PROVA,
      wwdr: WWDR_PROVA,
      ...extra,
    }),
  ).toString('base64');

const impostazioni = { apple_auth_key: 'chiave', store_name: 'Pasticceria Golosone' };

test('senza configurazione non si rompe niente: si spegne e basta', () => {
  assert.equal(readConfig({}, impostazioni, 'https://x.dev'), null);
});

test('quando non si puo procedere viene detto il perche', () => {
  assert.match(readConfigDetailed({}, {}, 'https://x.dev').problema!, /certificato/i);
  assert.match(
    readConfigDetailed({ APPLE_WALLET_CERT: 'roba' }, impostazioni, 'https://x.dev').problema!,
    /non e leggibile/i,
  );
  assert.match(
    readConfigDetailed({ APPLE_WALLET_CERT: segreto() }, {}, 'https://x.dev').problema!,
    /token/i,
  );
});

/**
 * La forma vera del segreto: JSON semplice, con i pezzi gia' in base64 e
 * senza intestazioni. Non e' un vezzo di compattezza - un segreto di Worker
 * si ferma a 5,1 kB, e ricodificare in base64 un PEM (che base64 lo e' gia')
 * lo gonfia di un terzo, abbastanza da sforare.
 */
test('il segreto si legge nella forma compatta, senza intestazioni ne doppia codifica', () => {
  const nudo = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const compatto = JSON.stringify({
    passTypeId: 'pass.test.golosone',
    teamId: 'TEAM123456',
    cert: nudo(CERT_PROVA),
    key: nudo(CHIAVE_PROVA),
  });

  assert.ok(compatto.length < 5 * 1024, 'il pacchetto compatto deve stare sotto il tetto');

  const cfg = readConfig({ APPLE_WALLET_CERT: compatto }, impostazioni, 'https://x.dev');
  assert.equal(cfg?.passTypeId, 'pass.test.golosone');
  assert.ok(cfg?.wwdrPem.length, 'senza intermedio nel segreto deve valere quello del codice');
});

test('il pass si firma anche con l intermedio preso dal codice', async () => {
  const nudo = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const cfg = readConfig(
    {
      APPLE_WALLET_CERT: JSON.stringify({
        passTypeId: 'pass.test.golosone',
        teamId: 'TEAM123456',
        cert: nudo(CERT_PROVA),
        key: nudo(CHIAVE_PROVA),
      }),
    },
    impostazioni,
    'https://x.dev',
  );
  // niente wwdr nel segreto: se il ripiego non funzionasse, qui si romperebbe
  const file = leggiZip(await buildPkpass(cfg!, tessera, undefined));
  assert.ok(file.get('signature')!.length > 1000, 'la firma non contiene la catena');
});

test('il certificato si legge in base64, la forma in cui lo carica lo script', () => {
  const cfg = readConfig({ APPLE_WALLET_CERT: segreto() }, impostazioni, 'https://x.dev');
  assert.equal(cfg?.passTypeId, 'pass.test.golosone');
  assert.equal(cfg?.teamId, 'TEAM123456');
  assert.equal(cfg?.apns, null, 'senza chiave APNs il push deve restare spento');
});

test('il push si accende solo quando ci sono chiave e identificativo', () => {
  const cfg = readConfig(
    { APPLE_WALLET_CERT: segreto({ apnsKeyId: 'ABCDE12345', apnsKey: '-----BEGIN PRIVATE KEY-----' }) },
    impostazioni,
    'https://x.dev',
  );
  assert.equal(cfg?.apns?.keyId, 'ABCDE12345');

  const monco = readConfig(
    { APPLE_WALLET_CERT: segreto({ apnsKeyId: 'ABCDE12345' }) },
    impostazioni,
    'https://x.dev',
  );
  assert.equal(monco?.apns, null, 'mezza configurazione non deve accendere il push');
});

// ===================================================================== APNs

test('il token per APNs e firmato ES256 e la firma regge', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const jwt = await providerToken({ keyId: 'ABCDE12345', keyPem: privateKey, teamId: 'TEAM123456' });
  const [h, p, s] = jwt.split('.');

  const testata = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(testata, { alg: 'ES256', kid: 'ABCDE12345' });

  const corpo = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(corpo.iss, 'TEAM123456');
  assert.ok(typeof corpo.iat === 'number');

  // Web Crypto firma in forma r||s, che Node verifica dichiarando ieee-p1363
  const ok = verifySig(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey(publicKey), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  assert.ok(ok, 'la firma del token APNs non verifica');
});

// ======================================= le due strade, rimesse insieme

/**
 * Per qualche giorno il progetto e' andato avanti su due strade, e in giro
 * ci sono pass di tutte e due. Un pass non si puo' correggere dopo: indirizzo
 * e token ce li ha scritti dentro. Questi test proteggono i pass che i
 * clienti hanno gia' nel telefono.
 */
test('il servizio accetta anche il token dei pass emessi con la firma vecchia', async () => {
  const vecchio = { ...config, authSecretVecchio: 'segreto-vecchio' };
  const tokenVecchio = await sha256Hex('segreto-vecchio:K7H9M2PQ');

  assert.ok(await tokenValido(vecchio, 'K7H9M2PQ', await authToken(vecchio, 'K7H9M2PQ')));
  assert.ok(await tokenValido(vecchio, 'K7H9M2PQ', tokenVecchio), 'il pass vecchio deve restare aggiornabile');
  assert.equal(await tokenValido(vecchio, 'K7H9M2PR', tokenVecchio), false, 'il token vale per una tessera sola');
  assert.equal(await tokenValido(config, 'K7H9M2PQ', tokenVecchio), false, 'senza segreto vecchio non passa');
});

test('il servizio di aggiornamento risponde a tutti e due gli indirizzi', async () => {
  // /v1/log non tocca il database: basta a dire se la rotta esiste.
  for (const prefisso of ['/wallet-apple', '/api/apple/v1']) {
    const res = await app.request(`${prefisso}/v1/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: [] }),
    });
    assert.equal(res.status, 200, `${prefisso} non risponde`);
  }
});

test('la coppia certificato e chiave gia in produzione vince sul pacchetto', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const cfg = readConfig(
    {
      APPLE_PASS_CERT: b64(CERT_PROVA),
      APPLE_PASS_KEY: b64(CHIAVE_PROVA),
      APPLE_WALLET_CERT: segreto({ apnsKeyId: 'ABCDE12345', apnsKey: '-----BEGIN PRIVATE KEY-----' }),
    },
    { ...impostazioni, apple_pass_type_id: 'pass.dalla.coppia', apple_team_id: 'TEAMCOPPIA', apple_auth_secret: 'vecchio' },
    'https://x.dev',
  );
  assert.equal(cfg?.passTypeId, 'pass.dalla.coppia');
  assert.equal(cfg?.certPem, CERT_PROVA, 'il certificato deve arrivare crudo anche se caricato in base64');
  assert.equal(cfg?.apns?.keyId, 'ABCDE12345', 'la chiave del push arriva comunque dal pacchetto');
  assert.equal(cfg?.authSecretVecchio, 'vecchio');
});

test('la tessera Apple ha i colori e le parole di quella Google', async () => {
  const p = JSON.parse(await passJson(config, { ...tessera, nextReward: { name: 'Tortina', points_cost: 20 }, ciSonoPremi: true }));
  assert.equal(p.backgroundColor, 'rgb(190, 27, 69)');
  assert.equal(p.labelColor, 'rgb(242, 199, 92)');
  assert.equal(p.logoText, undefined, 'il nome sta gia nel logo');
  assert.equal(p.storeCard.secondaryFields[0].label, 'Tessera di');

  const tutti = JSON.parse(await passJson(config, { ...tessera, nextReward: null, ciSonoPremi: true }));
  assert.equal(tutti.storeCard.auxiliaryFields[0].value, 'Hai un premio da ritirare al banco');
});
