import qrcode from 'qrcode-generator';

/**
 * Generazione QR come SVG.
 *
 * SVG e non PNG perche' le tessere si stampano: un vettoriale resta nitido a
 * qualsiasi dimensione e non dipende dai DPI con cui l'utente manda in stampa.
 *
 * Correzione d'errore su 'M' (~15%): una tessera sta in tasca e si sporca, ma
 * salire a 'Q' o 'H' infittisce i moduli e su un QR stampato piccolo il
 * guadagno si perde in leggibilita'.
 */
export type QrLevel = 'L' | 'M' | 'Q' | 'H';

export function qrMatrix(text: string, level: QrLevel = 'M'): boolean[][] {
  // typeNumber 0 = sceglie da solo la versione minima che contiene il testo
  const qr = qrcode(0, level);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/**
 * SVG con un solo `path`: un rettangolo per modulo produrrebbe centinaia di
 * nodi per tessera, e con dieci tessere per foglio il documento diventa pesante
 * da aprire e da stampare.
 *
 * `quietZone` sono i moduli di margine bianco richiesti dallo standard: senza
 * di essi molti lettori non agganciano il codice.
 */
export function qrSvg(
  text: string,
  opts: { size?: number; level?: QrLevel; quietZone?: number; className?: string } = {},
): string {
  const { size = 120, level = 'M', quietZone = 4, className } = opts;
  const matrix = qrMatrix(text, level);
  const n = matrix.length;
  const total = n + quietZone * 2;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) path += `M${c + quietZone} ${r + quietZone}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"` +
    `${className ? ` class="${className}"` : ''}>` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}

/**
 * Lo stesso QR come **immagine già pronta**, non come SVG.
 *
 * Serve all'app dei clienti, che il codice lo mostra a schermo perché il
 * lettore della cassa lo legga: è lo stesso QR del cartoncino, quindi in
 * cassa non cambia niente.
 *
 * Immagine e non vettoriale perché React Native gli SVG non li disegna —
 * lo abbiamo già scoperto con le illustrazioni del catalogo, che sul telefono
 * erano rettangoli vuoti. `qrcode-generator` sa produrre una GIF senza
 * dipendere da niente: nessuna libreria in più sul telefono e nessuna build
 * nuova da installare.
 *
 * `cella` sono i pixel per modulo: bassa, l'immagine pesa poco e il telefono
 * la ingrandisce da sé senza sfocarla, perché un QR è fatto di quadrati.
 */
export function qrDataUrl(text: string, opts: { cella?: number; margine?: number; level?: QrLevel } = {}): string {
  const { cella = 8, margine = 4, level = 'M' } = opts;
  const qr = qrcode(0, level);
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cella, margine);
}
