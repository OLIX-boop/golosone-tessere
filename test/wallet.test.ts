import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signJwt, saveLink, classId, objectId, logoUri, logoVersion, readConfig, readConfigDetailed, type WalletConfig } from '../src/google-wallet.ts';

/**
 * Senza credenziali Google non si puo' provare il giro fino al telefono, ma la
 * parte che puo' davvero sbagliarsi in silenzio - la firma - si verifica qui:
 * si genera una coppia di chiavi, si firma, e si ricontrolla la firma con la
 * chiave pubblica. Se il JWT fosse malformato Google risponderebbe solo con un
 * 400 generico, quindi e' bene accorgersene prima.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const sa = { client_email: 'tessere@pasticceria.iam.gserviceaccount.com', private_key: privateKey };

const config: WalletConfig = {
  sa,
  issuerId: '3388000000012345678',
  classSuffix: 'tessera_punti',
  storeName: 'Pasticceria Golosone',
  origin: 'https://tessere.pasticceria.workers.dev',
};

function decodePart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function verify(jwt: string): Promise<boolean> {
  const [h, p, s] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'spki',
    Buffer.from(
      publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
      'base64',
    ),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
}

test('il JWT e firmato davvero e la firma regge alla verifica', async () => {
  const jwt = await signJwt(sa, { iss: sa.client_email, aud: 'google' });
  assert.equal(jwt.split('.').length, 3);
  assert.deepEqual(decodePart(jwt.split('.')[0]), { alg: 'RS256', typ: 'JWT' });
  assert.ok(await verify(jwt), 'la firma non verifica');
});

test('una firma manomessa viene respinta', async () => {
  const jwt = await signJwt(sa, { iss: sa.client_email, punti: 5 });
  const [h, p, s] = jwt.split('.');
  // stesso header e stessa firma, ma payload cambiato: deve fallire
  const falso = `${h}.${Buffer.from(JSON.stringify({ iss: sa.client_email, punti: 9999 }))
    .toString('base64url')}.${s}`;
  assert.equal(await verify(falso), false);
});

test('il base64url non contiene caratteri da scappare nell URL', async () => {
  // se ci finissero + / = il link si romperebbe a meta' strada
  const jwt = await signJwt(sa, { iss: sa.client_email, nota: 'Caffè però +/= test' });
  assert.ok(!/[+/=]/.test(jwt), `il JWT contiene caratteri non URL-safe: ${jwt.slice(0, 40)}`);
});

test('gli accenti sopravvivono alla codifica', async () => {
  const jwt = await signJwt(sa, { negozio: 'Pasticceria Così è' });
  assert.equal(decodePart(jwt.split('.')[1]).negozio, 'Pasticceria Così è');
});

test('il link di salvataggio ha la forma che Google si aspetta', async () => {
  const link = await saveLink(config, 'MMPRKQ46');
  assert.ok(link.startsWith('https://pay.google.com/gp/v/save/'));

  const jwt = link.slice('https://pay.google.com/gp/v/save/'.length);
  const claims = decodePart(jwt.split('.')[1]) as any;
  assert.equal(claims.aud, 'google');
  assert.equal(claims.typ, 'savetowallet');
  assert.equal(claims.iss, sa.client_email);
  assert.deepEqual(claims.origins, [config.origin]);
  assert.ok(await verify(jwt));
});

test('nel link va il riferimento all oggetto, non l oggetto intero', async () => {
  // i JWT non sono cifrati e l'URL ha un tetto pratico di 2000 caratteri
  const link = await saveLink(config, 'MMPRKQ46');
  const claims = decodePart(link.split('/save/')[1].split('.')[1]) as any;
  assert.deepEqual(Object.keys(claims.payload.loyaltyObjects[0]), ['id']);
  assert.ok(link.length < 2000, `link troppo lungo: ${link.length} caratteri`);
});

test('gli id di classe e oggetto rispettano il formato di Google', () => {
  assert.equal(classId(config), '3388000000012345678.tessera_punti');
  assert.equal(objectId(config, 'MMPRKQ46'), '3388000000012345678.tessera_punti_MMPRKQ46');
  // Google accetta solo alfanumerici, punto, trattino e underscore
  assert.match(objectId(config, 'MMPRKQ46'), /^[A-Za-z0-9._-]+$/);
});

test('la chiave si legge anche in base64, la forma consigliata', () => {
  // il JSON di Google ha una PEM multiriga: in una variabile d'ambiente le
  // virgolette si scappano e gli a capo si rovinano. Il base64 no.
  const s = { store_name: 'X', wallet_issuer_id: '123' };
  const b64 = Buffer.from(JSON.stringify(sa)).toString('base64');
  const cfg = readConfig({ GOOGLE_WALLET_SA: b64 }, s, 'https://x.dev');
  assert.ok(cfg, 'il base64 doveva essere accettato');
  assert.equal(cfg!.sa.client_email, sa.client_email);
  assert.ok(cfg!.sa.private_key.includes('BEGIN PRIVATE KEY'));
});

test('gli a capo arrivati come backslash-n letterali vengono rimessi a posto', async () => {
  // e' come Google consegna la chiave dentro il JSON, e come sopravvive a
  // molti passaggi di copia-incolla
  const rovinata = JSON.stringify({
    client_email: sa.client_email,
    private_key: sa.private_key.replace(/\n/g, '\\n'),
  });
  const cfg = readConfig(
    { GOOGLE_WALLET_SA: rovinata }, { wallet_issuer_id: '123' }, 'https://x.dev');
  assert.ok(cfg, 'la chiave con a capo letterali doveva essere recuperata');
  // la prova vera: con quella chiave si riesce a firmare
  const jwt = await signJwt(cfg!.sa, { iss: 'x' });
  assert.ok(await verify(jwt), 'la chiave recuperata non firma');
});

test('quando non si puo procedere viene detto il perche', () => {
  const b = (env: any, set: any) => readConfigDetailed(env, set, 'https://x.dev').problema;
  assert.match(b({}, {}) ?? '', /Manca tutto/);
  assert.match(b({}, { wallet_issuer_id: '1' }) ?? '', /chiave/);
  assert.match(b({ GOOGLE_WALLET_SA: JSON.stringify(sa) }, {}) ?? '', /emittente/);
  assert.match(b({ GOOGLE_WALLET_SA: 'spazzatura{{' }, { wallet_issuer_id: '1' }) ?? '', /non e leggibile/);
  // configurazione buona: nessun problema da segnalare
  assert.equal(b({ GOOGLE_WALLET_SA: JSON.stringify(sa) }, { wallet_issuer_id: '1' }), null);
});

test('senza configurazione non si rompe niente: si spegne e basta', () => {
  const s = { store_name: 'Pasticceria', wallet_issuer_id: '123' };
  assert.equal(readConfig({}, s, 'https://x.dev'), null, 'manca il segreto');
  assert.equal(readConfig({ GOOGLE_WALLET_SA: '{}' }, s, 'https://x.dev'), null, 'segreto incompleto');
  assert.equal(
    readConfig({ GOOGLE_WALLET_SA: 'non-json{{' }, s, 'https://x.dev'),
    null,
    'segreto malformato deve dare null, non un eccezione',
  );
  assert.equal(
    readConfig({ GOOGLE_WALLET_SA: JSON.stringify(sa) }, { store_name: 'X' }, 'https://x.dev'),
    null,
    'manca issuer id',
  );
  assert.ok(readConfig({ GOOGLE_WALLET_SA: JSON.stringify(sa) }, s, 'https://x.dev'));
});

/**
 * Google copia il logo quando crea la classe e poi non lo riguarda piu'.
 * Sostituire il file lasciava le tessere col logo vecchio, perche' il
 * riallineamento confronta gli INDIRIZZI e quello non era cambiato. Legandolo
 * al contenuto, cambiare l'immagine cambia anche l'indirizzo.
 */
test('l indirizzo del logo porta l impronta del contenuto', () => {
  assert.equal(logoUri(config), `${config.origin}/logo.png`);
  assert.equal(
    logoUri({ ...config, logoVersion: 'a1b2c3d4' }),
    `${config.origin}/logo.png?v=a1b2c3d4`,
  );
});

test('due logo diversi danno impronte diverse, lo stesso logo la stessa', async () => {
  const finti = (byte: number[]) =>
    ({ fetch: async () => new Response(new Uint8Array(byte)) }) as any;

  const a = await logoVersion(finti([1, 2, 3, 4]), 'https://x.dev');
  const b = await logoVersion(finti([1, 2, 3, 4]), 'https://x.dev');
  const c = await logoVersion(finti([9, 9, 9, 9]), 'https://x.dev');

  assert.equal(a, b, 'lo stesso logo deve dare sempre la stessa impronta');
  assert.notEqual(a, c);
  assert.match(a!, /^[0-9a-f]{8}$/);
});

test('senza asset o con logo mancante si prosegue senza versione', async () => {
  assert.equal(await logoVersion(undefined, 'https://x.dev'), undefined);
  const rotto = { fetch: async () => new Response('', { status: 404 }) } as any;
  assert.equal(await logoVersion(rotto, 'https://x.dev'), undefined);
});
