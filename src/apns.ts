/**
 * Push ad APNs per svegliare i pass Apple.
 *
 * La notifica non porta dati: e' solo un colpetto sulla spalla. Il telefono
 * la riceve, chiede al Worker quali pass sono cambiati e si riscarica quelli.
 * Il saldo non viaggia mai dentro la notifica.
 *
 * Autenticazione a token (.p8) e non a certificato. Non e' un dettaglio:
 * l'autenticazione a certificato richiederebbe una connessione TLS con
 * certificato cliente, che dentro un Worker si fa solo con il binding mTLS di
 * Cloudflare. Con il token basta una fetch normale, e una chiave sola vale
 * per tutto l'account.
 *
 * Due cose da sapere prima di dare la colpa al codice:
 *   * il push per i pass funziona SOLO in produzione, lo dice Apple;
 *   * in locale non parte comunque, perche' APNs parla solo HTTP/2 e il
 *     runtime locale dei Worker non lo fa. Sulla rete Cloudflare invece si'.
 */

const APNS = 'https://api.push.apple.com/3/device/';
const enc = new TextEncoder();

export type ApnsKey = { keyId: string; keyPem: string; teamId: string };

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Il token APNs vale un'ora e Apple chiede di non rigenerarlo piu' di una
 * volta ogni venti minuti: si tiene da parte, come quello di Google.
 */
let tokenCache: { token: string; keyId: string; madeAt: number } | null = null;

export async function providerToken(key: ApnsKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.keyId === key.keyId && now - tokenCache.madeAt < 1800) {
    return tokenCache.token;
  }

  const head = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: key.keyId })));
  const body = b64url(enc.encode(JSON.stringify({ iss: key.teamId, iat: now })));

  // La chiave .p8 e' una curva P-256, non RSA: l'algoritmo qui e' ES256.
  const k = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.keyPem).buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // Web Crypto restituisce gia' la firma nella forma r||s che vuole JWT:
  // se passasse dalla forma DER andrebbe convertita a mano.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      k,
      enc.encode(`${head}.${body}`),
    ),
  );

  const token = `${head}.${body}.${b64url(sig)}`;
  tokenCache = { token, keyId: key.keyId, madeAt: now };
  return token;
}

export type EsitoPush = {
  /** token di dispositivi che APNs non riconosce piu': vanno cancellati */
  morti: string[];
  inviate: number;
};

/**
 * Sveglia i dispositivi registrati per una tessera.
 *
 * Il corpo e' un oggetto JSON vuoto, come dice Apple: la notifica non deve
 * dire cosa e' cambiato, perche' non e' garantita e piu' notifiche vengono
 * accorpate. `apns-topic` e' il Pass Type ID e non l'identificativo di
 * un'app: e' l'errore piu' comune di chi arriva dal push normale.
 *
 * `apns-push-type` non viene mandato di proposito: su iOS e' facoltativo, e
 * dichiarare un push "background" con un corpo vuoto e' esattamente il caso
 * che iOS rifiuta lamentando un JSON che non riesce a leggere.
 */
export async function pushPassUpdate(
  key: ApnsKey,
  topic: string,
  pushTokens: string[],
): Promise<EsitoPush> {
  if (pushTokens.length === 0) return { morti: [], inviate: 0 };

  const auth = await providerToken(key);
  const morti: string[] = [];
  let inviate = 0;

  for (const t of pushTokens) {
    const res = await fetch(APNS + t, {
      method: 'POST',
      headers: {
        authorization: `bearer ${auth}`,
        'apns-topic': topic,
        'apns-priority': '5',
        'content-type': 'application/json',
      },
      body: '{}',
    });

    if (res.ok) {
      inviate++;
      continue;
    }
    // 410 = il pass non e' piu' su quel telefono. 400 con BadDeviceToken
    // vuol dire la stessa cosa: in entrambi i casi la registrazione e' da
    // buttare, altrimenti resta li' a far fallire ogni push futuro.
    const dettaglio = await res.text().catch(() => '');
    if (res.status === 410 || dettaglio.includes('BadDeviceToken')) {
      morti.push(t);
    } else {
      console.error(`APNs ha rifiutato un invio (${res.status}): ${dettaglio}`);
    }
  }

  return { morti, inviate };
}
