import { generateCode, normalizePhone } from './codes.ts';

export type Env = {
  DB: D1Database;
  /** JSON del service account Google, come segreto del Worker (mai in database) */
  GOOGLE_WALLET_SA?: string;
  /** Certificato del Pass Type ID Apple con la sua chiave, idem: mai in database */
  APPLE_WALLET_CERT?: string;
  // La coppia certificato/chiave con cui la tessera e' stata provata
  // dall'app degli ordini: se c'e', vince sul pacchetto (src/apple-wallet.ts).
  APPLE_PASS_CERT?: string;
  APPLE_PASS_KEY?: string;
  APPLE_WWDR_CERT?: string;
  /**
   * I file di public/ visti dal codice.
   *
   * Servono le immagini da mettere DENTRO il .pkpass: la CDN le serve gia'
   * al browser, ma qui ne servono i byte, e leggerli dal binding evita di
   * uscire in rete verso noi stessi.
   */
  ASSETS?: Fetcher;
};

export type Customer = {
  id: number;
  code: string;
  first_name: string | null;   // NULL = tessera vergine, mai consegnata
  last_name: string | null;
  activated_at: number | null;
  batch: string | null;
  phone: string | null;
  points_balance: number;
  points_lifetime: number;
  active: number;
  created_at: number;
  last_seen_at: number | null;
};

// ---------------------------------------------------------------- settings

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function getSettingInt(db: D1Database, key: string, fallback: number): Promise<number> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  const n = row ? Number.parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export async function setSetting(db: D1Database, key: string, value: string) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    )
    .bind(key, value)
    .run();
}

// --------------------------------------------------------------- customers

const CUSTOMER_COLS = `id, code, first_name, last_name, activated_at, batch, phone,
                       points_balance, points_lifetime, active, created_at, last_seen_at`;

export function findByCode(db: D1Database, code: string) {
  return db
    .prepare(`SELECT ${CUSTOMER_COLS} FROM customers WHERE code = ? AND active = 1`)
    .bind(code)
    .first<Customer>();
}

export function findById(db: D1Database, id: number) {
  return db
    .prepare(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = ?`)
    .bind(id)
    .first<Customer>();
}

export async function searchCustomers(db: D1Database, input: { phone?: string; name?: string }) {
  if (input.phone) {
    const { results } = await db
      .prepare(`SELECT ${CUSTOMER_COLS} FROM customers WHERE phone_norm = ? AND active = 1 AND activated_at IS NOT NULL LIMIT 10`)
      .bind(normalizePhone(input.phone))
      .all<Customer>();
    return results;
  }
  if (input.name) {
    const like = `%${input.name.replace(/[%_]/g, '')}%`;
    const { results } = await db
      .prepare(
        `SELECT ${CUSTOMER_COLS} FROM customers
          WHERE active = 1 AND activated_at IS NOT NULL
            AND (first_name LIKE ?1 OR last_name LIKE ?1)
          ORDER BY last_seen_at DESC LIMIT 10`,
      )
      .bind(like)
      .all<Customer>();
    return results;
  }
  return [];
}

/** Ritenta se il codice generato esiste gia': probabilita' irrisoria, ma gestirla costa zero. */
export async function createCustomer(
  db: D1Database,
  data: { firstName: string; lastName?: string; phone?: string; consent?: boolean; storeId?: number },
): Promise<Customer> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const row = await db
        .prepare(
          `INSERT INTO customers (code, store_id, first_name, last_name, phone, phone_norm,
                                  marketing_consent, consent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${CUSTOMER_COLS}`,
        )
        .bind(
          code,
          data.storeId ?? 1,
          data.firstName.trim(),
          data.lastName?.trim() || null,
          data.phone?.trim() || null,
          data.phone ? normalizePhone(data.phone) : null,
          data.consent ? 1 : 0,
          data.consent ? Math.floor(Date.now() / 1000) : null,
        )
        .first<Customer>();
      if (row) return row;
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err; // collisione sul codice: riprova
    }
  }
  throw new Error('Impossibile generare un codice tessera libero');
}

// ------------------------------------------------------------- transazioni

export type MoveResult = { customer: Customer; transactionId: number };

/**
 * Assegna punti.
 *
 * Scrive il movimento e aggiorna il saldo in un'unica transazione D1,
 * condizionata al saldo di partenza (lock ottimistico). Se un'altra sessione
 * ha toccato lo stesso cliente non si applica NULLA delle due e si ritenta:
 * mai un movimento a registro senza il saldo corrispondente, mai un saldo
 * cambiato senza il movimento che lo spiega.
 */
export async function addPoints(
  db: D1Database,
  args: { customerId: number; storeId: number; points: number; note?: string },
): Promise<MoveResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await findById(db, args.customerId);
    if (!before) throw new Error('Cliente non trovato');
    if (!before.active) throw new Error('Tessera disattivata');
    // Una tessera ancora nella scatola non ha un intestatario: assegnarle punti
    // significherebbe quasi sempre aver scansionato il cartoncino sbagliato.
    if (!before.activated_at) throw new Error('Tessera non ancora attivata: registra prima il cliente');

    const [inserted, updated] = await db.batch([
      db
        .prepare(
          `INSERT INTO transactions (customer_id, store_id, kind, points_delta, note)
           SELECT ?, ?, 'earn', ?, ?
            WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND points_balance = ?)`,
        )
        .bind(args.customerId, args.storeId, args.points, args.note ?? null, args.customerId, before.points_balance),
      db
        .prepare(
          `UPDATE customers
              SET points_balance  = points_balance + ?,
                  points_lifetime = points_lifetime + ?,
                  last_seen_at    = unixepoch()
            WHERE id = ? AND points_balance = ?`,
        )
        .bind(args.points, args.points, args.customerId, before.points_balance),
    ]);

    if (updated.meta.changes === 1) {
      return {
        customer: (await findById(db, args.customerId))!,
        transactionId: Number(inserted.meta.last_row_id),
      };
    }
  }
  throw new Error("Tessera occupata da un'altra sessione, riprova");
}

export async function redeemReward(
  db: D1Database,
  args: { customerId: number; storeId: number; rewardId: number },
) {
  const reward = await db
    .prepare('SELECT id, name, points_cost FROM rewards WHERE id = ? AND active = 1')
    .bind(args.rewardId)
    .first<{ id: number; name: string; points_cost: number }>();
  if (!reward) throw new Error('Premio non disponibile');

  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await findById(db, args.customerId);
    if (!before) throw new Error('Cliente non trovato');
    if (before.points_balance < reward.points_cost) throw new Error('Punti insufficienti');

    const [inserted, updated] = await db.batch([
      db
        .prepare(
          `INSERT INTO transactions (customer_id, store_id, kind, points_delta, reward_id, note)
           SELECT ?, ?, 'redeem', ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND points_balance = ?)`,
        )
        .bind(
          args.customerId,
          args.storeId,
          -reward.points_cost,
          reward.id,
          reward.name,
          args.customerId,
          before.points_balance,
        ),
      db
        .prepare(
          `UPDATE customers SET points_balance = points_balance - ?, last_seen_at = unixepoch()
            WHERE id = ? AND points_balance = ?`,
        )
        .bind(reward.points_cost, args.customerId, before.points_balance),
    ]);

    if (updated.meta.changes === 1) {
      return {
        customer: (await findById(db, args.customerId))!,
        reward,
        transactionId: Number(inserted.meta.last_row_id),
      };
    }
  }
  throw new Error("Tessera occupata da un'altra sessione, riprova");
}

/**
 * Annulla un movimento recente. Non cancella nulla: marca la riga come
 * annullata e rimette a posto il saldo, cosi' resta visibile che c'e' stata
 * una correzione invece di far sparire il movimento.
 */
export async function voidTransaction(
  db: D1Database,
  args: { transactionId: number; windowMinutes: number },
) {
  const tx = await db
    .prepare('SELECT id, customer_id, kind, points_delta, voided_at, created_at FROM transactions WHERE id = ?')
    .bind(args.transactionId)
    .first<{
      id: number;
      customer_id: number;
      kind: string;
      points_delta: number;
      voided_at: number | null;
      created_at: number;
    }>();
  if (!tx) throw new Error('Movimento non trovato');
  if (tx.voided_at) throw new Error('Movimento già annullato');

  const ageMinutes = (Math.floor(Date.now() / 1000) - tx.created_at) / 60;
  if (ageMinutes > args.windowMinutes) {
    throw new Error(`Si può annullare solo entro ${args.windowMinutes} minuti`);
  }

  const [voided] = await db.batch([
    db
      .prepare('UPDATE transactions SET voided_at = unixepoch() WHERE id = ? AND voided_at IS NULL')
      .bind(tx.id),
    db
      .prepare(
        `UPDATE customers
            SET points_balance  = points_balance - ?,
                points_lifetime = points_lifetime - ?
          WHERE id = ?`,
      )
      // points_lifetime conta solo i punti guadagnati: un riscatto annullato
      // non deve gonfiarlo indietro.
      .bind(tx.points_delta, tx.points_delta > 0 ? tx.points_delta : 0, tx.customer_id),
  ]);
  if (voided.meta.changes !== 1) throw new Error('Annullamento non riuscito');
  return (await findById(db, tx.customer_id))!;
}

export async function customerHistory(db: D1Database, customerId: number, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.kind, t.points_delta, t.note, t.created_at, t.voided_at,
              r.name AS reward_name
         FROM transactions t
         LEFT JOIN rewards r ON r.id = t.reward_id
        WHERE t.customer_id = ?
        ORDER BY t.id DESC LIMIT ?`,
    )
    .bind(customerId, limit)
    .all();
  return results;
}

export async function listRewards(db: D1Database, storeId = 1) {
  const { results } = await db
    .prepare(
      `SELECT id, name, description, points_cost FROM rewards
        WHERE store_id = ? AND active = 1 ORDER BY sort_order, points_cost`,
    )
    .bind(storeId)
    .all<{ id: number; name: string; description: string | null; points_cost: number }>();
  return results;
}

// ------------------------------------------------------- lotti di tessere

/**
 * Crea un lotto di tessere vergini.
 *
 * Le tessere si stampano prima e stanno in una scatola alla cassa: non si puo'
 * stampare un cartoncino mentre il cliente aspetta. Finche' non vengono
 * consegnate non hanno intestatario.
 *
 * Il `batch` serve a ristampare un foglio che si e' rovinato senza generare
 * codici nuovi e senza sprecare quelli gia' stampati.
 */
export async function createCardBatch(
  db: D1Database,
  args: { count: number; storeId?: number },
): Promise<{ batch: string; cards: Customer[] }> {
  const count = Math.floor(args.count);
  if (!Number.isFinite(count) || count < 1) throw new Error('Quante tessere?');
  if (count > 200) throw new Error('Massimo 200 tessere per volta');

  const batch = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const storeId = args.storeId ?? 1;
  const cards: Customer[] = [];

  // Una INSERT per tessera invece di una sola multipla: cosi' una collisione
  // di codice (rarissima) fa ritentare quella singola e non butta il lotto.
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 5 && !placed; attempt++) {
      try {
        const row = await db
          .prepare(
            `INSERT INTO customers (code, store_id, batch) VALUES (?, ?, ?)
             RETURNING ${CUSTOMER_COLS}`,
          )
          .bind(generateCode(), storeId, batch)
          .first<Customer>();
        if (row) {
          cards.push(row);
          placed = true;
        }
      } catch (err) {
        if (!String(err).includes('UNIQUE')) throw err;
      }
    }
    if (!placed) throw new Error('Impossibile generare un codice tessera libero');
  }
  return { batch, cards };
}

/** Consegna della tessera: da vergine a intestata. */
export async function activateCard(
  db: D1Database,
  args: { customerId: number; firstName: string; lastName?: string; phone?: string; consent?: boolean },
): Promise<Customer> {
  const card = await findById(db, args.customerId);
  if (!card) throw new Error('Tessera non trovata');
  if (card.activated_at) throw new Error('Tessera già intestata');
  if (!args.firstName?.trim()) throw new Error('Il nome è obbligatorio');

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE customers
          SET first_name = ?, last_name = ?, phone = ?, phone_norm = ?,
              marketing_consent = ?, consent_at = ?, activated_at = ?, last_seen_at = ?
        WHERE id = ? AND activated_at IS NULL`,
    )
    .bind(
      args.firstName.trim(),
      args.lastName?.trim() || null,
      args.phone?.trim() || null,
      args.phone ? normalizePhone(args.phone) : null,
      args.consent ? 1 : 0,
      args.consent ? now : null,
      now,
      now,
      args.customerId,
    )
    .run();
  return (await findById(db, args.customerId))!;
}

export async function listBatch(db: D1Database, batch: string) {
  const { results } = await db
    .prepare(
      `SELECT ${CUSTOMER_COLS} FROM customers WHERE batch = ? ORDER BY id`,
    )
    .bind(batch)
    .all<Customer>();
  return results;
}

export async function listBatches(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT batch,
              COUNT(*) AS totale,
              SUM(CASE WHEN activated_at IS NULL THEN 1 ELSE 0 END) AS vergini
         FROM customers
        WHERE batch IS NOT NULL
        GROUP BY batch
        ORDER BY batch DESC
        LIMIT 30`,
    )
    .all<{ batch: string; totale: number; vergini: number }>();
  return results;
}

// ------------------------------------------------------------- report

/**
 * Giorno civile di un istante, nel fuso del negozio.
 *
 * I Worker girano in UTC: raggruppare con date(created_at,'unixepoch') in SQL
 * spezzerebbe la giornata alle 2 del mattino ora italiana, e d'estate alle 3.
 * Il raggruppamento si fa qui con Intl, che l'ora legale la sa gestire.
 */
export function dayKey(tsSeconds: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(tsSeconds * 1000));
}

/**
 * Scarto in secondi fra il fuso del negozio e UTC in questo istante.
 * Ricavato da Intl e non da una costante, cosi' l'ora legale si sistema da se'.
 */
export function tzOffsetSeconds(tz: string, at: Date = new Date()): number {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(at);
  return Math.round((Date.parse(s.replace(' ', 'T') + 'Z') - at.getTime()) / 1000);
}

export type DayRow = { day: string; points: number; rewards: number; activations: number };

/**
 * Serie giornaliera degli ultimi N giorni.
 *
 * Si leggono le righe grezze e si raggruppa in JavaScript invece di far
 * aggregare SQLite: per una pasticceria sono poche centinaia di movimenti al
 * giorno, e in cambio il fuso orario resta corretto.
 */
export async function reportSeries(
  db: D1Database,
  args: { days: number; tz: string },
): Promise<DayRow[]> {
  const now = Math.floor(Date.now() / 1000);
  // un giorno di margine: il confine civile non coincide con quello UTC
  const since = now - (args.days + 1) * 86400;

  const [tx, acts] = await Promise.all([
    db
      .prepare(
        `SELECT kind, points_delta, created_at FROM transactions
          WHERE created_at >= ? AND voided_at IS NULL`,
      )
      .bind(since)
      .all<{ kind: string; points_delta: number; created_at: number }>(),
    db
      .prepare('SELECT activated_at FROM customers WHERE activated_at >= ?')
      .bind(since)
      .all<{ activated_at: number }>(),
  ]);

  const buckets = new Map<string, DayRow>();
  // Si parte dai giorni vuoti: un giorno senza movimenti deve comparire come
  // zero nel grafico, non sparire lasciando un buco nella sequenza.
  for (let i = args.days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400, args.tz);
    buckets.set(day, { day, points: 0, rewards: 0, activations: 0 });
  }

  for (const t of tx.results) {
    const b = buckets.get(dayKey(t.created_at, args.tz));
    if (!b) continue;
    if (t.kind === 'redeem') b.rewards += 1;
    else if (t.points_delta > 0) b.points += t.points_delta;
  }
  for (const a of acts.results) {
    const b = buckets.get(dayKey(a.activated_at, args.tz));
    if (b) b.activations += 1;
  }
  return [...buckets.values()];
}

export type Totals = {
  points: number;
  rewards: number;
  activations: number;
  activeCustomers: number;
};

export async function reportTotals(db: D1Database, sinceTs: number): Promise<Totals> {
  const tx = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN points_delta > 0 THEN points_delta ELSE 0 END), 0) AS points,
         COALESCE(SUM(CASE WHEN kind = 'redeem' THEN 1 ELSE 0 END), 0)             AS rewards,
         COUNT(DISTINCT customer_id)                                               AS clienti
       FROM transactions
       WHERE created_at >= ? AND voided_at IS NULL`,
    )
    .bind(sinceTs)
    .first<{ points: number; rewards: number; clienti: number }>();

  const act = await db
    .prepare('SELECT COUNT(*) AS n FROM customers WHERE activated_at >= ?')
    .bind(sinceTs)
    .first<{ n: number }>();

  return {
    points: tx?.points ?? 0,
    rewards: tx?.rewards ?? 0,
    activations: act?.n ?? 0,
    activeCustomers: tx?.clienti ?? 0,
  };
}

/** Quante tessere restano nella scatola, per accorgersene prima che finiscano. */
export async function cardStock(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN activated_at IS NULL THEN 1 ELSE 0 END), 0) AS vergini,
         COALESCE(SUM(CASE WHEN activated_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS consegnate
       FROM customers`,
    )
    .first<{ vergini: number; consegnate: number }>();
  return { blank: row?.vergini ?? 0, handed: row?.consegnate ?? 0 };
}

/** Clienti con piu' punti: serve al titolare per sapere chi sta per ritirare. */
export async function topCustomers(db: D1Database, limit = 15) {
  const { results } = await db
    .prepare(
      `SELECT ${CUSTOMER_COLS} FROM customers
        WHERE active = 1 AND activated_at IS NOT NULL
        ORDER BY points_balance DESC, points_lifetime DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<Customer>();
  return results;
}

/** Tessera persa o clonata: si disattiva, non si cancella (il registro resta). */
export async function setCustomerActive(db: D1Database, customerId: number, active: boolean) {
  await db
    .prepare('UPDATE customers SET active = ? WHERE id = ?')
    .bind(active ? 1 : 0, customerId)
    .run();
  return (await findById(db, customerId))!;
}

// ------------------------------------------------------------- premi (CRUD)

export async function upsertReward(
  db: D1Database,
  args: { id?: number; name: string; description?: string; pointsCost: number; active?: boolean; storeId?: number },
) {
  if (!args.name?.trim()) throw new Error('Serve il nome del premio');
  if (!Number.isInteger(args.pointsCost) || args.pointsCost < 1) {
    throw new Error('I punti del premio sono un intero positivo');
  }
  if (args.id) {
    await db
      .prepare('UPDATE rewards SET name = ?, description = ?, points_cost = ?, active = ? WHERE id = ?')
      .bind(args.name.trim(), args.description?.trim() || null, args.pointsCost, args.active === false ? 0 : 1, args.id)
      .run();
    return args.id;
  }
  const row = await db
    .prepare(
      `INSERT INTO rewards (store_id, name, description, points_cost, active)
       VALUES (?, ?, ?, ?, 1) RETURNING id`,
    )
    .bind(args.storeId ?? 1, args.name.trim(), args.description?.trim() || null, args.pointsCost)
    .first<{ id: number }>();
  return row!.id;
}

/** Tutti i premi, disattivati compresi: il titolare li deve poter riattivare. */
export async function listAllRewards(db: D1Database, storeId = 1) {
  const { results } = await db
    .prepare(
      `SELECT id, name, description, points_cost, active FROM rewards
        WHERE store_id = ? ORDER BY active DESC, sort_order, points_cost`,
    )
    .bind(storeId)
    .all<{ id: number; name: string; description: string | null; points_cost: number; active: number }>();
  return results;
}

// ============================================================= pass Apple

/**
 * Registra un pass su un telefono.
 *
 * Il token di push si riscrive sempre: Apple lo cambia nel tempo, e tenersi
 * quello vecchio significa mandare notifiche nel vuoto senza accorgersene.
 */
export async function registerAppleDevice(
  db: D1Database,
  deviceLibraryId: string,
  pushToken: string,
  serialNumber: string,
): Promise<'creata' | 'gia-presente'> {
  await db
    .prepare(
      `INSERT INTO apple_devices (device_library_id, push_token) VALUES (?, ?)
         ON CONFLICT(device_library_id) DO UPDATE SET push_token = excluded.push_token`,
    )
    .bind(deviceLibraryId, pushToken)
    .run();

  const esisteva = await db
    .prepare('SELECT 1 AS ok FROM apple_registrations WHERE device_library_id = ? AND serial_number = ?')
    .bind(deviceLibraryId, serialNumber)
    .first<{ ok: number }>();
  if (esisteva) return 'gia-presente';

  await db
    .prepare('INSERT INTO apple_registrations (device_library_id, serial_number) VALUES (?, ?)')
    .bind(deviceLibraryId, serialNumber)
    .run();
  return 'creata';
}

/** Il telefono non vuole piu' quel pass. Se non gliene resta nessuno, sparisce anche il dispositivo. */
export async function unregisterAppleDevice(
  db: D1Database,
  deviceLibraryId: string,
  serialNumber: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM apple_registrations WHERE device_library_id = ? AND serial_number = ?')
    .bind(deviceLibraryId, serialNumber)
    .run();
  await db
    .prepare(
      `DELETE FROM apple_devices WHERE device_library_id = ?
        AND NOT EXISTS (SELECT 1 FROM apple_registrations WHERE device_library_id = ?)`,
    )
    .bind(deviceLibraryId, deviceLibraryId)
    .run();
}

/**
 * I pass di questo telefono cambiati dopo `since`.
 *
 * "Quando e' cambiata" una tessera non e' un campo: si ricava dal registro,
 * che e' append-only e quindi sa sempre dire quando e' successo l'ultimo
 * movimento. L'annullo conta come cambiamento, altrimenti un pass annullato
 * resterebbe col saldo vecchio nel telefono.
 */
export async function appleUpdatedSerials(
  db: D1Database,
  deviceLibraryId: string,
  since: number | null,
): Promise<{ serials: string[]; lastUpdated: number }> {
  const { results } = await db
    .prepare(
      `SELECT r.serial_number AS code,
              MAX(
                COALESCE(c.activated_at, 0),
                COALESCE((SELECT MAX(COALESCE(t.voided_at, t.created_at))
                            FROM transactions t WHERE t.customer_id = c.id), 0)
              ) AS tag
         FROM apple_registrations r
         JOIN customers c ON c.code = r.serial_number
        WHERE r.device_library_id = ?`,
    )
    .bind(deviceLibraryId)
    .all<{ code: string; tag: number }>();

  const serials = results.filter((r) => since === null || r.tag > since).map((r) => r.code);
  const lastUpdated = results.reduce((max, r) => Math.max(max, r.tag), since ?? 0);
  return { serials, lastUpdated };
}

/** I telefoni da svegliare quando cambia il saldo di una tessera. */
export async function applePushTokens(db: D1Database, serialNumber: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT d.push_token FROM apple_registrations r
         JOIN apple_devices d ON d.device_library_id = r.device_library_id
        WHERE r.serial_number = ?`,
    )
    .bind(serialNumber)
    .all<{ push_token: string }>();
  return results.map((r) => r.push_token);
}

/** Toglie i dispositivi che APNs non riconosce piu': le registrazioni cadono con loro. */
export async function forgetApplePushTokens(db: D1Database, tokens: string[]): Promise<void> {
  for (const t of tokens) {
    await db.prepare('DELETE FROM apple_registrations WHERE device_library_id IN (SELECT device_library_id FROM apple_devices WHERE push_token = ?)').bind(t).run();
    await db.prepare('DELETE FROM apple_devices WHERE push_token = ?').bind(t).run();
  }
}
