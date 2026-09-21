/**
 * Genera le immagini che Apple pretende dentro il .pkpass e le incorpora in un
 * modulo TypeScript.
 *
 * Incorporate e non lette a runtime: il Worker dovrebbe altrimenti andarsele a
 * prendere via rete a ogni download della tessera, aggiungendo un giro di
 * chiamate e un modo in piu' di fallire. Sono pochi kilobyte.
 *
 * `icon` e' obbligatoria - senza, iOS rifiuta il pass senza dire perche'.
 *
 *   npm run immagini-pass
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const sorgente = readFileSync('public/logo.png');

// Le misure sono quelle della documentazione Apple: icona a 29pt con le
// varianti @2x e @3x, logo alto al massimo 50pt.
const richieste = [
  ['icon.png', 29],
  ['icon@2x.png', 58],
  ['icon@3x.png', 87],
  ['logo.png', 50],
  ['logo@2x.png', 100],
  ['logo@3x.png', 150],
];

const voci = [];
for (const [nome, lato] of richieste) {
  const png = await sharp(sorgente).resize(lato, lato, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
  voci.push(`  '${nome}': '${png.toString('base64')}',`);
  console.log(`  ${nome.padEnd(14)} ${lato}x${lato}  ${(png.length / 1024).toFixed(1)} kB`);
}

const modulo = `// GENERATO da scripts/genera-immagini-pass.mjs - non modificare a mano.
//
// Immagini del pass Apple, incorporate in base64 perche' il Worker non puo'
// leggere file dal disco. Per cambiarle si sostituisce public/logo.png e si
// rilancia: npm run immagini-pass

export const IMMAGINI_PASS: Record<string, string> = {
${voci.join('\n')}
};
`;

writeFileSync('src/pass-immagini.ts', modulo);
console.log(`\nsrc/pass-immagini.ts  ${(modulo.length / 1024).toFixed(1)} kB`);
