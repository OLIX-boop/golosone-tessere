import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg } from '../src/qr.ts';
import { generateCode } from '../src/codes.ts';

/**
 * Un QR "che sembra giusto" ma non si scansiona e' carta da buttare, e te ne
 * accorgi solo davanti al cliente. Qui il codice generato viene rasterizzato e
 * riletto da un decodificatore vero: se non torna il testo di partenza, il
 * test fallisce.
 */
function decode(text: string, scale = 4, quiet = 4): string | null {
  const m = qrMatrix(text);
  const n = m.length;
  const side = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255); // sfondo bianco

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!m[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const i = (y * side + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0; // modulo nero
        }
      }
    }
  }
  return jsQR(data, side, side)?.data ?? null;
}

test('un URL tessera si rilegge identico dal QR generato', () => {
  const url = 'https://tessere.example.dev/c/MMPRKQ46';
  assert.equal(decode(url), url);
});

test('30 codici casuali reggono il giro completo di andata e ritorno', () => {
  for (let i = 0; i < 30; i++) {
    const url = `https://tessere.pasticceria.workers.dev/c/${generateCode()}`;
    assert.equal(decode(url), url, `QR illeggibile per ${url}`);
  }
});

test('regge anche un dominio lungo', () => {
  // se un domani il dominio si allunga, il QR deve solo diventare piu' fitto,
  // non smettere di funzionare
  const url = `https://tessere.pasticceria-del-corso-milano.example.com/c/${generateCode()}`;
  assert.equal(decode(url), url);
});

test('la quiet zone e nel disegno: senza, molti lettori non agganciano', () => {
  const svg = qrSvg('https://x.dev/c/ABCD2345', { size: 100, quietZone: 4 });
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(viewBox);
  const moduli = qrMatrix('https://x.dev/c/ABCD2345').length;
  assert.equal(Number(viewBox![1]), moduli + 8, 'mancano i 4 moduli di margine per lato');
});

test('lo SVG e un solo path, non un rettangolo per modulo', () => {
  // dieci tessere per foglio: con un <rect> per modulo il file diventa
  // pesante da aprire e da mandare in stampa
  const svg = qrSvg('https://x.dev/c/ABCD2345');
  assert.equal((svg.match(/<path/g) ?? []).length, 1);
  assert.equal((svg.match(/<rect/g) ?? []).length, 1); // solo lo sfondo
});
