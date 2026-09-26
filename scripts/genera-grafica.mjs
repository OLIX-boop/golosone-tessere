/**
 * Ricava dal logo del negozio tutte le immagini che servono ai due Wallet.
 *
 * Perche' uno script invece di ritagliare a mano: i due sistemi vogliono lo
 * stesso logo in forme incompatibili fra loro, e le misure non sono
 * negoziabili.
 *
 *   Google  logo quadrato, almeno 660x660, sfondo PIENO (lo mostra su fondi
 *           di colore variabile: un PNG trasparente diventa illeggibile)
 *   Apple   logo LARGO, 160x50 punti. Dargli un quadrato e' l'errore che fa
 *           sembrare la tessera vuota: iOS lo rimpicciolisce finche' entra
 *           in 50 punti d'altezza, e resta un francobollo in un angolo.
 *
 * Ogni immagine esce in tre densita' (1x, 2x, 3x) perche' gli iPhone sono
 * tutti a 3x: mandare solo la 1x significa mandare un'immagine sfocata.
 *
 *   npm run grafica                  lo stile predefinito
 *   npm run grafica -- --stile scuro
 *
 * Gli stili non sono un capriccio: il colore dei testi del pass e' UNO SOLO
 * per tutta la tessera (`foregroundColor`), e vale sia sopra la striscia sia
 * sotto, sul fondo. Non si puo' quindi avere una fascia scura con il numero
 * chiaro e sotto i campi scuri sul fondo chiaro: o la tessera e' chiara, o e'
 * scura. Da qui tre stili interi invece di una manopola per la sola striscia.
 */
import sharp from 'sharp';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { COLORI } from '../src/pass-comune.ts';

const ORIGINALE = 'assets/logo-golosone.png';

// ---------------------------------------------------------------- tavolozza

/**
 * I colori escono dal logo, non da un gusto personale: l'inchiostro e' il
 * colore piu' frequente fra i pixel pieni del file, #56343c, un prugna scuro.
 * (Il primo logo, minuscolo e sfocato, ne dava una media falsata piu' chiara:
 * ricavare il colore da un'immagine ingrandita non funziona.)
 *
 * Chi cambia qui deve cambiare anche `backgroundColor`, `foregroundColor` e
 * `labelColor` in src/apple-wallet.ts, altrimenti i testi non tornano piu'
 * con la fascia - e si vede.
 */
export const STILI = {
  // Lo stile del negozio: l'insegna. Fondo cremisi e marchio in oro, gli
  // stessi dell'icona dell'app degli ordini, uguali su Apple e su Google. Niente
  // striscia: su Google non c'e' un equivalente, e le due tessere devono
  // sembrare la stessa. I colori stanno in src/pass-comune.ts, che li passa
  // anche ai due Wallet: qui non si ripetono.
  golosone: {
    carta: COLORI.fondo.hex,
    inchiostro: COLORI.oro.hex,
    fascia: null,
    logoChiaro: true,
    striscia: false,
    // Il cerchio di Google si mangia il 15% per lato, e la scritta e' larga:
    // con il margine standard «Il» e il cappello toccherebbero il bordo.
    margine: 0.2,
    logoLargo: true,
    pass: { background: COLORI.fondo.rgb, foreground: COLORI.testo.rgb, label: COLORI.oro.rgb },
  },
  // Tessera chiara. Il logo resta com'e', i testi sono bordeaux.
  chiaro: {
    carta: '#fbf7f4',
    inchiostro: '#56343c',
    fascia: ['#efdde1', '#f9eef0'],
    logoChiaro: false,
    striscia: true,
    pass: { background: 'rgb(251, 247, 244)', foreground: 'rgb(86, 52, 60)', label: 'rgb(140, 106, 114)' },
  },
  // Nessuna striscia: solo il logo e il numero. Il Worker si accorge da solo
  // che manca e non la mette nel pacchetto.
  minimo: {
    carta: '#fbf7f4',
    inchiostro: '#56343c',
    fascia: null,
    logoChiaro: false,
    striscia: false,
    pass: { background: 'rgb(251, 247, 244)', foreground: 'rgb(86, 52, 60)', label: 'rgb(140, 106, 114)' },
  },
  // Tessera scura: fondo bordeaux, logo e testi in crema.
  scuro: {
    carta: '#56343c',
    inchiostro: '#fbf7f4',
    fascia: ['#452a31', '#66404a'],
    logoChiaro: true,
    striscia: true,
    pass: { background: 'rgb(86, 52, 60)', foreground: 'rgb(251, 247, 244)', label: 'rgb(214, 186, 192)' },
  },
};

// Il predefinito e' lo stile scelto per il negozio: rilanciare lo script
// senza argomenti deve riprodurre quel che gira in produzione, non un altro
// stile che poi finisce dentro i pass senza che nessuno se ne accorga.
const argStile = process.argv.includes('--stile')
  ? process.argv[process.argv.indexOf('--stile') + 1]
  : 'golosone';
const argDove = process.argv.includes('--dove')
  ? process.argv[process.argv.indexOf('--dove') + 1]
  : 'public';

const S = STILI[argStile];
if (!S) {
  console.error(`\nStile sconosciuto: ${argStile}. Disponibili: ${Object.keys(STILI).join(', ')}\n`);
  process.exit(1);
}

mkdirSync(`${argDove}/pass`, { recursive: true });

const meta = await sharp(ORIGINALE).metadata();
console.log(`origine: ${ORIGINALE}  ${meta.width}x${meta.height}  -  stile "${argStile}"`);
if (meta.width < 480) {
  console.warn(
    `\nAttenzione: il logo e' largo ${meta.width}px e va ingrandito fino a 480.\n` +
    `Il risultato sara' morbido. Con un SVG o un PNG grande verrebbe nitido.\n`,
  );
}

/**
 * Versione in negativo del logo: tiene la sagoma e ne cambia il colore.
 * Serve solo allo stile scuro, dove il bordeaux del logo sparirebbe dentro un
 * fondo dello stesso bordeaux.
 */
async function inchiostrato(larghezza, altezza) {
  const sagoma = sharp(ORIGINALE).ensureAlpha().resize(larghezza, altezza, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (!S.logoChiaro) return sagoma.png({ compressionLevel: 9 }).toBuffer();

  const alpha = await sagoma.clone().extractChannel('alpha').toBuffer();
  return sharp({
    create: { width: larghezza, height: altezza, channels: 3, background: S.inchiostro },
  })
    .joinChannel(alpha)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Il logo su fondo pieno, quadrato: la forma che vuole Google. */
async function quadrato(lato) {
  const margine = Math.round(lato * (S.margine ?? 0.14));
  const dentro = await inchiostrato(lato - margine * 2, lato - margine * 2);
  return sharp({ create: { width: lato, height: lato, channels: 4, background: S.carta } })
    .composite([{ input: dentro, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Il logo dentro un rettangolo largo e trasparente: la forma di Apple. */
async function largo(w, h) {
  const dentro = await inchiostrato(Math.round(w * 0.92), Math.round(h * 0.86));
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: dentro, gravity: 'west' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * La striscia: la fascia dietro il numero dei punti.
 *
 * Il bordo inferiore e' smerlato, come la carta da pasticceria sotto i dolci.
 * E' l'unico ornamento, e sta in basso di proposito: sopra ci va il numero,
 * che e' la sola cosa che il cliente guarda davvero, e un disegno al centro lo
 * renderebbe illeggibile.
 *
 * Le mezzelune sono riempite col colore della CARTA, non di bianco: la
 * striscia sta incollata al fondo della tessera, e solo cosi' sembrano
 * ritagliate invece che disegnate sopra.
 */
async function striscia(w, h) {
  const raggio = h * 0.085;
  const passo = raggio * 2;
  const quanti = Math.ceil(w / passo) + 1;
  const y = h - raggio * 0.25;

  const smerli = Array.from({ length: quanti }, (_, i) =>
    `<circle cx="${(i * passo).toFixed(1)}" cy="${y.toFixed(1)}" r="${raggio.toFixed(1)}"/>`,
  ).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${S.fascia[0]}"/>
        <stop offset="1" stop-color="${S.fascia[1]}"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <g fill="${S.carta}">${smerli}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// ------------------------------------------------------------------ scrittura

const scritti = [];
const salva = (percorso, buf) => {
  writeFileSync(percorso, buf);
  scritti.push([percorso, `${(buf.length / 1024).toFixed(1)} kB`]);
};

// Google: quadrato e opaco, servito dalla CDN.
salva(`${argDove}/logo.png`, await quadrato(660));

// Google, il logo largo: prende il posto del cerchio in cima alla tessera, in
// alto a sinistra come il logo di Apple. Opaco come il quadrato, e con il
// marchio a sinistra: centrato resterebbe staccato dal bordo. La larghezza
// viene dalle proporzioni del marchio, perche' `inchiostrato` lo centra
// dentro il riquadro che gli si da'.
if (S.logoLargo) {
  const alto = 340;
  const dentro = await inchiostrato(Math.round((alto * meta.width) / meta.height), alto);
  salva(
    `${argDove}/logo-largo.png`,
    await sharp({ create: { width: 1280, height: 400, channels: 4, background: S.carta } })
      .composite([{ input: dentro, left: 40, top: 30 }])
      .flatten({ background: S.carta })
      .removeAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
} else {
  rmSync(`${argDove}/logo-largo.png`, { force: true });
}

// Apple: dentro il .pkpass ci vogliono i nomi con @2x e @3x, ma i FILE qui
// non li portano. La CDN di Cloudflare non serve una chiocciola cosi' com'e':
// risponde 307 e rimanda alla versione con %40, e un 307 il Worker lo scarta
// come immagine mancante - producendo un pass senza icona, che iOS rifiuta
// senza spiegare niente. La traduzione dei nomi sta in src/apple-wallet.ts.
salva(`${argDove}/pass/icon-1x.png`, await quadrato(29));
salva(`${argDove}/pass/icon-2x.png`, await quadrato(58));
salva(`${argDove}/pass/icon-3x.png`, await quadrato(87));

salva(`${argDove}/pass/logo-1x.png`, await largo(160, 50));
salva(`${argDove}/pass/logo-2x.png`, await largo(320, 100));
salva(`${argDove}/pass/logo-3x.png`, await largo(480, 150));

if (S.striscia) {
  salva(`${argDove}/pass/strip-1x.png`, await striscia(375, 123));
  salva(`${argDove}/pass/strip-2x.png`, await striscia(750, 246));
  salva(`${argDove}/pass/strip-3x.png`, await striscia(1125, 369));
} else {
  // Lo stile minimo non ha striscia: se ne restassero in giro di un altro
  // stile, il Worker le infilerebbe comunque nel pacchetto.
  for (const n of ['strip-1x.png', 'strip-2x.png', 'strip-3x.png']) {
    rmSync(`${argDove}/pass/${n}`, { force: true });
  }
  console.log('  (stile senza striscia: eventuali strip precedenti rimosse)');
}

console.log();
for (const [p, peso] of scritti) console.log(`  ${p.padEnd(30)} ${peso}`);
console.log(`
Da riportare in src/pass-comune.ts (lo stile golosone li prende gia' da li'):
  backgroundColor: '${S.pass.background}'
  foregroundColor: '${S.pass.foreground}'
  labelColor:      '${S.pass.label}'
`);
