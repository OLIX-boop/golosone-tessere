/**
 * Quello che la tessera di Apple e quella di Google devono avere uguale.
 *
 * I due Wallet impaginano ognuno a modo suo e non lo si può cambiare, ma
 * colori, marchio e parole li decidiamo noi. Tenuti qui in un posto solo,
 * le due tessere non possono più separarsi: prima avevano lo stesso marrone
 * scritto due volte, e bastava cambiarne uno per ritrovarsi con due tessere
 * diverse nello stesso negozio.
 */

/**
 * I colori dell'insegna del Golosone: gli stessi dell'icona dell'app degli
 * ordini, così in cassa telefono, app e tessera si riconoscono come una
 * cosa sola.
 */
export const COLORI = {
  fondo: { hex: '#be1b45', rgb: 'rgb(190, 27, 69)' },
  testo: { hex: '#ffffff', rgb: 'rgb(255, 255, 255)' },
  oro: { hex: '#f2c75c', rgb: 'rgb(242, 199, 92)' },
} as const;

/**
 * Si cambia quando cambiano le immagini in `public/`.
 *
 * Google si tiene in cache le immagini per indirizzo: se il file cambia ma
 * l'indirizzo resta quello, le tessere continuano a mostrare la vecchia. Il
 * numero finisce in coda all'indirizzo e lo rende nuovo.
 */
export const VERSIONE_IMMAGINI = 2;

export const ETICHETTE = {
  punti: 'Punti',
  intestatario: 'Intestatario',
  codice: 'Codice tessera',
  prossimo: 'Prossimo premio',
} as const;

export type Prossimo = { nome: string; mancano: number } | null;

/**
 * La riga del prossimo premio, uguale sulle due tessere.
 *
 * `null` solo quando il negozio non ha premi: se ne ha e il cliente li ha
 * già raggiunti tutti, dirglielo vale più di una riga che sparisce.
 */
export function rigaProssimo(prossimo: Prossimo, ciSonoPremi: boolean): string | null {
  if (prossimo) {
    return `${prossimo.mancano} ${prossimo.mancano === 1 ? 'punto' : 'punti'} a ${prossimo.nome}`;
  }
  return ciSonoPremi ? 'Hai un premio da ritirare al banco' : null;
}
