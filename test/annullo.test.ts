import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voidTransaction } from '../src/db.ts';

/**
 * Un D1 finto che risponde solo alle tre domande che fa `voidTransaction`.
 *
 * Qui non si prova SQLite, si provano le regole: chi puo' annullare cosa, e
 * quando conviene fermarsi. Sono le regole che fanno danno se sbagliate -
 * un saldo che va sotto zero non si recupera leggendo il registro.
 */
function dbFinto(stato: {
  tx: { id: number; customer_id: number; kind: string; points_delta: number; voided_at: number | null; created_at: number } | null;
  saldo: number;
}) {
  const scritture: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM transactions')) return stato.tx;
              if (sql.includes('points_balance FROM customers')) return { points_balance: stato.saldo };
              return { id: stato.tx?.customer_id, points_balance: stato.saldo };
            },
            sql,
          };
        },
      };
    },
    async batch(stmts: { sql: string }[]) {
      for (const s of stmts) scritture.push(s.sql);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
    scritture,
  };
  return db as unknown as D1Database & { scritture: string[] };
}

const adesso = Math.floor(Date.now() / 1000);
const movimento = (eta_minuti: number, delta = 5) => ({
  id: 7, customer_id: 1, kind: 'earn', points_delta: delta,
  voided_at: null, created_at: adesso - eta_minuti * 60,
});

test('in cassa un movimento di ieri non si annulla', async () => {
  const db = dbFinto({ tx: movimento(60 * 26), saldo: 10 });
  await assert.rejects(
    () => voidTransaction(db, { transactionId: 7, windowMinutes: 30 }),
    /entro 30 minuti/,
  );
});

test('il titolare annulla anche un movimento di ieri', async () => {
  const db = dbFinto({ tx: movimento(60 * 26), saldo: 10 });
  await voidTransaction(db, { transactionId: 7, windowMinutes: null });
  assert.equal(db.scritture.length, 2, 'doveva marcare il movimento e correggere il saldo');
});

test('punti gia spesi non si tolgono: il saldo resterebbe sotto zero', async () => {
  // Cinque punti dati per sbaglio, poi spesi tutti: il saldo e' 2.
  const db = dbFinto({ tx: movimento(60 * 26), saldo: 2 });
  await assert.rejects(
    () => voidTransaction(db, { transactionId: 7, windowMinutes: null }),
    /sotto zero/,
  );
  assert.equal(db.scritture.length, 0, 'non doveva scrivere niente');
});

test('annullare un riscatto restituisce i punti, e il saldo non puo scendere', async () => {
  const db = dbFinto({ tx: { ...movimento(60 * 26), kind: 'redeem', points_delta: -30 }, saldo: 0 });
  await voidTransaction(db, { transactionId: 7, windowMinutes: null });
  assert.equal(db.scritture.length, 2);
});

test('un movimento gia annullato non si annulla due volte', async () => {
  const db = dbFinto({ tx: { ...movimento(1), voided_at: adesso }, saldo: 10 });
  await assert.rejects(
    () => voidTransaction(db, { transactionId: 7, windowMinutes: null }),
    /già annullato/,
  );
});
