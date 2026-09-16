/**
 * Genera il logo usato nel pass di Google Wallet.
 *
 * Google RIFIUTA la creazione della classe senza un logo ("LoyaltyClass cannot
 * be created without a program logo"), e l'immagine deve stare su un indirizzo
 * HTTPS pubblico: la serviamo dal Worker stesso, cosi' non serve ospitarla
 * altrove.
 *
 * Questo e' un segnaposto decoroso. Per metterci il logo vero della
 * pasticceria basta sostituire public/logo.png con un PNG quadrato - almeno
 * 660x660, sfondo pieno e non trasparente, perche' Google lo mostra su fondi
 * di colore variabile.
 *
 *   npm run logo
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const LATO = 660;
const MARRONE = '#8c4a2f';
const CREMA = '#f4f1ec';

// Panna a cerchi sovrapposti invece che a curve: a 60 pixel sul telefono le
// bezier fini spariscono, le forme piene no.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LATO}" height="${LATO}" viewBox="0 0 660 660">
  <rect width="660" height="660" fill="${MARRONE}"/>
  <g fill="${CREMA}">
    <circle cx="330" cy="168" r="30"/>
    <circle cx="256" cy="286" r="62"/>
    <circle cx="330" cy="240" r="74"/>
    <circle cx="404" cy="286" r="62"/>
    <rect x="194" y="286" width="272" height="66"/>
    <path d="M186 348 h288 l-32 186 a20 20 0 0 1 -20 17 h-164 a20 20 0 0 1 -20 -17 z"/>
  </g>
  <g stroke="${MARRONE}" stroke-width="13" stroke-linecap="round" opacity="0.5">
    <line x1="268" y1="382" x2="252" y2="516"/>
    <line x1="330" y1="382" x2="330" y2="518"/>
    <line x1="392" y1="382" x2="408" y2="516"/>
  </g>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync('public/logo.png', png);

const meta = await sharp(png).metadata();
console.log(`public/logo.png  ${meta.width}x${meta.height}  ${(png.length / 1024).toFixed(1)} kB`);
