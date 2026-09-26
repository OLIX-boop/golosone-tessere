/**
 * I loghi della tessera Google Wallet, dal marchio del Golosone.
 *
 * Google ne vuole due, e li usa in modo diverso:
 *
 *   - `logo.png`, quadrato 660x660, obbligatorio: senza, Google rifiuta la
 *     classe ("LoyaltyClass cannot be created without a program logo"). Lo
 *     ritaglia **a cerchio** e lo mostra negli elenchi e nelle notifiche,
 *     quindi il marchio sta stretto al centro: la scritta è larga e bassa, e
 *     «Il» a sinistra e il cappello a destra sono le prime cose che il
 *     cerchio si mangerebbe.
 *   - `logo-largo.png`, 1280x400: se c'è prende il posto del cerchio in cima
 *     alla tessera. È quello che fa sembrare la tessera del negozio invece
 *     che un modulo di Google, e che la rende uguale a quella di Apple.
 *
 * Tutti e due su fondo cremisi pieno, lo stesso della tessera: un bordo di
 * colore diverso intorno al logo si vedrebbe come un adesivo.
 *
 * Quando le immagini cambiano va alzato VERSIONE_IMMAGINI in
 * src/pass-comune.ts, altrimenti Google continua a mostrare le vecchie.
 *
 *   npm run logo
 */
import sharp from 'sharp';
import { COLORI } from '../src/pass-comune.ts';
import { marchioTinto } from './marchio.mjs';

async function suFondo(largo, alto, marchio, nome, dove = { gravity: 'centre' }) {
  await sharp({ create: { width: largo, height: alto, channels: 4, background: COLORI.fondo.hex } })
    .composite([{ input: marchio, ...dove }])
    // Fondo pieno e senza trasparenza: Google mostra i loghi su fondi che
    // non decidiamo noi, e un alfa lascerebbe trasparire quelli.
    .flatten({ background: COLORI.fondo.hex })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(`public/${nome}`);
  console.log(`public/${nome}  ${largo}x${alto}`);
}

// Il cerchio di Google lascia un margine del 15% per lato: il marchio sta
// dentro il 70% centrale, e siccome è più largo che alto è la larghezza a
// toccare il bordo, quindi si stringe ancora un po'.
await suFondo(660, 660, await marchioTinto(COLORI.oro.hex, { largo: 400, alto: 400 }), 'logo.png');

// Nel logo largo il marchio occupa l'altezza, con un filo d'aria sopra e
// sotto, ed è **a sinistra**: Google mette questo logo in alto a sinistra
// sulla tessera, dove Apple mette il suo, e centrato resterebbe staccato
// dal bordo come un'etichetta messa storta.
const largo = await marchioTinto(COLORI.oro.hex, { largo: 1100, alto: 340 });
await suFondo(1280, 400, largo, 'logo-largo.png', { left: 40, top: 30 });
