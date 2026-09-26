/**
 * Firma CMS/PKCS#7 staccata, scritta a mano.
 *
 * Apple vuole che dentro il .pkpass ci sia un file `signature`: la firma del
 * manifesto in formato CMS, con dentro il certificato del negozio e
 * l'intermedio Apple (WWDR). Non e' un JWT e non e' una firma RSA nuda, e'
 * una struttura ASN.1 che contiene un blocco di attributi firmati al posto
 * del contenuto.
 *
 * Perche' a mano invece che con una libreria: il JWT di Google qui e' gia'
 * scritto a mano, e le librerie che fanno PKCS#7 in JavaScript sono grosse,
 * generiche e pensate per Node. Qui serve un caso solo, su tre algoritmi
 * fissi, e sta in meno codice di quanto ne costerebbe piegare una libreria al
 * runtime dei Worker.
 *
 * Il prezzo lo paga il test: una firma sbagliata iOS la rifiuta senza dire
 * una parola. Per questo il test non guarda la forma, la fa verificare a
 * OpenSSL.
 */

// --------------------------------------------------------------------- DER

const enc = new TextEncoder();

/** Lunghezza in forma corta sotto 128, altrimenti in forma lunga. */
function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const seq = (...p: Uint8Array[]) => tlv(0x30, cat(...p));
const set = (...p: Uint8Array[]) => tlv(0x31, cat(...p));
const octet = (b: Uint8Array) => tlv(0x04, b);
const derNull = () => new Uint8Array([0x05, 0x00]);
/** [n] costruito e implicito: sostituisce il tag, non lo avvolge. */
const implicitCtx = (n: number, content: Uint8Array) => tlv(0xa0 | n, content);

function integer(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  } while (v > 0);
  // se il primo bit e' acceso il numero sembrerebbe negativo: si premette 0x00
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return tlv(0x02, new Uint8Array(bytes));
}

/** OID dalla forma puntata: i primi due rami stanno in un byte solo. */
function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  attrContentType: '1.2.840.113549.1.9.3',
  attrMessageDigest: '1.2.840.113549.1.9.4',
  attrSigningTime: '1.2.840.113549.1.9.5',
};

/** UTCTime: due cifre per l'anno, sempre in UTC. */
function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, '0');
  const s =
    p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, enc.encode(s));
}

// ------------------------------------------------------------------ lettura

type Tlv = { tag: number; start: number; end: number; contentStart: number };

/** Legge un solo TLV a partire da `at`, senza copiare niente. */
function readTlv(buf: Uint8Array, at: number): Tlv {
  const tag = buf[at];
  let i = at + 1;
  let len = buf[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
  }
  return { tag, start: at, contentStart: i, end: i + len };
}

/**
 * Dal certificato servono due cose: chi lo ha emesso e il numero di serie.
 * Insieme identificano il firmatario dentro la struttura CMS.
 *
 * Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] versione?,
 *   serialNumber INTEGER, signature SEQUENCE, issuer SEQUENCE, ... }, ... }
 *
 * La versione e' opzionale: se c'e' porta il tag [0] e va scavalcata,
 * altrimenti il primo campo e' gia' il numero di serie.
 */
export function issuerAndSerial(certDer: Uint8Array): Uint8Array {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.contentStart);

  let at = tbs.contentStart;
  let field = readTlv(certDer, at);
  if (field.tag === 0xa0) {
    at = field.end;
    field = readTlv(certDer, at);
  }
  const serial = certDer.slice(field.start, field.end); // INTEGER

  const sigAlg = readTlv(certDer, field.end);
  const issuer = readTlv(certDer, sigAlg.end);
  return seq(certDer.slice(issuer.start, issuer.end), serial);
}

/** Toglie intestazioni e a capo da un PEM e restituisce i byte DER. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// -------------------------------------------------------------------- firma

export type SignMaterial = {
  /** certificato del Pass Type ID, in PEM */
  certPem: string;
  /** chiave privata corrispondente, PKCS#8 in PEM */
  keyPem: string;
  /** intermedio Apple WWDR, in PEM: senza, iOS non chiude la catena */
  wwdrPem: string;
};

/**
 * Firma staccata del manifesto.
 *
 * "Staccata" significa che il contenuto firmato non viaggia dentro la firma:
 * il manifesto sta gia' nell'archivio come file a se'. E quel che si firma
 * non e' nemmeno il manifesto, ma il blocco di attributi che ne contiene
 * l'impronta: e' cosi' che vuole CMS, ed e' l'errore piu' facile da fare.
 */
export async function signDetached(
  material: SignMaterial,
  content: Uint8Array,
  now: Date = new Date(),
): Promise<Uint8Array> {
  const certDer = pemToDer(material.certPem);
  const wwdrDer = pemToDer(material.wwdrPem);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));

  const attrs = cat(
    seq(oid(OID.attrContentType), set(oid(OID.data))),
    seq(oid(OID.attrSigningTime), set(utcTime(now))),
    seq(oid(OID.attrMessageDigest), set(octet(digest))),
  );

  // Si firma il blocco con il tag SET (0x31). Dentro la struttura lo stesso
  // blocco viaggia poi con il tag [0]: e' una particolarita' di CMS, non una
  // svista.
  const daFirmare = set(attrs);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(material.keyPem).buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const firma = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, daFirmare.buffer as ArrayBuffer),
  );

  const sha256Alg = seq(oid(OID.sha256));
  const signerInfo = seq(
    integer(1),
    issuerAndSerial(certDer),
    sha256Alg,
    implicitCtx(0, attrs),
    seq(oid(OID.rsa), derNull()),
    octet(firma),
  );

  const signedData = seq(
    integer(1),
    set(sha256Alg),
    seq(oid(OID.data)),        // contenuto assente: e' la firma staccata
    implicitCtx(0, cat(certDer, wwdrDer)),
    set(signerInfo),
  );

  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}
