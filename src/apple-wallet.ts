/**
 * Apple Wallet: la tessera nel telefono per chi ha un iPhone.
 *
 * Fino a ieri qui non c'era codice, e il README spiegava perche': senza
 * account sviluppatore un pass si puo' solo creare a mano dal telefono, e
 * resta congelato. Con l'account, il pass diventa un file che firmiamo noi e
 * che si aggiorna da solo, esattamente come quello di Google.
 *
 * Com'e' fatto un .pkpass:
 *   * `pass.json` - i dati della tessera;
 *   * le immagini - `icon.png` e' obbligatoria, senza iOS non apre niente;
 *   * `manifest.json` - l'impronta SHA-1 di ogni altro file;
 *   * `signature` - la firma CMS del manifesto (vedi pkcs7.ts).
 * Il tutto dentro un archivio ZIP (vedi zip.ts).
 *
 * L'impronta e' SHA-1 perche' lo impone il formato, non per scelta: serve a
 * legare i file al manifesto, e cio' che protegge davvero l'archivio e' la
 * firma del manifesto, che invece e' SHA-256.
 *
 * Come per Google, tutto degrada in silenzio: se manca la configurazione il
 * pulsante non compare e la cassa non se ne accorge.
 */

import { signDetached, type SignMaterial } from './pkcs7.ts';
import { WWDR_G4 } from './apple-wwdr.ts';
import { zip, type ZipEntry } from './zip.ts';

const enc = new TextEncoder();

export type AppleConfig = SignMaterial & {
  /** identificativo registrato presso Apple, es. pass.it.pasticceria.tessere */
  passTypeId: string;
  teamId: string;
  /** chiave APNs (.p8) per il push: se manca, i pass restano aggiornabili a mano */
  apns: { keyId: string; keyPem: string } | null;
  storeName: string;
  origin: string;
  /** segreto da cui si derivano i token di autenticazione dei pass */
  authKey: string;
};

/** Il dispositivo chiama gli endpoint sotto questo prefisso. */
export const WEB_SERVICE_PATH = '/wallet-apple';

// ------------------------------------------------------------------ impronte

async function sha1Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', data.buffer as ArrayBuffer));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Token di autenticazione del pass.
 *
 * E' il segreto che il telefono rimanda a ogni richiesta di aggiornamento.
 * Si deriva dal codice tessera invece di essere salvato riga per riga: un
 * campo in meno da tenere allineato, e il token si ricalcola sempre uguale.
 *
 * Si deriva da una chiave a se' (`apple_auth_key`) e NON dal certificato:
 * i certificati Apple scadono dopo un anno, e legare i token al certificato
 * significherebbe che al primo rinnovo tutti i pass gia' consegnati
 * smetterebbero di aggiornarsi.
 */
export const authToken = (c: AppleConfig, code: string) => hmacHex(c.authKey, `pass:${code}`);

// ----------------------------------------------------------------- pass.json

export type CardData = {
  code: string;
  firstName: string | null;
  points: number;
  /** premio piu' vicino ancora da raggiungere, se si vuole mostrarlo */
  nextReward?: { name: string; points_cost: number } | null;
};

export async function passJson(c: AppleConfig, card: CardData): Promise<string> {
  const url = `${c.origin}/c/${card.code}`;
  const mancano = card.nextReward ? card.nextReward.points_cost - card.points : 0;

  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: c.passTypeId,
    teamIdentifier: c.teamId,
    organizationName: c.storeName,
    // description non e' decorativa: la leggono le tecnologie di accessibilita'
    description: `Tessera punti ${c.storeName}`,
    serialNumber: card.code,

    // Niente logoText: il nome del negozio e' gia' dentro il logo, e ripeterlo
    // accanto lo raddoppia sulla stessa riga.
    //
    // I colori escono dal logo, non da un gusto: l'inchiostro e' il prugna
    // scuro del file (#56343c), la carta e' un bianco caldo. Stanno scritti
    // anche in scripts/genera-grafica.mjs, che disegna la striscia: se cambi
    // qui, cambia anche li' e rilancia `npm run grafica`, altrimenti la fascia
    // resta del colore vecchio e si vede.
    backgroundColor: 'rgb(251, 247, 244)',
    foregroundColor: 'rgb(86, 52, 60)',
    labelColor: 'rgb(140, 106, 114)',

    // Senza queste due chiavi il pass nasce congelato e non c'e' modo di
    // aggiungerle dopo: i pass gia' nel telefono resterebbero fermi per
    // sempre. Vanno messe fin dal primo pass emesso.
    webServiceURL: `${c.origin}${WEB_SERVICE_PATH}`,
    authenticationToken: await authToken(c, card.code),

    storeCard: {
      primaryFields: [{ key: 'punti', label: 'Punti', value: card.points }],
      secondaryFields: [
        { key: 'intestatario', label: 'Tessera di', value: card.firstName ?? 'Cliente' },
      ],
      auxiliaryFields: card.nextReward
        ? [{
            key: 'traguardo',
            label: 'Prossimo premio',
            // "fra" e non "al": l'articolo dipende dal genere del premio, che
            // il titolare puo' cambiare quando vuole dal pannello.
            value: mancano > 0 ? `${card.nextReward.name} fra ${mancano} punti` : card.nextReward.name,
          }]
        : [],
      backFields: [
        { key: 'codice', label: 'Codice tessera', value: card.code },
        { key: 'pagina', label: 'La tua pagina', value: url },
        {
          key: 'nota',
          label: 'Come funziona',
          value: 'Mostra il codice in cassa. I punti si aggiornano da soli.',
        },
      ],
    },

    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: url,
      // iso-8859-1 e' l'unica codifica che iOS accetta qui
      messageEncoding: 'iso-8859-1',
      altText: card.code,
    }],
  };

  return JSON.stringify(pass, null, 2);
}

// -------------------------------------------------------------------- pkpass

/**
 * Le immagini del pass stanno in `public/pass/`, gia' con i nomi che Apple si
 * aspetta: qui si copiano dentro l'archivio senza rinominare niente.
 *
 * Sono in `public/` perche' le serve la CDN, ma al pass non basta che siano
 * raggiungibili: ne servono i BYTE, da mettere nello ZIP. Leggerli dal binding
 * degli asset evita di uscire in rete verso noi stessi.
 *
 * Tre densita' per immagine perche' gli iPhone sono tutti a 3x: mandare solo
 * la versione piccola significa mandare un'immagine sfocata.
 *
 * `icon.png` e' l'unica obbligatoria: senza, iOS rifiuta il pass e non dice
 * perche'. Le altre, se mancano, lasciano solo una tessera piu' spoglia,
 * quindi si prosegue lo stesso.
 *
 * La STRISCIA e' quella che fa la differenza fra una tessera e un rettangolo
 * di colore piatto: e' la fascia dietro il numero dei punti.
 */
/**
 * A sinistra il nome dentro il pass, a destra quello del file salvato.
 *
 * Non coincidono per un motivo preciso: Apple pretende `@2x` e `@3x`, ma la
 * CDN di Cloudflare non serve una chiocciola cosi' com'e', risponde 307 e
 * rimanda alla versione con `%40`. Qui un 307 non e' `ok`, quindi l'immagine
 * verrebbe scartata in silenzio - e un pass senza `icon.png` iOS lo rifiuta
 * senza dire perche'.
 *
 * Si potrebbe codificare la chiocciola nella richiesta, ma e' piu' solido non
 * averla affatto nei nomi dei file: la traduzione avviene qui, una volta, in
 * un punto che si legge.
 *
 * In locale il problema non si vede: e' una differenza fra il runtime di
 * sviluppo e la CDN vera.
 */
const IMMAGINI_PASS: [nelPass: string, file: string][] = [
  ['icon.png', 'icon-1x.png'], ['icon@2x.png', 'icon-2x.png'], ['icon@3x.png', 'icon-3x.png'],
  ['logo.png', 'logo-1x.png'], ['logo@2x.png', 'logo-2x.png'], ['logo@3x.png', 'logo-3x.png'],
  ['strip.png', 'strip-1x.png'], ['strip@2x.png', 'strip-2x.png'], ['strip@3x.png', 'strip-3x.png'],
];

async function immagini(assets: Fetcher | undefined, origin: string): Promise<ZipEntry[]> {
  if (!assets) return [];

  const leggi = async ([nelPass, file]: [string, string]): Promise<ZipEntry | null> => {
    try {
      const res = await assets.fetch(`${origin}/pass/${file}`);
      if (!res.ok) return null;
      return { name: nelPass, data: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      return null;
    }
  };

  // in parallelo: sono nove richieste, e in fila allungherebbero ogni pass
  const lette = await Promise.all(IMMAGINI_PASS.map(leggi));
  return lette.filter((x): x is ZipEntry => x !== null);
}

/** Costruisce e firma il .pkpass. Restituisce i byte pronti da servire. */
export async function buildPkpass(
  c: AppleConfig,
  card: CardData,
  assets?: Fetcher,
): Promise<Uint8Array> {
  const files: ZipEntry[] = [
    { name: 'pass.json', data: enc.encode(await passJson(c, card)) },
    ...(await immagini(assets, c.origin)),
  ];

  // Il manifesto elenca l'impronta di ogni file, tranne se stesso e la firma.
  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.name] = await sha1Hex(f.data);
  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));

  const signature = await signDetached(c, manifestBytes);

  return zip([
    ...files,
    { name: 'manifest.json', data: manifestBytes },
    { name: 'signature', data: signature },
  ]);
}

// ------------------------------------------------------------ configurazione

export type ConfigEsito = { config: AppleConfig | null; problema: string | null };

type SecretShape = {
  passTypeId?: string;
  teamId?: string;
  cert?: string;
  key?: string;
  wwdr?: string;
  apnsKeyId?: string;
  apnsKey?: string;
};

/**
 * Il segreto e' un JSON con dentro i pezzi gia' in base64, senza le
 * intestazioni `-----BEGIN-----` e senza a capo.
 *
 * Al contrario di quello di Google, qui il JSON NON viene ricodificato in
 * base64: un PEM e' gia' base64, e incartarlo una seconda volta lo gonfia di
 * un terzo. Con il tetto di 5,1 kB per segreto quel terzo e' la differenza
 * fra stare dentro e non starci.
 *
 * Si accetta comunque anche la forma base64, perche' non costa niente e un
 * segreto caricato a mano potrebbe arrivare cosi'.
 */
function parseSecret(raw: string): SecretShape | null {
  const tentativi = [raw];
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 100) {
    try {
      tentativi.push(atob(raw.replace(/\s+/g, '')));
    } catch { /* non era base64: si prosegue */ }
  }
  for (const t of tentativi) {
    try {
      const o = JSON.parse(t) as SecretShape;
      if (o?.cert && o?.key) return o;
    } catch { /* prova il prossimo formato */ }
  }
  return null;
}

export function readConfigDetailed(
  env: { APPLE_WALLET_CERT?: string },
  settings: Record<string, string>,
  origin: string,
): ConfigEsito {
  const raw = env.APPLE_WALLET_CERT;
  if (!raw) {
    return { config: null, problema: 'Manca il certificato: npm run apple:certificato' };
  }

  const s = parseSecret(raw);
  if (!s) {
    return {
      config: null,
      problema:
        'Il certificato non e leggibile: deve essere il pacchetto prodotto da ' +
        'npm run apple:certificato, codificato in base64.',
    };
  }
  if (!s.passTypeId || !s.teamId) {
    return {
      config: null,
      problema: 'Nel certificato mancano il Pass Type ID o il Team ID. Rilancia npm run apple:certificato.',
    };
  }

  // La chiave dei token non e' un segreto del Worker ma una riga in settings:
  // non da' accesso a emettere tessere, protegge solo la lettura di un saldo
  // che il QR gia' mostra a chiunque abbia il link. Deve pero' sopravvivere al
  // rinnovo annuale del certificato, quindi sta scritta da un'altra parte.
  const authKey = settings.apple_auth_key;
  if (!authKey) {
    return { config: null, problema: 'Manca la chiave dei token: si genera da sola al primo uso.' };
  }

  return {
    config: {
      passTypeId: s.passTypeId,
      teamId: s.teamId,
      certPem: s.cert!,
      keyPem: s.key!,
      // l'intermedio viaggia nel codice, ma se il segreto ne porta uno suo
      // vince quello: serve il giorno in cui Apple cambia intermedio
      wwdrPem: s.wwdr ?? WWDR_G4,
      apns: s.apnsKeyId && s.apnsKey ? { keyId: s.apnsKeyId, keyPem: s.apnsKey } : null,
      storeName: settings.store_name ?? 'Pasticceria',
      origin,
      authKey,
    },
    problema: null,
  };
}

export function readConfig(
  env: { APPLE_WALLET_CERT?: string },
  settings: Record<string, string>,
  origin: string,
): AppleConfig | null {
  return readConfigDetailed(env, settings, origin).config;
}
