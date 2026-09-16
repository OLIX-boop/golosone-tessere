/**
 * Google Wallet: tessera digitale che si aggiorna da sola.
 *
 * Perche' vale la pena, nonostante la configurazione:
 * il pass sta nel Wallet del telefono e il saldo punti cambia da solo quando
 * la cassa assegna i punti. Su iPhone questo non e' possibile (i pass creati
 * dall'utente in iOS 27 sono congelati), quindi e' l'unico dei due che
 * giustifica del codice.
 *
 * Come sta insieme:
 *   1. una CLASSE, creata una volta sola: e' il modello della tessera
 *      (nome negozio, colori, logo). Tenerci dentro tutto il possibile serve
 *      a lasciare l'oggetto piccolo.
 *   2. un OGGETTO per cliente, che contiene solo il suo codice e i suoi punti.
 *   3. un LINK firmato che contiene solo il RIFERIMENTO all'oggetto, non
 *      l'oggetto intero: i JWT non sono cifrati e l'URL ha un tetto di 2000
 *      caratteri.
 *
 * Tutto degrada in silenzio: se manca la configurazione il pulsante non
 * compare e il resto del programma non se ne accorge. La cassa non deve MAI
 * fermarsi perche' Google non risponde.
 */

export type ServiceAccount = { client_email: string; private_key: string };

export type WalletConfig = {
  sa: ServiceAccount;
  issuerId: string;
  /** suffisso della classe, unico per negozio */
  classSuffix: string;
  storeName: string;
  origin: string;
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

// ------------------------------------------------------------------ base64

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const b64urlText = (t: string) => b64url(enc.encode(t));

/** Il PEM del service account arriva PKCS8, con le righe e le intestazioni. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

async function importKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** JWT RS256: e' l'unico algoritmo che Google accetta qui. */
export async function signJwt(sa: ServiceAccount, claims: Record<string, unknown>): Promise<string> {
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify(claims));
  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ------------------------------------------------------------------- OAuth

// Il token vale un'ora: richiederlo a ogni assegnazione di punti aggiungerebbe
// un giro di rete inutile alla fila della domenica mattina.
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) return tokenCache.token;

  const assertion = await signJwt(sa, {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google ha rifiutato le credenziali (${res.status})`);

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

// ------------------------------------------------------------ classe/oggetto

export const classId = (c: WalletConfig) => `${c.issuerId}.${c.classSuffix}`;
export const objectId = (c: WalletConfig, code: string) =>
  // solo alfanumerici, punti, trattini e underscore: il codice tessera
  // rispetta gia' questo vincolo
  `${c.issuerId}.${c.classSuffix}_${code}`;

function classBody(c: WalletConfig) {
  return {
    id: classId(c),
    issuerName: c.storeName,
    programName: 'Tessera punti',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#8c4a2f',
    countryCode: 'IT',
    // Il saldo va nel modulo punti dell'oggetto, non qui: qui ci sta solo
    // cio' che e' uguale per tutti i clienti.
  };
}

function objectBody(c: WalletConfig, card: { code: string; firstName: string | null; points: number }) {
  return {
    id: objectId(c, card.code),
    classId: classId(c),
    state: 'ACTIVE',
    accountId: card.code,
    accountName: card.firstName ?? 'Cliente',
    loyaltyPoints: {
      label: 'Punti',
      balance: { int: card.points },
    },
    barcode: {
      type: 'QR_CODE',
      value: `${c.origin}/c/${card.code}`,
      alternateText: card.code,
    },
    linksModuleData: {
      uris: [{ uri: `${c.origin}/c/${card.code}`, description: 'Vedi i tuoi punti' }],
    },
  };
}

/** Crea la classe se manca. Se esiste gia', Google risponde 409 e va benissimo. */
export async function ensureClass(c: WalletConfig): Promise<void> {
  const token = await accessToken(c.sa);
  const res = await fetch(`${API}/loyaltyClass`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(classBody(c)),
  });
  if (res.ok || res.status === 409) return;
  throw new Error(`Creazione classe fallita (${res.status}): ${await res.text()}`);
}

/** Crea l'oggetto se manca, altrimenti ne aggiorna il saldo. */
export async function upsertObject(
  c: WalletConfig,
  card: { code: string; firstName: string | null; points: number },
): Promise<void> {
  const token = await accessToken(c.sa);
  const id = objectId(c, card.code);

  const patch = await fetch(`${API}/loyaltyObject/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loyaltyPoints: { label: 'Punti', balance: { int: card.points } } }),
  });
  if (patch.ok) return;
  if (patch.status !== 404) {
    throw new Error(`Aggiornamento pass fallito (${patch.status}): ${await patch.text()}`);
  }

  const create = await fetch(`${API}/loyaltyObject`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(objectBody(c, card)),
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`Creazione pass fallita (${create.status}): ${await create.text()}`);
  }
}

/**
 * Link "Aggiungi a Google Wallet".
 *
 * Nel JWT va solo il riferimento all'oggetto, mai l'oggetto intero: i JWT non
 * sono cifrati e l'URL ha un tetto pratico di 2000 caratteri, che un oggetto
 * completo supererebbe appena il nome del negozio si allunga.
 */
export async function saveLink(c: WalletConfig, code: string): Promise<string> {
  const jwt = await signJwt(c.sa, {
    iss: c.sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [c.origin],
    payload: { loyaltyObjects: [{ id: objectId(c, code) }] },
  });
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

// ------------------------------------------------------------ configurazione

/**
 * Legge la configurazione.
 *
 * La chiave del service account sta nei segreti del Worker e non in database:
 * un dump del database non deve consegnare anche la facolta' di emettere
 * tessere a nome del negozio.
 *
 * Il JSON di Google contiene una chiave PEM su piu' righe, ed e' notoriamente
 * scomodo da infilare in una variabile d'ambiente: le virgolette si scappano,
 * gli a capo diventano \n letterali, e il risultato non e' piu' JSON valido.
 * Per questo si accetta anche il JSON codificato in base64 - la forma
 * consigliata, perche' non ha caratteri che qualcosa possa rovinare per strada.
 *
 * Restituisce sempre anche il motivo del fallimento: un pulsante che non
 * compare senza spiegazioni e' impossibile da diagnosticare per chi gestisce
 * il negozio.
 */
export type ConfigEsito = { config: WalletConfig | null; problema: string | null };

function parseServiceAccount(raw: string): ServiceAccount | null {
  const tentativi = [raw];

  // base64 (consigliato): niente virgolette o a capo da rovinare
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 100) {
    try {
      tentativi.push(atob(raw.replace(/\s+/g, '')));
    } catch { /* non era base64: si prosegue col resto */ }
  }

  for (const t of tentativi) {
    try {
      const sa = JSON.parse(t) as ServiceAccount;
      if (!sa?.client_email || !sa?.private_key) continue;
      return {
        client_email: sa.client_email,
        // se gli a capo sono arrivati come \n letterali, la chiave non
        // importerebbe: si rimettono veri
        private_key: sa.private_key.includes('\\n')
          ? sa.private_key.replace(/\\n/g, '\n')
          : sa.private_key,
      };
    } catch { /* prova il prossimo formato */ }
  }
  return null;
}

export function readConfigDetailed(
  env: { GOOGLE_WALLET_SA?: string },
  settings: Record<string, string>,
  origin: string,
): ConfigEsito {
  const raw = env.GOOGLE_WALLET_SA;
  const issuerId = settings.wallet_issuer_id;

  if (!raw && !issuerId) return { config: null, problema: 'Manca tutto: ID emittente e chiave del service account.' };
  if (!raw) return { config: null, problema: 'Manca la chiave: wrangler secret put GOOGLE_WALLET_SA' };
  if (!issuerId) return { config: null, problema: 'Manca l ID emittente, si imposta dal pannello titolare.' };

  const sa = parseServiceAccount(raw);
  if (!sa) {
    return {
      config: null,
      problema:
        'La chiave non e leggibile: deve essere il JSON del service account, ' +
        'meglio se codificato in base64.',
    };
  }

  return {
    config: {
      sa,
      issuerId,
      classSuffix: settings.wallet_class_suffix || 'tessera_punti',
      storeName: settings.store_name ?? 'Pasticceria',
      origin,
    },
    problema: null,
  };
}

/** Comodita' per chi vuole solo sapere se si puo' procedere. */
export function readConfig(
  env: { GOOGLE_WALLET_SA?: string },
  settings: Record<string, string>,
  origin: string,
): WalletConfig | null {
  return readConfigDetailed(env, settings, origin).config;
}
