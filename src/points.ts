/**
 * Regole punti. Funzioni pure, nessun accesso al database: cosi' si testano
 * da sole e la regola resta in un posto solo.
 *
 * Scelta di fondo: NON si buttano via i centesimi che avanzano.
 * Una spesa di 12 EUR con soglia a 5 EUR da' 2 punti e lascia 2 EUR "in cassa"
 * sul conto del cliente, che si sommano all'acquisto successivo. E' piu' equo,
 * ed e' anche il motivo per cui in database teniamo cents_carry invece di
 * ricalcolare i punti dal totale speso.
 */

export type EarnResult = {
  pointsEarned: number;
  newCarry: number;
  /** centesimi che mancano al prossimo punto, per mostrarlo al cliente */
  centsToNextPoint: number;
};

export function computeEarn(
  currentCarry: number,
  amountCents: number,
  centsPerPoint: number,
): EarnResult {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error('amountCents deve essere un intero non negativo');
  }
  if (!Number.isInteger(centsPerPoint) || centsPerPoint <= 0) {
    throw new Error('centsPerPoint deve essere un intero positivo');
  }
  const total = currentCarry + amountCents;
  const pointsEarned = Math.floor(total / centsPerPoint);
  const newCarry = total % centsPerPoint;
  return {
    pointsEarned,
    newCarry,
    centsToNextPoint: centsPerPoint - newCarry,
  };
}

/** Converte "12,50" / "12.50" / "1250" in centesimi interi, senza float. */
export function parseAmountToCents(raw: string): number | null {
  const cleaned = (raw ?? '').trim().replace(/\s|EUR|€/gi, '').replace(',', '.');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;

  const [intPart, decPart = ''] = cleaned.split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
