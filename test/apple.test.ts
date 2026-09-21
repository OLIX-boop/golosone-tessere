import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creaPkpass, creaZip, firmaManifest, costruisciPassJson, leggiConfigApple, type AppleConfig } from '../src/apple-wallet.ts';

/**
 * iOS rifiuta un .pkpass difettoso IN SILENZIO: nessun messaggio, nessun log,
 * la tessera semplicemente non si apre. Quindi qui non si guarda se il file
 * "sembra" giusto: lo zip viene riaperto da Python, gli hash del manifest
 * ricalcolati uno per uno, e la firma data in pasto a openssl.
 */
let dir: string;
let config: AppleConfig;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pkpass-'));

  // Un certificato finto, ma con la stessa forma di quello Apple: quello vero
  // non puo' stare in un test.
  const fai = (nomeChiave: string, nomeCert: string, cn: string) =>
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
      '-keyout', join(dir, nomeChiave), '-out', join(dir, nomeCert),
      '-subj', `/CN=${cn}/O=Prova`,
    ], { stdio: 'pipe' });

  fai('key.pem', 'cert.pem', 'Pass Type ID prova');
  fai('wwdr-key.pem', 'wwdr.pem', 'Intermedio prova');

  config = {
    certPem: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    keyPem: readFileSync(join(dir, 'key.pem'), 'utf8'),
    wwdrPem: readFileSync(join(dir, 'wwdr.pem'), 'utf8'),
    passTypeId: 'pass.com.ilgolosone.tessera',
    teamId: 'ABCDE12345',
    storeName: 'Il Golosone',
    origin: 'https://tessere.example.dev',
  };
});

after(() => rmSync(dir, { recursive: true, force: true }));

const tessera = {
  code: 'Y8TRMJAM',
  firstName: 'Andrea',
  points: 12,
  prossimo: { nome: 'Tortina', mancano: 8 },
};

/** Riapre lo zip con Python: se la struttura o un CRC sono sbagliati, protesta. */
function apriZip(percorso: string): Record<string, string> {
  const out = execFileSync('python', ['-c', `
import zipfile, json, hashlib, sys
z = zipfile.ZipFile(r'${percorso}')
danno = z.testzip()
if danno: raise SystemExit('CRC rotto: ' + danno)
print(json.dumps({n: hashlib.sha1(z.read(n)).hexdigest() for n in z.namelist()}))
`], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('lo zip prodotto e apribile e i CRC tornano', async () => {
  const pkpass = await creaPkpass(config, tessera, 'token-di-prova');
  const percorso = join(dir, 'prova.pkpass');
  writeFileSync(percorso, pkpass);

  const dentro = apriZip(percorso);
  for (const atteso of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'logo.png']) {
    assert.ok(atteso in dentro, `manca ${atteso} dentro il pass`);
  }
});

test('il manifest dichiara gli hash VERI dei file', async () => {
  const pkpass = await creaPkpass(config, tessera, 'token-di-prova');
  const percorso = join(dir, 'hash.pkpass');
  writeFileSync(percorso, pkpass);

  const reali = apriZip(percorso);
  const manifest = JSON.parse(
    execFileSync('python', ['-c',
      `import zipfile;print(zipfile.ZipFile(r'${percorso}').read('manifest.json').decode())`,
    ], { encoding: 'utf8' }),
  ) as Record<string, string>;

  // Un solo hash sbagliato e iOS scarta tutto senza spiegazioni.
  for (const [nome, hash] of Object.entries(manifest)) {
    assert.equal(hash, reali[nome], `hash diverso per ${nome}`);
  }
  assert.ok(!('manifest.json' in manifest), 'il manifest non deve elencare se stesso');
  assert.ok(!('signature' in manifest), 'il manifest non deve elencare la firma');
  assert.ok(Object.keys(manifest).length >= 4);
});

test('la firma e valida e staccata: openssl la verifica sul manifest', async () => {
  const manifest = new TextEncoder().encode(JSON.stringify({ 'pass.json': 'abc' }));
  const firma = await firmaManifest(config, manifest);

  writeFileSync(join(dir, 'manifest.bin'), manifest);
  writeFileSync(join(dir, 'firma.der'), firma);

  const esito = execFileSync('openssl', [
    'smime', '-verify', '-binary', '-inform', 'DER',
    '-in', join(dir, 'firma.der'),
    '-content', join(dir, 'manifest.bin'),
    '-noverify', '-out', join(dir, 'scarto.bin'),
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  void esito; // se la firma non valesse, execFileSync avrebbe gia' lanciato
});

test('un manifest manomesso fa fallire la verifica', async () => {
  const manifest = new TextEncoder().encode(JSON.stringify({ 'pass.json': 'abc' }));
  const firma = await firmaManifest(config, manifest);

  writeFileSync(join(dir, 'firma2.der'), firma);
  // stessa firma, contenuto cambiato: deve rifiutare
  writeFileSync(join(dir, 'manomesso.bin'), new TextEncoder().encode(JSON.stringify({ 'pass.json': 'xyz' })));

  assert.throws(() =>
    execFileSync('openssl', [
      'smime', '-verify', '-binary', '-inform', 'DER',
      '-in', join(dir, 'firma2.der'),
      '-content', join(dir, 'manomesso.bin'),
      '-noverify', '-out', join(dir, 'scarto2.bin'),
    ], { stdio: 'pipe' }),
  );
});

test('la catena include l intermedio WWDR', async () => {
  const manifest = new TextEncoder().encode('x');
  const firma = await firmaManifest(config, manifest);
  writeFileSync(join(dir, 'catena.der'), firma);

  const certs = execFileSync('openssl', [
    'pkcs7', '-inform', 'DER', '-in', join(dir, 'catena.der'), '-print_certs', '-noout',
  ], { encoding: 'utf8' });

  // Senza l'intermedio iOS non risale ad Apple e scarta il pass
  assert.match(certs, /Pass Type ID prova/);
  assert.match(certs, /Intermedio prova/);
});

test('pass.json ha i campi che Apple pretende', () => {
  const p = costruisciPassJson(config, tessera, 'token-xyz') as any;
  assert.equal(p.formatVersion, 1);
  assert.equal(p.passTypeIdentifier, config.passTypeId);
  assert.equal(p.teamIdentifier, config.teamId);
  assert.equal(p.serialNumber, tessera.code);
  assert.ok(p.organizationName && p.description);

  assert.equal(p.barcodes[0].format, 'PKBarcodeFormatQR');
  assert.equal(p.barcodes[0].message, `${config.origin}/c/${tessera.code}`, 'il QR deve portare alla pagina cliente');
  assert.equal(p.barcodes[0].altText, tessera.code);

  assert.equal(p.storeCard.primaryFields[0].value, 12);
  assert.match(p.storeCard.auxiliaryFields[0].value, /8 punti a Tortina/);
});

test('webServiceURL c e fin dal primo pass', () => {
  // Un pass scaricato senza questi campi non potra' MAI essere aggiornato,
  // nemmeno costruendo il servizio dopo: andrebbe riscaricato da ogni cliente.
  const p = costruisciPassJson(config, tessera, 'token-xyz') as any;
  assert.ok(p.webServiceURL?.startsWith('https://'), 'serve un indirizzo https');
  assert.equal(p.authenticationToken, 'token-xyz');
});

test('lo zip regge nomi e contenuti che si ripetono', () => {
  const uno = creaZip([{ nome: 'a.txt', dati: new TextEncoder().encode('ciao') }]);
  const due = creaZip([
    { nome: 'a.txt', dati: new TextEncoder().encode('ciao') },
    { nome: 'b.txt', dati: new TextEncoder().encode('ciao') },
  ]);
  assert.ok(due.length > uno.length);
  // firma dello zip: PK\x03\x04
  assert.deepEqual([...uno.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

test('senza configurazione dice cosa manca invece di tacere', () => {
  const s = { store_name: 'X' };
  const vuoto = leggiConfigApple({}, s, 'https://x.dev');
  assert.equal(vuoto.config, null);
  assert.match(vuoto.problema!, /certificato/);
  assert.match(vuoto.problema!, /Team ID/);

  const pieno = leggiConfigApple(
    {
      APPLE_PASS_CERT: config.certPem,
      APPLE_PASS_KEY: config.keyPem,
      APPLE_WWDR_CERT: config.wwdrPem,
    },
    { ...s, apple_pass_type_id: 'pass.x', apple_team_id: 'T1' },
    'https://x.dev',
  );
  assert.equal(pieno.problema, null);
  assert.ok(pieno.config);
});

test('i PEM si accettano anche in base64', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const esito = leggiConfigApple(
    {
      APPLE_PASS_CERT: b64(config.certPem),
      APPLE_PASS_KEY: b64(config.keyPem),
      APPLE_WWDR_CERT: b64(config.wwdrPem),
    },
    { apple_pass_type_id: 'pass.x', apple_team_id: 'T1' },
    'https://x.dev',
  );
  assert.equal(esito.problema, null);
  assert.ok(esito.config!.certPem.includes('-----BEGIN CERTIFICATE-----'));
});
