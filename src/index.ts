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
import { parsePoints, pointsLabel } from './points.ts';
import {
  addPoints,
  createCustomer,
  customerHistory,
  findByCode,
  getSettingInt,
  getSettings,
  listRewards,
  redeemReward,
  searchCustomers,
  setSetting,
  voidTransaction,
  type Customer,
  type Env,
} from './db.ts';

const app = new Hono<{ Bindings: Env }>();

const STORE_ID = 1;
const isSecure = (url: string) => new URL(url).protocol === 'https:';
/** Corpo di errore uniforme. Lo status HTTP viaggia dove deve, non dentro il JSON. */
const fail = (message: string) => ({ ok: false as const, error: message });

// ============================================================ autenticazione

async function hasSession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM sessions WHERE token_hash = ? AND expires_at > unixepoch()',
  )
    .bind(await sha256Hex(token))
    .first<{ ok: number }>();
  return !!row;
}

/** Protegge tutto cio' che modifica i punti. La pagina cliente resta pubblica. */
const requireSession = async (c: any, next: () => Promise<void>) => {
  if (!(await hasSession(c.env, getCookie(c, SESSION_COOKIE)))) {
    return c.json(fail('Sessione scaduta, rientra col PIN'), 401);
  }
  await next();
};

// ---------------------------------------------------------- primo avvio

app.get('/api/bootstrap', async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({
    ok: true,
    needsSetup: !settings.access_pin_hash,
    storeName: settings.store_name ?? 'Pasticceria',
    maxPointsPerTx: Number(settings.max_points_per_tx ?? 20),
    loggedIn: await hasSession(c.env, getCookie(c, SESSION_COOKIE)),
  });
});

/** Imposta il PIN del negozio. Funziona solo finche' non ne esiste uno. */
app.post('/api/setup', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (settings.access_pin_hash) return c.json(fail('PIN gia impostato'), 409);

  const { pin } = await c.req.json<{ pin?: string }>();
  if (!pin || !/^\d{4,10}$/.test(pin)) {
    return c.json(fail('Il PIN deve avere da 4 a 10 cifre'), 400);
  }

  const salt = randomHex(16);
  await setSetting(c.env.DB, 'access_pin_salt', salt);
  await setSetting(c.env.DB, 'access_pin_hash', await hashPin(pin, salt));
  return c.json({ ok: true });
});

/**
 * Con un PIN unico e condiviso c'e' un solo numero da indovinare per entrare,
 * e un PIN di 4 cifre sono 10.000 tentativi. Il blocco progressivo e' quello
 * che rende la forza bruta impraticabile, non la lunghezza del PIN.
 */
const MAX_FAILS = 8;
const LOCK_MINUTES = 10;

app.post('/api/login', async (c) => {
  const settings = await getSettings(c.env.DB);
  const now = Math.floor(Date.now() / 1000);

  const lockUntil = Number(settings.pin_lock_until ?? 0);
  if (lockUntil > now) {
    const mins = Math.ceil((lockUntil - now) / 60);
    return c.json(fail(`Troppi tentativi. Riprova tra ${mins} minuti`), 429);
  }

  const { pin } = await c.req.json<{ pin?: string }>();
  const ok =
    !!pin &&
    !!settings.access_pin_hash &&
    (await verifyPin(pin, settings.access_pin_salt ?? '', settings.access_pin_hash));

  if (!ok) {
    const fails = Number(settings.pin_fail_count ?? 0) + 1;
    await setSetting(c.env.DB, 'pin_fail_count', String(fails));
    if (fails >= MAX_FAILS) {
      await setSetting(c.env.DB, 'pin_lock_until', String(now + LOCK_MINUTES * 60));
      await setSetting(c.env.DB, 'pin_fail_count', '0');
      return c.json(fail(`Troppi tentativi. Bloccato per ${LOCK_MINUTES} minuti`), 429);
    }
    return c.json(fail('PIN errato'), 401);
  }

  await setSetting(c.env.DB, 'pin_fail_count', '0');

  const session = await createSessionToken();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < unixepoch()'),
    c.env.DB.prepare('INSERT INTO sessions (token_hash, label, expires_at) VALUES (?, ?, ?)').bind(
      session.tokenHash,
      c.req.header('user-agent')?.slice(0, 60) ?? null,
      session.expiresAt,
    ),
  ]);

  c.header('Set-Cookie', sessionCookie(session.token, isSecure(c.req.url)));
  return c.json({ ok: true });
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

app.use('/api/cassa/*', requireSession);

/**
 * Campo unico della cassa: accetta la scansione della tessera, il codice
 * digitato a mano, il numero di telefono o il nome. L'operatore non deve
 * scegliere niente, scansiona e basta.
 */
app.get('/api/cassa/lookup', async (c) => {
  const parsed = parseInput(c.req.query('q') ?? '');
  if (parsed.type === 'empty') return c.json(fail('Scansiona la tessera o cerca il cliente'), 400);

  if (parsed.type === 'code') {
    const code = normalizeCode(parsed.value);
    if (!isValidCode(code)) return c.json(fail('Codice tessera non valido'), 404);
    const customer = await findByCode(c.env.DB, code);
    if (!customer) return c.json(fail('Tessera non trovata'), 404);
    return c.json({
      ok: true,
      match: 'exact',
      customer,
      history: await customerHistory(c.env.DB, customer.id, 8),
    });
  }

  const matches = await searchCustomers(
    c.env.DB,
    parsed.type === 'phone' ? { phone: parsed.value } : { name: parsed.value },
  );
  if (matches.length === 0) return c.json(fail('Nessun cliente trovato'), 404);
  if (matches.length === 1) {
    return c.json({
      ok: true,
      match: 'exact',
      customer: matches[0],
      history: await customerHistory(c.env.DB, matches[0].id, 8),
    });
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
    storeId: STORE_ID,
  });
  return c.json({ ok: true, customer });
});

/** Assegna punti. L'operatore decide quanti: non si registra nessun importo. */
app.post('/api/cassa/points', async (c) => {
  const body = await c.req.json<{ customerId?: number; points?: string | number }>();
  if (!body.customerId) return c.json(fail('Cliente mancante'), 400);

  const maxPerTx = await getSettingInt(c.env.DB, 'max_points_per_tx', 20);
  const parsed = parsePoints(body.points ?? '', maxPerTx);
  if (!parsed.ok) return c.json(fail(parsed.error), 400);

  try {
    const result = await addPoints(c.env.DB, {
      customerId: body.customerId,
      storeId: STORE_ID,
      points: parsed.points,
    });
    return c.json({ ok: true, ...result, pointsAdded: parsed.points });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

app.post('/api/cassa/redeem', async (c) => {
  const body = await c.req.json<{ customerId?: number; rewardId?: number }>();
  if (!body.customerId || !body.rewardId) return c.json(fail('Dati mancanti'), 400);
  try {
    const result = await redeemReward(c.env.DB, {
      customerId: body.customerId,
      storeId: STORE_ID,
      rewardId: body.rewardId,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

app.post('/api/cassa/void', async (c) => {
  const { transactionId } = await c.req.json<{ transactionId?: number }>();
  if (!transactionId) return c.json(fail('Movimento mancante'), 400);
  try {
    const customer = await voidTransaction(c.env.DB, {
      transactionId,
      windowMinutes: await getSettingInt(c.env.DB, 'void_window_min', 30),
    });
    return c.json({ ok: true, customer });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

app.get('/api/cassa/rewards', async (c) =>
  c.json({ ok: true, rewards: await listRewards(c.env.DB, STORE_ID) }),
);

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
 * Mostra punti e nient'altro di contestabile: nessun importo di spesa, quindi
 * nessun prezzo sbagliato su cui discutere al banco. Deliberatamente povera di
 * dati personali (solo il nome di battesimo) perche' chi ha il link vede questa
 * pagina. E' sola lettura: assegnare punti passa da rotte con sessione.
 */
app.get('/c/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  const settings = await getSettings(c.env.DB);
  const storeName = settings.store_name ?? 'Pasticceria';

  const customer = isValidCode(code) ? await findByCode(c.env.DB, code) : null;
  if (!customer) return c.html(customerPage({ storeName, notFound: true }), 404);

  // Se il premio si ritira in negozio e basta, elencarlo qui puo' essere
  // superfluo: e' una riga in settings, non una modifica al sito.
  const showRewards = (settings.show_rewards_to_customer ?? '1') !== '0';
  const [history, rewards] = await Promise.all([
    customerHistory(c.env.DB, customer.id, 10),
    showRewards ? listRewards(c.env.DB) : Promise.resolve([]),
  ]);

  return c.html(customerPage({ storeName, customer, history: history as HistoryRow[], rewards }));
});

type HistoryRow = {
  id: number;
  kind: string;
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
  notFound?: boolean;
}): string {
  const head = `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(data.storeName)} - La tua tessera</title>
<link rel="stylesheet" href="/cliente.css"></head><body>`;

  if (data.notFound || !data.customer) {
    return `${head}<main><section class="card"><h1>Tessera non trovata</h1>
      <p class="hint">Questo codice non risulta attivo. Chiedi in negozio, ci vuole un attimo.</p>
      </section></main></body></html>`;
  }

  const cu = data.customer;
  const next = (data.rewards ?? []).find((r) => r.points_cost > cu.points_balance);
  const reachable = (data.rewards ?? []).filter((r) => r.points_cost <= cu.points_balance);

  const rows = (data.history ?? [])
    .map((h) => {
      const date = new Date(h.created_at * 1000).toLocaleDateString('it-IT', {
        day: '2-digit', month: '2-digit', year: '2-digit',
      });
      const label = h.kind === 'redeem' ? esc(h.reward_name ?? 'Premio') : 'Punti assegnati';
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
    <h1>Ciao ${esc(cu.first_name)}</h1>
    <p class="points"><strong>${cu.points_balance}</strong> ${pointsLabel(cu.points_balance)}</p>
  </header>

  ${reachable.length ? `<section class="card ok">
    <h2>Puoi gia ritirare</h2>
    <ul>${reachable.map((r) => `<li>${esc(r.name)} <span>${r.points_cost} punti</span></li>`).join('')}</ul>
    <p class="hint">Chiedilo in cassa alla prossima visita.</p>
  </section>` : ''}

  ${next ? `<section class="card">
    <h2>Prossimo premio</h2>
    <p class="next">${esc(next.name)}</p>
    <div class="bar"><div style="width:${Math.min(100, Math.round((cu.points_balance / next.points_cost) * 100))}%"></div></div>
    <p class="hint">${next.points_cost - cu.points_balance} ${pointsLabel(next.points_cost - cu.points_balance)} al traguardo</p>
  </section>` : ''}

  <section class="card">
    <h2>Ultimi movimenti</h2>
    ${rows ? `<table>${rows}</table>` : '<p class="hint">Ancora nessun movimento.</p>'}
  </section>

  <footer>
    <p>Codice tessera</p>
    <p class="code">${esc(cu.code)}</p>
    <p class="hint">Mostralo in cassa se non hai la tessera con te.</p>
  </footer>
</main></body></html>`;
}

// ======================================================================= 404

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json(fail('Rotta inesistente'), 404)
    : c.redirect('/', 302),
);

app.onError((err, c) => {
  console.error('Errore non gestito:', err);
  return c.json(fail('Errore interno'), 500);
});

export default app;
