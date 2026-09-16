/**
 * Validazione dei punti. Funzioni pure, nessun accesso al database.
 *
 * Il sistema NON converte importi in punti: l'operatore guarda lo scontrino,
 * decide quanti punti vale e li assegna. Due conseguenze volute:
 *
 *   - non resta scritto da nessuna parte un prezzo che il cliente possa
 *     contestare se l'operatore ha digitato di fretta;
 *   - le spese minime non lasciano un residuo che, sommandosi, finisce per
 *     pagare un punto su vendite che non hanno margine.
 *
 * Il prezzo di questa scelta e' che i punti assegnati non sono ricalcolabili
 * da nient'altro: sono loro il dato. Per questo esiste un tetto per movimento
 * e la possibilita' di annullare.
 */

export type ParsedPoints = { ok: true; points: number } | { ok: false; error: string };

export function parsePoints(raw: string | number, maxPerTx: number): ParsedPoints {
  const cleaned = String(raw ?? '').trim().replace(/\s|punti|punto/gi, '');
  if (!cleaned) return { ok: false, error: 'Inserisci quanti punti assegnare' };

  // Solo interi positivi: mezzi punti non esistono, e "2,5" e' quasi sempre
  // un importo digitato per sbaglio nel campo dei punti.
  if (!/^\d{1,4}$/.test(cleaned)) {
    return { ok: false, error: 'I punti sono un numero intero, es. 2' };
  }

  const points = Number(cleaned);
  if (points === 0) return { ok: false, error: 'Zero punti: niente da assegnare' };
  if (points > maxPerTx) {
    return { ok: false, error: `Massimo ${maxPerTx} punti per volta: correggi o chiedi al titolare` };
  }
  return { ok: true, points };
}

/** "punto" / "punti" al posto giusto: compare in ogni schermata. */
export function pointsLabel(n: number): string {
  return Math.abs(n) === 1 ? 'punto' : 'punti';
}
