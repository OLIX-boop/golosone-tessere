/**
 * Il marchio del Golosone ricolorato, per i loghi delle tessere.
 *
 * Si prende solo l'**alfa** del marchio — la sagoma con le sfumature dei
 * bordi — e la si mette sotto una tinta piatta: sostituire i pixel per
 * somiglianza di colore renderebbe il corsivo una scalinata.
 *
 * Sta in un modulo a parte perché lo usano sia i loghi di Google sia le
 * immagini di Apple, e importarlo da uno dei due script lo rilancerebbe.
 */
import sharp from 'sharp';

const MARCHIO = 'public/marchio.png';

/** Il marchio in `colore`, dentro `largo`x`alto` senza deformarlo. */
export async function marchioTinto(colore, { largo, alto }) {
  const sagoma = await sharp(MARCHIO)
    .resize({ width: largo, height: alto, fit: 'inside' })
    .ensureAlpha()
    .extractChannel('alpha')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = sagoma.info;
  return sharp({ create: { width, height, channels: 3, background: colore } })
    .joinChannel(sagoma.data, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
