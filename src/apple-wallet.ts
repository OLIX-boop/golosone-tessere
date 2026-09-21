/**
 * Apple Wallet: costruzione e firma del .pkpass.
 *
 * Un .pkpass e' uno ZIP con dentro:
 *   - pass.json      la tessera (campi, colori, codice a barre)
 *   - le immagini    icon obbligatoria, logo consigliato
 *   - manifest.json  lo SHA-1 di ogni file
 *   - signature      firma CMS STACCATA del manifest
 *
 * iOS rifiuta il pass in silenzio se uno solo di questi pezzi non torna:
 * niente messaggi, niente log, semplicemente non si apre. Per questo il test
 * ricostruisce lo zip e ricontrolla gli hash uno per uno.
 *
 * A differenza di Google, qui il pass NON si aggiorna da solo: perche' cambi
 * serve il servizio web di PassKit. `webServiceURL` e `authenticationToken`
 * sono pero' dentro il pass fin da adesso, perche' un pass scaricato senza
 * quei campi non potra' MAI essere aggiornato, nemmeno costruendo il servizio
 * dopo: andrebbe riscaricato da ogni cliente.
 */
import * as pkijs from 'pkijs';
import { IMMAGINI_PASS } from './pass-immagini.ts';

export type AppleConfig = {
  /** PEM del certificato Pass Type ID rilasciato da Apple */
  certPem: string;
  /** PEM della chiave privata che ha generato la richiesta */
  keyPem: string;
  /** PEM del certificato intermedio Apple WWDR */
  wwdrPem: string;
  passTypeId: string;
  teamId: string;
  storeName: string;
  origin: string;
};

export type DatiTessera = {
  code: string;
  firstName: string | null;
  points: number;
  prossimo?: { nome: string; mancano: number } | null;
};

// ------------------------------------------------------------------ utilita'

const enc = new TextEncoder();

function pemToDer(pem: string, tipo: string): Uint8Array {
  const m = pem.match(new RegExp(`-----BEGIN ${tipo}-----([\\s\\S]*?)-----END ${tipo}-----`));
  if (!m) throw new Error(`Nel PEM manca un blocco ${tipo}`);
  const raw = atob(m[1].replace(/\s+/g, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha1Hex(dati: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', dati as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------- ZIP

/**
 * ZIP senza compressione (metodo "stored").
 *
 * Comprimere farebbe risparmiare qualche kilobyte su file che sono gia' PNG
 * compressi, in cambio di un deflate da implementare e da sbagliare. iOS
 * accetta lo stored senza storcere il naso.
 */
const CRC_TAVOLA = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(dati: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < dati.length; i++) c = CRC_TAVOLA[(c ^ dati[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function creaZip(voci: { nome: string; dati: Uint8Array }[]): Uint8Array {
  const pezzi: Uint8Array[] = [];
  const centrale: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const unisci = (parti: Uint8Array[]) => {
    const tot = parti.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(tot);
    let i = 0;
    for (const p of parti) { out.set(p, i); i += p.length; }
    return out;
  };

  for (const { nome, dati } of voci) {
    const nomeBytes = enc.encode(nome);
    const crc = crc32(dati);

    const locale = unisci([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(dati.length), u32(dati.length),
      u16(nomeBytes.length), u16(0), nomeBytes, dati,
    ]);
    pezzi.push(locale);

    centrale.push(unisci([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(dati.length), u32(dati.length),
      u16(nomeBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nomeBytes,
    ]));
    offset += locale.length;
  }

  const dirCentrale = unisci(centrale);
  const fine = unisci([
    u32(0x06054b50), u16(0), u16(0), u16(voci.length), u16(voci.length),
    u32(dirCentrale.length), u32(offset), u16(0),
  ]);
  return unisci([...pezzi, dirCentrale, fine]);
}

// ------------------------------------------------------------------- firma

/**
 * Firma CMS staccata del manifest.
 *
 * "Staccata" vuol dire che il contenuto firmato non e' dentro la firma: iOS
 * rilegge manifest.json dallo zip e verifica che corrisponda. La catena deve
 * includere l'intermedio WWDR, altrimenti iOS non risale ad Apple e scarta il
 * pass.
 */
export async function firmaManifest(c: AppleConfig, manifest: Uint8Array): Promise<Uint8Array> {
  const cert = pkijs.Certificate.fromBER(pemToDer(c.certPem, 'CERTIFICATE'));
  const wwdr = pkijs.Certificate.fromBER(pemToDer(c.wwdrPem, 'CERTIFICATE'));

  const chiave = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(c.keyPem, 'PRIVATE KEY') as unknown as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const firmato = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.7.1', // data
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: cert.issuer,
          serialNumber: cert.serialNumber,
        }),
      }),
    ],
    certificates: [cert, wwdr],
  });

  await firmato.sign(chiave, 0, 'SHA-256', manifest as unknown as ArrayBuffer);

  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2', // signedData
    content: firmato.toSchema(true),
  });
  return new Uint8Array(cms.toSchema().toBER(false));
}

// -------------------------------------------------------------- pass.json

export function costruisciPassJson(c: AppleConfig, t: DatiTessera, authToken: string) {
  const urlCliente = `${c.origin}/c/${t.code}`;

  const ausiliari = t.prossimo
    ? [{
        key: 'prossimo',
        label: 'PROSSIMO PREMIO',
        value: `${t.prossimo.mancano} ${t.prossimo.mancano === 1 ? 'punto' : 'punti'} a ${t.prossimo.nome}`,
      }]
    : [];

  return {
    formatVersion: 1,
    passTypeIdentifier: c.passTypeId,
    teamIdentifier: c.teamId,
    serialNumber: t.code,
    organizationName: c.storeName,
    description: `Tessera punti ${c.storeName}`,
    logoText: c.storeName,

    backgroundColor: 'rgb(140, 74, 47)',
    foregroundColor: 'rgb(244, 241, 236)',
    labelColor: 'rgb(226, 208, 196)',

    // Presenti fin dal primo pass: aggiungerli dopo non servirebbe a niente,
    // perche' i pass gia' scaricati resterebbero senza.
    webServiceURL: `${c.origin}/api/apple/v1`,
    authenticationToken: authToken,

    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: urlCliente,
      // iso-8859-1 e' quella che i lettori si aspettano: l'URL e' comunque
      // tutto ASCII, quindi non si perde niente.
      messageEncoding: 'iso-8859-1',
      altText: t.code,
    }],

    storeCard: {
      primaryFields: [{ key: 'punti', label: 'PUNTI', value: t.points }],
      secondaryFields: [{ key: 'nome', label: 'INTESTATARIO', value: t.firstName ?? 'Cliente' }],
      auxiliaryFields: ausiliari,
      backFields: [
        { key: 'codice', label: 'Codice tessera', value: t.code },
        {
          key: 'saldo',
          label: 'Il tuo saldo aggiornato',
          value: urlCliente,
          attributedValue: `<a href="${urlCliente}">Apri la tua pagina</a>`,
        },
        {
          key: 'uso',
          label: 'Come si usa',
          value: 'Mostra il codice in cassa: vale come la tessera di cartoncino.',
        },
      ],
    },
  };
}

// ---------------------------------------------------------- pacchetto finale

export async function creaPkpass(
  c: AppleConfig,
  t: DatiTessera,
  authToken: string,
): Promise<Uint8Array> {
  const file: { nome: string; dati: Uint8Array }[] = [];

  const passJson = enc.encode(JSON.stringify(costruisciPassJson(c, t, authToken)));
  file.push({ nome: 'pass.json', dati: passJson });

  for (const [nome, b64] of Object.entries(IMMAGINI_PASS)) {
    file.push({ nome, dati: b64ToBytes(b64) });
  }

  // Il manifest elenca lo SHA-1 di TUTTI i file tranne se stesso e la firma.
  const manifest: Record<string, string> = {};
  for (const f of file) manifest[f.nome] = await sha1Hex(f.dati);
  const manifestBytes = enc.encode(JSON.stringify(manifest));

  const firma = await firmaManifest(c, manifestBytes);

  return creaZip([
    ...file,
    { nome: 'manifest.json', dati: manifestBytes },
    { nome: 'signature', dati: firma },
  ]);
}

// ------------------------------------------------------------ configurazione

export type EsitoApple = { config: AppleConfig | null; problema: string | null };

/**
 * Legge la configurazione Apple dai segreti del Worker.
 *
 * Certificato e chiave arrivano in base64: sono PEM multiriga, e passarli
 * crudi a una variabile d'ambiente e' il modo piu' rapido per rovinarli.
 */
export function leggiConfigApple(
  env: { APPLE_PASS_CERT?: string; APPLE_PASS_KEY?: string; APPLE_WWDR_CERT?: string },
  settings: Record<string, string>,
  origin: string,
): EsitoApple {
  const forse = (v: string | undefined) => {
    if (!v) return null;
    const grezzo = v.includes('-----BEGIN') ? v : (() => { try { return atob(v.replace(/\s+/g, '')); } catch { return ''; } })();
    return grezzo.includes('-----BEGIN') ? grezzo : null;
  };

  const certPem = forse(env.APPLE_PASS_CERT);
  const keyPem = forse(env.APPLE_PASS_KEY);
  const wwdrPem = forse(env.APPLE_WWDR_CERT);
  const passTypeId = settings.apple_pass_type_id;
  const teamId = settings.apple_team_id;

  const mancanti: string[] = [];
  if (!certPem) mancanti.push('certificato (APPLE_PASS_CERT)');
  if (!keyPem) mancanti.push('chiave privata (APPLE_PASS_KEY)');
  if (!wwdrPem) mancanti.push('intermedio Apple (APPLE_WWDR_CERT)');
  if (!passTypeId) mancanti.push('Pass Type ID');
  if (!teamId) mancanti.push('Team ID');

  if (mancanti.length) {
    return { config: null, problema: `Manca: ${mancanti.join(', ')}.` };
  }

  return {
    config: {
      certPem: certPem!,
      keyPem: keyPem!,
      wwdrPem: wwdrPem!,
      passTypeId: passTypeId!,
      teamId: teamId!,
      storeName: settings.store_name ?? 'Pasticceria',
      origin,
    },
    problema: null,
  };
}
