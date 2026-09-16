/**
 * Accesso al pannello cassa.
 *
 * Un solo PIN condiviso, non un account per persona: il pannello si apre dalla
 * cassa e resta aperto tutto il giorno, e gli operatori non usano il proprio
 * telefono. Autenticare ogni singola persona sarebbe attrito senza guadagno.
 *
 * Conseguenza da tenere presente: i movimenti non portano il nome di chi li ha
 * fatti. Il PIN serve a tenere fuori chi passa, non a dire chi ha assegnato
 * cosa. Il tetto per movimento e la finestra di annullo restano le difese
 * contro l'errore di battitura.
 *
 * Il PIN sta in `settings` (hash + salt), quindi si cambia senza rideploy.
 */

const PBKDF2_ITERATIONS = 150_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // la cassa non deve rifare il PIN ogni mattina
export const SESSION_COOKIE = 'gt_sess';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

export async function hashPin(pin: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

/** Confronto a tempo costante: non facciamo trapelare quanto ci siamo andati vicino. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPin(pin: string, saltHex: string, expectedHash: string): Promise<boolean> {
  return timingSafeEqual(await hashPin(pin, saltHex), expectedHash);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

export type NewSession = { token: string; tokenHash: string; expiresAt: number };

/** Il token va al browser, in database ci finisce solo il suo hash. */
export async function createSessionToken(): Promise<NewSession> {
  const token = randomHex(32);
  return {
    token,
    tokenHash: await sha256Hex(token),
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
