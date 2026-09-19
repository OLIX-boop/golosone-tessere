/**
 * ZIP minimo, solo scrittura.
 *
 * Un .pkpass e' un archivio ZIP: dentro ci sono pass.json, le immagini, il
 * manifesto e la firma. Serve saperlo produrre dentro un Worker, dove non
 * esiste un comando `zip` da invocare.
 *
 * Si scrive SENZA comprimere (metodo "stored"). Le ragioni:
 *   * un pass pesa poche decine di KB, di cui quasi tutto e' PNG, che e' gia'
 *     compresso: sgonfiarlo ancora non guadagna niente;
 *   * togliere il deflate toglie anche l'unico pezzo che potrebbe comportarsi
 *     diversamente fra il runtime locale e quello di Cloudflare. Un pass
 *     malformato iOS lo rifiuta in silenzio, senza dire perche': conviene
 *     avere meno cose che possano sbagliarsi.
 *
 * L'ordine dei file nell'archivio e' quello in cui vengono passati, e la data
 * e' fissa: due pass con lo stesso contenuto producono gli stessi byte. Serve
 * ai test, che altrimenti dovrebbero ignorare il timestamp.
 */

export type ZipEntry = { name: string; data: Uint8Array };

/** Data fissa (1 gennaio 2024) in formato DOS: mantiene l'output ripetibile. */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Scrittore sequenziale: evita di concatenare venti Uint8Array a mano. */
class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;

  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }
  u16(n: number): void {
    this.bytes(new Uint8Array([n & 0xff, (n >>> 8) & 0xff]));
  }
  u32(n: number): void {
    this.bytes(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }
  get offset(): number {
    return this.len;
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.len);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const w = new Writer();
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    central.push({ name, crc, size: e.data.length, offset: w.offset });

    w.u32(0x04034b50); // intestazione del file
    w.u16(20);         // versione minima per estrarre: 2.0
    w.u16(0);          // nessun flag: niente cifratura, dimensioni note in anticipo
    w.u16(0);          // metodo 0 = nessuna compressione
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(crc);
    w.u32(e.data.length); // compressa e non compressa coincidono
    w.u32(e.data.length);
    w.u16(name.length);
    w.u16(0);          // nessun campo extra
    w.bytes(name);
    w.bytes(e.data);
  }

  // Indice finale: e' quello che un lettore ZIP consulta per primo.
  const dirStart = w.offset;
  for (const c of central) {
    w.u32(0x02014b50);
    w.u16(20);         // versione di chi ha scritto
    w.u16(20);         // versione minima per leggere
    w.u16(0);
    w.u16(0);
    w.u16(DOS_TIME);
    w.u16(DOS_DATE);
    w.u32(c.crc);
    w.u32(c.size);
    w.u32(c.size);
    w.u16(c.name.length);
    w.u16(0);          // extra
    w.u16(0);          // commento
    w.u16(0);          // numero del disco: archivio singolo
    w.u16(0);          // attributi interni
    w.u32(0);          // attributi esterni
    w.u32(c.offset);
    w.bytes(c.name);
  }

  // La dimensione dell'indice si misura PRIMA di cominciare a scrivere il
  // blocco finale, altrimenti ci finiscono dentro anche i suoi stessi byte.
  const dirSize = w.offset - dirStart;

  w.u32(0x06054b50); // fine dell'indice
  w.u16(0);
  w.u16(0);
  w.u16(central.length);
  w.u16(central.length);
  w.u32(dirSize);
  w.u32(dirStart);
  w.u16(0);          // nessun commento

  return w.finish();
}
