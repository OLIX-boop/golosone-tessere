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

export const ETICHETTE = {
  punti: 'Punti',
  intestatario: 'Tessera di',
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
  // Il premio prima e «fra» poi: l'articolo dipenderebbe dal genere del
  // premio, che il titolare cambia quando vuole dal pannello.
  if (prossimo) {
    return prossimo.mancano > 0
      ? `${prossimo.nome} fra ${prossimo.mancano} ${prossimo.mancano === 1 ? 'punto' : 'punti'}`
      : prossimo.nome;
  }
  return ciSonoPremi ? 'Hai un premio da ritirare al banco' : null;
}

/** I dati di una tessera nella forma che serve ai due Wallet. */
export type DatiTessera = {
  code: string;
  firstName: string | null;
  points: number;
  /** il premio piu' vicino ancora da raggiungere, se si mostrano i premi */
  nextReward?: { name: string; points_cost: number } | null;
  /** se il negozio ha premi da mostrare */
  ciSonoPremi?: boolean;
};

/** La riga del prossimo premio per questa tessera. */
export function rigaDi(t: DatiTessera): string | null {
  return rigaProssimo(
    t.nextReward ? { nome: t.nextReward.name, mancano: t.nextReward.points_cost - t.points } : null,
    t.ciSonoPremi ?? false,
  );
}
