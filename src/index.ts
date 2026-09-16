import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionToken,
  hashPin,
  randomHex,
  sessionCookie,
  sha256Hex,
  verifyPin,
} from './auth.ts';
import { isValidCode, normalizeCode, parseInput } from './codes.ts';
import { formatCents, parseAmountToCents } from './points.ts';
import {
  awardPoints,
  createCustomer,
  customerHistory,
  findByCode,
  getSettingInt,
  getSettings,
  listRewards,
  redeemReward,
  searchCustomers,
  voidTransaction,
  type Customer,
  type Env,
  type Operator,
} from './db.ts';

type Vars = { operator: Operator };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const isSecure = (url: string) => new URL(url).protocol === 'https:';
/** Corpo di errore uniforme. Lo status HTTP viaggia dove deve, non dentro il JSON. */
const fail = (message: string) => ({ ok: false as const, error: message });

// ============================================================ autenticazione

async function currentOperator(c: { env: Env; req: { raw: Request } }): Promise<Operator | null> {
  const token = getCookie(c as never, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.role, o.store_id
       FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch() AND o.active = 1`,
  )
    .bind(await sha256Hex(token))
    .first<Operator>();
  return row ?? null;
}

/** Protegge tutto cio' che modifica i punti. La pagina cliente resta pubblica. */
const requireOperator = async (c: any, next: () => Promise<void>) => {
  const op = await currentOperator(c);
  if (!op) return c.json({ ok: false, error: 'Sessione scaduta, rientra col PIN' }, 401);
  c.set('operator', op);
  await next();
};

const requireAdmin = async (c: any, next: () => Promise<void>) => {
  if (c.get('operator').role !== 'admin') {
    return c.json({ ok: false, error: 'Serve un account titolare' }, 403);
  }
  await next();
};

// ------------------------------------------------- primo avvio / operatori

app.get('/api/bootstrap', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM operators').first<{ n: number }>();
  const settings = await getSettings(c.env.DB);
  const { results: operators } = await c.env.DB.prepare(
    'SELECT id, name, role FROM operators WHERE active = 1 ORDER BY name',
  ).all();
  return c.json({
    ok: true,
    needsSetup: (row?.n ?? 0) === 0,
    storeName: settings.store_name ?? 'Pasticceria',
    centsPerPoint: Number(settings.cents_per_point ?? 500),
    operators,
    me: await currentOperator(c),
  });
});

/** Creazione del primo titolare. Funziona solo finche' non esiste alcun operatore. */
app.post('/api/setup', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM operators').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return c.json(fail('Configurazione gia completata'), 409);

  const { name, pin } = await c.req.json<{ name?: string; pin?: string }>();
  if (!name?.trim()) return c.json(fail('Serve il nome'), 400);
  if (!pin || !/^\d{4,8}$/.test(pin)) return c.json(fail('Il PIN deve avere da 4 a 8 cifre'), 400);

  const salt = randomHex(16);
  await c.env.DB.prepare(
    `INSERT INTO operators (store_id, name, pin_hash, pin_salt, role) VALUES (1, ?, ?, ?, 'admin')`,
  )
    .bind(name.trim(), await hashPin(pin, salt), salt)
    .run();
  return c.json({ ok: true });
});

app.post('/api/login', async (c) => {
  const { operatorId, pin } = await c.req.json<{ operatorId?: number; pin?: string }>();
  if (!operatorId || !pin) return c.json(fail('Seleziona operatore e inserisci il PIN'), 400);

  const op = await c.env.DB.prepare(
    'SELECT id, name, role, store_id, pin_hash, pin_salt FROM operators WHERE id = ? AND active = 1',
  )
    .bind(operatorId)
    .first<Operator & { pin_hash: string; pin_salt: string }>();

  // Messaggio identico in entrambi i rami: non diciamo se l'operatore esiste.
  if (!op || !(await verifyPin(pin, op.pin_salt, op.pin_hash))) {
    return c.json(fail('PIN errato'), 401);
  }

  const session = await createSessionToken();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < unixepoch()'),
    c.env.DB.prepare('INSERT INTO sessions (token_hash, operator_id, expires_at) VALUES (?, ?, ?)').bind(
      session.tokenHash,
      op.id,
      session.expiresAt,
    ),
  ]);

  c.header('Set-Cookie', sessionCookie(session.token, isSecure(c.req.url)));
  return c.json({ ok: true, operator: { id: op.id, name: op.name, role: op.role, store_id: op.store_id } });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  c.header('Set-Cookie', clearSessionCookie(isSecure(c.req.url)));
  return c.json({ ok: true });
});

// ==================================================================== cassa

app.use('/api/cassa/*', requireOperator);

/**
 * Campo unico della cassa: accetta la scansione della tessera, il codice
 * digitato a mano, il numero di telefono o il nome. L'operatore non deve
 * scegliere niente, incolla e basta.
 */
app.get('/api/cassa/lookup', async (c) => {
  const parsed = parseInput(c.req.query('q') ?? '');
  if (parsed.type === 'empty') return c.json(fail('Scansiona la tessera o cerca il cliente'), 400);

  if (parsed.type === 'code') {
    const code = normalizeCode(parsed.value);
    if (!isValidCode(code)) return c.json(fail('Codice tessera non valido'), 404);
    const customer = await findByCode(c.env.DB, code);
    if (!customer) return c.json(fail('Tessera non trovata'), 404);
    return c.json({ ok: true, match: 'exact', customer, history: await customerHistory(c.env.DB, customer.id, 5) });
  }

  const matches = await searchCustomers(
    c.env.DB,
    parsed.type === 'phone' ? { phone: parsed.value } : { name: parsed.value },
  );
  if (matches.length === 0) return c.json(fail('Nessun cliente trovato'), 404);
  if (matches.length === 1) {
    return c.json({ ok: true, match: 'exact', customer: matches[0], history: await customerHistory(c.env.DB, matches[0].id, 5) });
  }
  return c.json({ ok: true, match: 'multiple', customers: matches });
});

app.post('/api/cassa/customers', async (c) => {
  const body = await c.req.json<{ firstName?: string; lastName?: string; phone?: string; consent?: boolean }>();
  if (!body.firstName?.trim()) return c.json(fail('Il nome e obbligatorio'), 400);

  const customer = await createCustomer(c.env.DB, {
    firstName: body.firstName,
    lastName: body.lastName,
    phone: body.phone,
    consent: body.consent,
    storeId: c.get('operator').store_id,
  });
  return c.json({ ok: true, customer });
});

app.post('/api/cassa/award', async (c) => {
  const op = c.get('operator');
  const body = await c.req.json<{ customerId?: number; amount?: string }>();
  if (!body.customerId) return c.json(fail('Cliente mancante'), 400);

  const amountCents = parseAmountToCents(body.amount ?? '');
  if (amountCents === null) return c.json(fail('Importo non valido'), 400);
  if (amountCents === 0) return c.json(fail('Importo a zero'), 400);

  // Tetto anti-errore di battitura: 250 EUR digitati per sbaglio come 25000
  // sono un regalo da 50 punti che nessuno si accorge di aver fatto.
  const maxCents = await getSettingInt(c.env.DB, 'max_amount_cents', 50_000);
  if (amountCents > maxCents) {
    return c.json(fail(`Importo oltre il massimo di ${formatCents(maxCents)} EUR: correggi o chiedi al titolare`), 400);
  }

  const centsPerPoint = await getSettingInt(c.env.DB, 'cents_per_point', 500);
  try {
    const result = await awardPoints(c.env.DB, {
      customerId: body.customerId,
      operatorId: op.id,
      storeId: op.store_id,
      amountCents,
      centsPerPoint,
    });
    return c.json({ ok: true, ...result, amountCents });
  } catch (err) {
    return c.json(fail(String((err as Error).message)), 400);
  }
});

app.post('/api/cassa/redeem', async (c) => {
  const op = c.get('operator');
  const body = await c.req.json<{ customerId?: number; rewardId?: number }>();
  if (!body.customerId || !body.rewardId) return c.json(fail('Dati mancanti'), 400);
  try {
    const result = await redeemReward(c.env.DB, {
      customerId: body.customerId,
      operatorId: op.id,
      storeId: op.store_id,
      rewardId: body.rewardId,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json(fail(String((err as Error).message)), 400);
  }
});

app.post('/api/cassa/void', async (c) => {
  const op = c.get('operator');
  const { transactionId } = await c.req.json<{ transactionId?: number }>();
  if (!transactionId) return c.json(fail('Movimento mancante'), 400);
  try {
    const customer = await voidTransaction(c.env.DB, {
      transactionId,
      operatorId: op.id,
      windowMinutes: await getSettingInt(c.env.DB, 'void_window_min', 15),
      centsPerPoint: await getSettingInt(c.env.DB, 'cents_per_point', 500),
    });
    return c.json({ ok: true, customer });
  } catch (err) {
    return c.json(fail(String((err as Error).message)), 400);
  }
});

app.get('/api/cassa/rewards', async (c) => {
  return c.json({ ok: true, rewards: await listRewards(c.env.DB, c.get('operator').store_id) });
});

app.get('/api/cassa/history', async (c) => {
  const id = Number(c.req.query('customerId'));
  if (!id) return c.json(fail('Cliente mancante'), 400);
  return c.json({ ok: true, history: await customerHistory(c.env.DB, id, 20) });
});

// =========================================================== pagina cliente

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/**
 * Pagina pubblica del cliente, resa direttamente dal server.
 *
 * Deliberatamente povera di dati: nome di battesimo, saldo, movimenti.
 * Niente cognome, telefono o email, perche' chi conosce il link vede questa
 * pagina. E' sola lettura: assegnare punti passa da rotte che richiedono la
 * sessione operatore.
 */
app.get('/c/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  const settings = await getSettings(c.env.DB);
  const storeName = settings.store_name ?? 'Pasticceria';
  const centsPerPoint = Number(settings.cents_per_point ?? 500);

  const customer = isValidCode(code) ? await findByCode(c.env.DB, code) : null;
  if (!customer) {
    return c.html(customerPage({ storeName, notFound: true }), 404);
  }

  // Se il premio si ritira in negozio e basta, elencarlo qui puo' essere
  // superfluo: e' una riga in settings, non una modifica al sito.
  const showRewards = (settings.show_rewards_to_customer ?? '1') !== '0';

  const [history, rewards] = await Promise.all([
    customerHistory(c.env.DB, customer.id, 10),
    showRewards ? listRewards(c.env.DB) : Promise.resolve([]),
  ]);
  return c.html(
    customerPage({ storeName, customer, history: history as HistoryRow[], rewards, centsPerPoint }),
  );
});

type HistoryRow = {
  id: number;
  kind: string;
  amount_cents: number;
  points_delta: number;
  created_at: number;
  voided_at: number | null;
  reward_name: string | null;
};

function customerPage(data: {
  storeName: string;
  customer?: Customer;
  history?: HistoryRow[];
  rewards?: { id: number; name: string; points_cost: number }[];
  centsPerPoint?: number;
  notFound?: boolean;
}): string {
  const head = `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(data.storeName)} - La tua tessera</title>
<link rel="stylesheet" href="/cliente.css"></head><body>`;

  if (data.notFound || !data.customer) {
    return `${head}<main class="card"><h1>Tessera non trovata</h1>
      <p>Questo codice non risulta attivo. Chiedi in negozio, ci vuole un attimo.</p></main></body></html>`;
  }

  const c = data.customer;
  const cpp = data.centsPerPoint ?? 500;
  const missing = cpp - c.cents_carry;

  const next = (data.rewards ?? []).find((r) => r.points_cost > c.points_balance);
  const reachable = (data.rewards ?? []).filter((r) => r.points_cost <= c.points_balance);

  const rows = (data.history ?? [])
    .map((h) => {
      const date = new Date(h.created_at * 1000).toLocaleDateString('it-IT', {
        day: '2-digit', month: '2-digit', year: '2-digit',
      });
      const label = h.kind === 'redeem' ? esc(h.reward_name ?? 'Premio') : `Spesa ${formatCents(h.amount_cents)} EUR`;
      const delta = h.points_delta > 0 ? `+${h.points_delta}` : String(h.points_delta);
      return `<tr class="${h.voided_at ? 'voided' : ''}">
        <td>${date}</td><td>${label}${h.voided_at ? ' (annullato)' : ''}</td>
        <td class="delta">${h.voided_at ? '&mdash;' : delta}</td></tr>`;
    })
    .join('');

  return `${head}
<main>
  <header class="hero">
    <p class="shop">${esc(data.storeName)}</p>
    <h1>Ciao ${esc(c.first_name)}</h1>
    <p class="points"><strong>${c.points_balance}</strong> ${c.points_balance === 1 ? 'punto' : 'punti'}</p>
    <p class="carry">Ti mancano ${formatCents(missing)} EUR di spesa al prossimo punto.</p>
  </header>

  ${reachable.length ? `<section class="card ok">
    <h2>Puoi gia ritirare</h2>
    <ul>${reachable.map((r) => `<li>${esc(r.name)} <span>${r.points_cost} punti</span></li>`).join('')}</ul>
    <p class="hint">Chiedilo in cassa alla prossima visita.</p>
  </section>` : ''}

  ${next ? `<section class="card">
    <h2>Prossimo premio</h2>
    <p class="next">${esc(next.name)}</p>
    <div class="bar"><div style="width:${Math.min(100, Math.round((c.points_balance / next.points_cost) * 100))}%"></div></div>
    <p class="hint">${next.points_cost - c.points_balance} ${next.points_cost - c.points_balance === 1 ? 'punto' : 'punti'} al traguardo</p>
  </section>` : ''}

  <section class="card">
    <h2>Ultimi movimenti</h2>
    ${rows ? `<table>${rows}</table>` : '<p class="hint">Ancora nessun movimento.</p>'}
  </section>

  <footer>
    <p>Codice tessera</p>
    <p class="code">${esc(c.code)}</p>
    <p class="hint">Mostralo in cassa se non hai la tessera con te.</p>
  </footer>
</main></body></html>`;
}

// ======================================================================= 404

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json({ ok: false, error: 'Rotta inesistente' }, 404)
    : c.redirect('/', 302),
);

app.onError((err, c) => {
  console.error('Errore non gestito:', err);
  return c.json({ ok: false, error: 'Errore interno' }, 500);
});

export default app;
