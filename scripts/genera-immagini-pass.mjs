/**
 * Genera le immagini che Apple pretende dentro il .pkpass e le incorpora in un
 * modulo TypeScript.
 *
 * Incorporate e non lette a runtime: il Worker dovrebbe altrimenti andarsele a
 * prendere via rete a ogni download della tessera, aggiungendo un giro di
 * chiamate e un modo in piu' di fallire. Sono pochi kilobyte.
 *
 * Due immagini, con due compiti:
 *   - `icon`, obbligatoria - senza, iOS rifiuta il pass senza dire perche'.
 *     La si vede nelle notifiche e nella schermata di blocco: e' il logo
 *     quadrato di Google, cosi' le due tessere hanno la stessa faccia.
 *   - `logo`, in alto a sinistra sulla tessera: il marchio in oro su fondo
 *     trasparente, perche' il cremisi ce lo mette gia' la tessera. Apple lo
 *     vuole alto al massimo 50pt e largo al massimo 160.
 *
 * Parte dalle stesse immagini dei loghi Google: prima va lanciato
 * `npm run logo`.
 *
 *   npm run immagini-pass
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { COLORI } from '../src/pass-comune.ts';
import { marchioTinto } from './marchio.mjs';

const quadrato = readFileSync('public/logo.png');

const voci = [];
const aggiungi = (nome, png, misura) => {
  voci.push(`  '${nome}': '${png.toString('base64')}',`);
  console.log(`  ${nome.padEnd(14)} ${misura}  ${(png.length / 1024).toFixed(1)} kB`);
};

for (const [nome, lato] of [['icon.png', 29], ['icon@2x.png', 58], ['icon@3x.png', 87]]) {
  const png = await sharp(quadrato).resize(lato, lato).png({ compressionLevel: 9 }).toBuffer();
  aggiungi(nome, png, `${lato}x${lato}`);
}

for (const [nome, densita] of [['logo.png', 1], ['logo@2x.png', 2], ['logo@3x.png', 3]]) {
  const png = await marchioTinto(COLORI.oro.hex, { largo: 160 * densita, alto: 50 * densita });
  const { width, height } = await sharp(png).metadata();
  aggiungi(nome, png, `${width}x${height}`);
}

const modulo = `// GENERATO da scripts/genera-immagini-pass.mjs - non modificare a mano.
//
// Immagini del pass Apple, incorporate in base64 perche' il Worker non puo'
// leggere file dal disco. Per cambiarle si sostituisce public/marchio.png e si
// rilancia: npm run logo && npm run immagini-pass

export const IMMAGINI_PASS: Record<string, string> = {
${voci.join('\n')}
};
`;

writeFileSync('src/pass-immagini.ts', modulo);
console.log(`\nsrc/pass-immagini.ts  ${(modulo.length / 1024).toFixed(1)} kB`);
