import { generateCode, normalizePhone } from './codes.ts';

export type Env = { DB: D1Database };

export type Customer = {
  id: number;
  code: string;
  first_name: string;
  last_name: string | null;
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

const CUSTOMER_COLS = `id, code, first_name, last_name, phone, points_balance,
                       points_lifetime, active, created_at, last_seen_at`;

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
      .prepare(`SELECT ${CUSTOMER_COLS} FROM customers WHERE phone_norm = ? AND active = 1 LIMIT 10`)
      .bind(normalizePhone(input.phone))
      .all<Customer>();
    return results;
  }
  if (input.name) {
    const like = `%${input.name.replace(/[%_]/g, '')}%`;
    const { results } = await db
      .prepare(
        `SELECT ${CUSTOMER_COLS} FROM customers
          WHERE active = 1 AND (first_name LIKE ?1 OR last_name LIKE ?1)
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
  throw new Error('Tessera occupata da un altra sessione, riprova');
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
  throw new Error('Tessera occupata da un altra sessione, riprova');
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
  if (tx.voided_at) throw new Error('Movimento gia annullato');

  const ageMinutes = (Math.floor(Date.now() / 1000) - tx.created_at) / 60;
  if (ageMinutes > args.windowMinutes) {
    throw new Error(`Si puo annullare solo entro ${args.windowMinutes} minuti`);
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
