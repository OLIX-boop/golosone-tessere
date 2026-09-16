/**
 * Codici tessera.
 *
 * Alfabeto senza coppie ambigue. Esclusi: 0 O 1 I L S U V.
 * Il 5 resta (la S non c'e', quindi non si confonde), cosi' come Q e W.
 * Serve a due cose:
 *   1) il cliente puo' dettarlo al telefono senza equivoci
 *   2) sopravvive ai lettori barcode con layout tastiera sbagliato,
 *      perche' sono tutti caratteri che non cambiano tra layout US e IT
 */
export const ALPHABET = '23456789ABCDEFGHJKMNPQRTWXYZ'; // 28 caratteri
export const CODE_LENGTH = 8; // 28^8 = ~3.8e11 combinazioni

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // modulo su 256 con alfabeto da 28: bias trascurabile per questo uso,
    // ma lo togliamo comunque riestraendo i byte fuori range.
    let b = bytes[i];
    while (b >= 252) {
      const extra = new Uint8Array(1);
      crypto.getRandomValues(extra);
      b = extra[0];
    }
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/**
 * Parsing difensivo dell'input della cassa.
 *
 * Non facciamo "togli il prefisso https://dominio/c/": se il lettore barcode
 * ha il layout sbagliato i due punti e gli slash escono storpiati e il match
 * fallirebbe. Prendiamo invece l'ULTIMA sequenza alfanumerica lunga come il
 * codice, che passa indenne da qualsiasi layout.
 *
 * Cosi' lo stesso campo accetta tre cose diverse:
 *   - URL completo         -> scansione della tessera
 *   - codice nudo AB7K2P   -> digitato a mano
 *   - numero di telefono   -> cliente senza tessera
 */
export type ParsedInput =
  | { type: 'code'; value: string }
  | { type: 'phone'; value: string }
  | { type: 'name'; value: string }
  | { type: 'empty' };

/**
 * Ripulisce l'input senza MAI indovinare.
 *
 * Deliberatamente non "corregge" i caratteri esclusi (0 O 1 I L S U V):
 * non esistono nell'alfabeto, quindi qualunque mappatura sarebbe un tiro a
 * indovinare che potrebbe trasformare un codice sbagliato in un altro codice
 * VALIDO, assegnando i punti al cliente sbagliato senza che nessuno se ne
 * accorga. Se il codice non e' valido lo diciamo e basta.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9+]/g, '').replace(/^\+39/, '').replace(/^0039/, '');
  return digits.replace(/[^0-9]/g, '');
}

export function parseInput(raw: string): ParsedInput {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { type: 'empty' };

  // Telefono: 9-11 cifre una volta tolti spazi, prefissi e separatori.
  const asPhone = normalizePhone(trimmed);
  const looksLikePhone = /^[0-9+\s./-]+$/.test(trimmed) && asPhone.length >= 9 && asPhone.length <= 11;
  if (looksLikePhone) return { type: 'phone', value: asPhone };

  // Codice tessera: ultima sequenza alfanumerica della lunghezza giusta.
  const chunks = trimmed.toUpperCase().match(/[0-9A-Z]+/g);
  if (chunks) {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].length === CODE_LENGTH) {
        return { type: 'code', value: chunks[i] };
      }
    }
  }

  // Altrimenti e' una ricerca per nome.
  return { type: 'name', value: trimmed };
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}
