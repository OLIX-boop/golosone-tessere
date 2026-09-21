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
import { qrDataUrl, qrSvg } from './qr.ts';
import { ensureClass, readConfig, readConfigDetailed, saveLink, upsertObject } from './google-wallet.ts';
import {
  activateCard,
  cardStock,
  listAllRewards,
  reportSeries,
  reportTotals,
  setCustomerActive,
  topCustomers,
  tzOffsetSeconds,
  upsertReward,
  addPoints,
  createCardBatch,
  createCustomer,
  listBatch,
  listBatches,
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

type Scope = 'cassa' | 'titolare';
const ADMIN_COOKIE = 'gt_admin';

async function hasSession(env: Env, token: string | undefined, scope: Scope = 'cassa'): Promise<boolean> {
  if (!token) return false;
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM sessions WHERE token_hash = ? AND scope = ? AND expires_at > unixepoch()',
  )
    .bind(await sha256Hex(token), scope)
    .first<{ ok: number }>();
  return !!row;
}

/**
 * Il pannello titolare ha un PIN proprio.
 *
 * Con il solo PIN di cassa, chiunque stia al banco potrebbe cambiare la soglia
 * del premio o leggere gli incassi. Questo si usa di rado e fuori dalla fila,
 * quindi la separazione non costa attrito dove conta.
 */
const requireOwner = async (c: any, next: () => Promise<void>) => {
  if (!(await hasSession(c.env, getCookie(c, ADMIN_COOKIE), 'titolare'))) {
    return c.json(fail('Serve il PIN titolare'), 401);
  }
  await next();
};

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
  if (settings.access_pin_hash) return c.json(fail('PIN già impostato'), 409);

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
    c.env.DB.prepare(
      "INSERT INTO sessions (token_hash, label, scope, expires_at) VALUES (?, ?, 'cassa', ?)",
    ).bind(session.tokenHash, c.req.header('user-agent')?.slice(0, 60) ?? null, session.expiresAt),
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

// ----------------------------------------------------------- Google Wallet

/**
 * Riallinea il pass nel telefono del cliente dopo un movimento.
 *
 * Parte in sottofondo e ingoia ogni errore: se Google non risponde, la cassa
 * non deve rallentare ne' fallire. Nel peggiore dei casi il pass resta
 * indietro finche' il cliente non riapre la sua pagina.
 */
function aggiornaPassInSottofondo(c: any, card: Customer) {
  if (!c.env.GOOGLE_WALLET_SA) return; // non configurato: nemmeno una query in piu'
  c.executionCtx?.waitUntil(
    (async () => {
      try {
        const cfg = readConfig(c.env, await getSettings(c.env.DB), new URL(c.req.url).origin);
        if (!cfg) return;
        await upsertObject(cfg, {
          code: card.code,
          firstName: card.first_name,
          points: card.points_balance,
        });
      } catch (err) {
        console.error('Aggiornamento Google Wallet fallito:', err);
      }
    })(),
  );
}

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
  if (!body.firstName?.trim()) return c.json(fail('Il nome è obbligatorio'), 400);

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
    aggiornaPassInSottofondo(c, result.customer);
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
    aggiornaPassInSottofondo(c, result.customer);
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
    aggiornaPassInSottofondo(c, customer);
    return c.json({ ok: true, customer });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

// ------------------------------------------------------- lotti di tessere

app.post('/api/cassa/cards/batch', async (c) => {
  const { count } = await c.req.json<{ count?: number }>();
  try {
    const result = await createCardBatch(c.env.DB, { count: Number(count), storeId: STORE_ID });
    return c.json({ ok: true, batch: result.batch, count: result.cards.length });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

app.get('/api/cassa/batches', async (c) =>
  c.json({ ok: true, batches: await listBatches(c.env.DB) }),
);

/** Consegna della tessera: da vergine a intestata. */
app.post('/api/cassa/activate', async (c) => {
  const body = await c.req.json<{
    customerId?: number; firstName?: string; lastName?: string; phone?: string; consent?: boolean;
  }>();
  if (!body.customerId) return c.json(fail('Tessera mancante'), 400);
  try {
    const customer = await activateCard(c.env.DB, {
      customerId: body.customerId,
      firstName: body.firstName ?? '',
      lastName: body.lastName,
      phone: body.phone,
      consent: body.consent,
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

// ================================================================ titolare

const OWNER_TTL = 60 * 60 * 4; // quattro ore: si entra, si guarda, si esce

app.get('/api/titolare/stato', async (c) => {
  const settings = await getSettings(c.env.DB);
  return c.json({
    ok: true,
    needsSetup: !settings.owner_pin_hash,
    // si puo' impostare il PIN titolare solo da una cassa gia' sbloccata:
    // altrimenti il primo passante che trova l'indirizzo se lo prende
    canSetup: await hasSession(c.env, getCookie(c, SESSION_COOKIE), 'cassa'),
    loggedIn: await hasSession(c.env, getCookie(c, ADMIN_COOKIE), 'titolare'),
    storeName: settings.store_name ?? 'Pasticceria',
    // il segreto non si mostra mai: basta sapere se c'e' e se e' leggibile
    walletSegreto: !!c.env.GOOGLE_WALLET_SA,
    walletProblema: readConfigDetailed(c.env, settings, new URL(c.req.url).origin).problema,
  });
});

app.post('/api/titolare/setup', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (settings.owner_pin_hash) return c.json(fail('PIN titolare già impostato'), 409);
  if (!(await hasSession(c.env, getCookie(c, SESSION_COOKIE), 'cassa'))) {
    return c.json(fail('Sblocca prima la cassa col PIN negozio'), 401);
  }

  const { pin } = await c.req.json<{ pin?: string }>();
  if (!pin || !/^\d{4,10}$/.test(pin)) return c.json(fail('Il PIN deve avere da 4 a 10 cifre'), 400);

  const salt = randomHex(16);
  await setSetting(c.env.DB, 'owner_pin_salt', salt);
  await setSetting(c.env.DB, 'owner_pin_hash', await hashPin(pin, salt));
  return c.json({ ok: true });
});

app.post('/api/titolare/login', async (c) => {
  const settings = await getSettings(c.env.DB);
  const now = Math.floor(Date.now() / 1000);

  const lockUntil = Number(settings.owner_lock_until ?? 0);
  if (lockUntil > now) {
    return c.json(fail(`Troppi tentativi. Riprova tra ${Math.ceil((lockUntil - now) / 60)} minuti`), 429);
  }

  const { pin } = await c.req.json<{ pin?: string }>();
  const ok =
    !!pin &&
    !!settings.owner_pin_hash &&
    (await verifyPin(pin, settings.owner_pin_salt ?? '', settings.owner_pin_hash));

  if (!ok) {
    const fails = Number(settings.owner_fail_count ?? 0) + 1;
    await setSetting(c.env.DB, 'owner_fail_count', String(fails));
    if (fails >= MAX_FAILS) {
      await setSetting(c.env.DB, 'owner_lock_until', String(now + LOCK_MINUTES * 60));
      await setSetting(c.env.DB, 'owner_fail_count', '0');
      return c.json(fail(`Troppi tentativi. Bloccato per ${LOCK_MINUTES} minuti`), 429);
    }
    return c.json(fail('PIN errato'), 401);
  }

  await setSetting(c.env.DB, 'owner_fail_count', '0');
  const token = randomHex(32);
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, label, scope, expires_at) VALUES (?, 'titolare', 'titolare', ?)",
  )
    .bind(await sha256Hex(token), now + OWNER_TTL)
    .run();

  const secure = isSecure(c.req.url);
  c.header(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWNER_TTL}${secure ? '; Secure' : ''}`,
  );
  return c.json({ ok: true });
});

app.post('/api/titolare/logout', async (c) => {
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  const secure = isSecure(c.req.url);
  c.header('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  return c.json({ ok: true });
});

app.use('/api/titolare/report', requireOwner);
app.use('/api/titolare/premi', requireOwner);
app.use('/api/titolare/clienti', requireOwner);
app.use('/api/titolare/clienti/*', requireOwner);
app.use('/api/titolare/impostazioni', requireOwner);
app.use('/api/titolare/pin-negozio', requireOwner);

app.get('/api/titolare/report', async (c) => {
  const settings = await getSettings(c.env.DB);
  const tz = settings.timezone ?? 'Europe/Rome';
  const days = Math.min(90, Math.max(7, Number(c.req.query('days') ?? 14)));
  const now = Math.floor(Date.now() / 1000);

  // "Oggi" e' il giorno civile del negozio, non le ultime 24 ore.
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const startOfToday = Math.floor(new Date(`${todayKey}T00:00:00Z`).getTime() / 1000) - tzOffsetSeconds(tz);

  const [serie, oggi, settimana, mese, scorta] = await Promise.all([
    reportSeries(c.env.DB, { days, tz }),
    reportTotals(c.env.DB, startOfToday),
    reportTotals(c.env.DB, now - 7 * 86400),
    reportTotals(c.env.DB, now - 30 * 86400),
    cardStock(c.env.DB),
  ]);

  return c.json({ ok: true, serie, oggi, settimana, mese, scorta, tz });
});

app.get('/api/titolare/premi', async (c) =>
  c.json({ ok: true, premi: await listAllRewards(c.env.DB, STORE_ID) }),
);

app.post('/api/titolare/premi', async (c) => {
  const b = await c.req.json<{
    id?: number; name?: string; description?: string; pointsCost?: number; active?: boolean;
  }>();
  try {
    const id = await upsertReward(c.env.DB, {
      id: b.id,
      name: b.name ?? '',
      description: b.description,
      pointsCost: Number(b.pointsCost),
      active: b.active,
      storeId: STORE_ID,
    });
    return c.json({ ok: true, id, premi: await listAllRewards(c.env.DB, STORE_ID) });
  } catch (err) {
    return c.json(fail((err as Error).message), 400);
  }
});

app.get('/api/titolare/clienti', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ ok: true, clienti: await topCustomers(c.env.DB, 15), modo: 'top' });

  const parsed = parseInput(q);
  const clienti =
    parsed.type === 'code'
      ? [await findByCode(c.env.DB, normalizeCode(parsed.value))].filter(Boolean)
      : await searchCustomers(c.env.DB, parsed.type === 'phone' ? { phone: parsed.value } : { name: q });
  return c.json({ ok: true, clienti, modo: 'ricerca' });
});

app.post('/api/titolare/clienti/attiva', async (c) => {
  const { customerId, active } = await c.req.json<{ customerId?: number; active?: boolean }>();
  if (!customerId) return c.json(fail('Cliente mancante'), 400);
  const customer = await setCustomerActive(c.env.DB, customerId, active !== false);
  return c.json({ ok: true, customer });
});

app.get('/api/titolare/impostazioni', async (c) => {
  const s = await getSettings(c.env.DB);
  // gli hash dei PIN non escono mai dal server
  const pubbliche: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!k.includes('pin_hash') && !k.includes('pin_salt')) pubbliche[k] = v;
  }
  return c.json({ ok: true, impostazioni: pubbliche });
});

const MODIFICABILI = new Set([
  'store_name',
  'max_points_per_tx',
  'void_window_min',
  'show_rewards_to_customer',
  'timezone',
  'wallet_issuer_id',
  'wallet_class_suffix',
]);

app.post('/api/titolare/impostazioni', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const scritte: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    // lista chiusa: un POST non deve poter scrivere pin_lock_until o gli hash
    if (!MODIFICABILI.has(k)) continue;
    if (k === 'max_points_per_tx' || k === 'void_window_min') {
      const n = Number.parseInt(String(v), 10);
      if (!Number.isFinite(n) || n < 1) return c.json(fail(`Valore non valido per ${k}`), 400);
    }
    if (k === 'store_name' && !String(v).trim()) {
      return c.json(fail('Il nome del negozio non può essere vuoto'), 400);
    }
    await setSetting(c.env.DB, k, String(v).trim());
    scritte.push(k);
  }
  return c.json({ ok: true, scritte });
});

/** Cambio del PIN di cassa: tutte le casse dovranno rientrare. */
app.post('/api/titolare/pin-negozio', async (c) => {
  const { pin } = await c.req.json<{ pin?: string }>();
  if (!pin || !/^\d{4,10}$/.test(pin)) return c.json(fail('Il PIN deve avere da 4 a 10 cifre'), 400);

  const salt = randomHex(16);
  await setSetting(c.env.DB, 'access_pin_salt', salt);
  await setSetting(c.env.DB, 'access_pin_hash', await hashPin(pin, salt));
  // le sessioni cassa aperte col vecchio PIN vanno chiuse, altrimenti
  // cambiarlo non servirebbe a niente
  await c.env.DB.prepare("DELETE FROM sessions WHERE scope = 'cassa'").run();
  return c.json({ ok: true });
});

/**
 * "Aggiungi a Google Wallet" per una tessera.
 *
 * Fa tutto lato server e poi rimanda a Google: il cliente tocca un pulsante e
 * si ritrova la tessera nel telefono, senza passaggi intermedi da capire.
 */
app.get('/c/:code/wallet', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!isValidCode(code)) return c.text('Codice tessera non valido', 404);

  const settings = await getSettings(c.env.DB);
  const cfg = readConfig(c.env, settings, new URL(c.req.url).origin);
  if (!cfg) return c.text('Google Wallet non e configurato per questo negozio', 503);

  const card = await findByCode(c.env.DB, code);
  if (!card || !card.activated_at) return c.text('Tessera non trovata', 404);

  try {
    await ensureClass(cfg);
    await upsertObject(cfg, {
      code: card.code,
      firstName: card.first_name,
      points: card.points_balance,
    });
    return c.redirect(await saveLink(cfg, card.code), 302);
  } catch (err) {
    console.error('Google Wallet:', err);
    return c.text('Non riesco a creare la tessera adesso. Riprova piu tardi.', 502);
  }
});

// ============================================================ stampa tessere

/**
 * Foglio di tessere pronto da stampare.
 *
 * Misure in millimetri e non in pixel: e' l'unica unita' che il browser
 * traduce fedelmente in stampa a prescindere dallo zoom e dai DPI. Tessera
 * 85x55mm (formato biglietto da visita), dieci per foglio A4.
 *
 * L'URL del QR si costruisce dall'origine della richiesta: cosi' il foglio
 * stampato in locale punta a localhost e quello stampato in produzione al
 * dominio vero, senza configurazione da ricordare.
 */
app.get('/stampa/:batch', requireSession, async (c) => {
  const batch = c.req.param('batch');
  const cards = await listBatch(c.env.DB, batch);
  if (cards.length === 0) return c.html('<p>Lotto non trovato</p>', 404);

  const settings = await getSettings(c.env.DB);
  const storeName = settings.store_name ?? 'Pasticceria';
  const origin = new URL(c.req.url).origin;

  const cardsHtml = cards
    .map((card) => {
      const url = `${origin}/c/${card.code}`;
      return `<div class="tessera">
        <div class="testo">
          <p class="negozio">${esc(storeName)}</p>
          <p class="titolo">Tessera punti</p>
          <p class="istruzioni">Inquadra il codice<br>per vedere i tuoi punti</p>
          <p class="codice">${esc(card.code)}</p>
        </div>
        <div class="qr">${qrSvg(url, { size: 108 })}</div>
      </div>`;
    })
    .join('');

  return c.html(`<!doctype html><html lang="it"><head>
<meta charset="utf-8"><title>Tessere ${esc(batch)}</title>
<style>
  /* Niente margini del browser: le misure delle tessere devono essere esatte,
     altrimenti il taglio non torna. */
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:#f4f1ec; color:#2b2420; }

  .barra { padding:16px; text-align:center; background:#fff; border-bottom:1px solid #e5ded5; }
  .barra button { font:inherit; font-weight:600; background:#8c4a2f; color:#fff;
                  border:0; border-radius:10px; padding:12px 22px; cursor:pointer; }
  .barra p { margin:.5em 0 0; color:#8a7f76; font-size:14px; }

  .foglio { width:190mm; margin:14px auto; display:grid;
            grid-template-columns:repeat(2, 85mm); grid-auto-rows:55mm;
            gap:4mm; justify-content:center; }

  .tessera { width:85mm; height:55mm; border:1px dashed #c9bfb4; border-radius:3mm;
             padding:5mm; display:flex; align-items:center; gap:4mm;
             background:#fff; overflow:hidden; }
  .testo { flex:1; min-width:0; }
  .negozio { margin:0; font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:#8a7f76; }
  .titolo { margin:1mm 0 0; font-size:13pt; font-weight:700; }
  .istruzioni { margin:2mm 0 0; font-size:7pt; line-height:1.4; color:#8a7f76; }
  /* Il codice in chiaro sotto il QR salva la giornata quando il lettore non
     legge, lo schermo e' crepato o il cliente detta il codice al telefono. */
  .codice { margin:2.5mm 0 0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
            font-size:12pt; font-weight:700; letter-spacing:.16em; }
  .qr { flex:0 0 auto; line-height:0; }
  .qr svg { width:30mm; height:30mm; }

  @media print {
    body { background:#fff; }
    .barra { display:none; }
    .foglio { margin:0; gap:0; grid-template-columns:repeat(2, 95mm); grid-auto-rows:59.4mm; }
    .tessera { width:95mm; height:59.4mm; border:1px dashed #ddd; }
    /* Una tessera non deve mai essere spezzata a meta' dal salto pagina. */
    .tessera { break-inside: avoid; page-break-inside: avoid; }
  }
</style></head><body>
  <div class="barra">
    <button onclick="window.print()">Stampa ${cards.length} tessere</button>
    <p>Lotto ${esc(batch)} &middot; cartoncino consigliato 250-300 g/m&sup2;</p>
  </div>
  <div class="foglio">${cardsHtml}</div>
</body></html>`);
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
/* ------------------------------------------------- la tessera nell'app */

/**
 * La tessera in JSON, per l'app dei clienti del negozio.
 *
 * È **la stessa roba** che `/c/:code` mostra già in HTML a chiunque abbia il
 * link: nome di battesimo, saldo, premi e ultimi movimenti. Non apre niente
 * di nuovo — cambia solo il formato, perché un'app non sa leggere una pagina.
 *
 * Aperta a internet come la pagina gemella: assegnare punti resta dietro la
 * sessione di cassa, e da qui non si scrive niente. Un codice è lungo otto
 * caratteri su un alfabeto di ventotto, cioè quasi quattrocento miliardi di
 * combinazioni: tirarne a caso non è una strada.
 *
 * Una tessera **mai consegnata** non esiste: `activated_at` a NULL vuol dire
 * un cartoncino ancora nella scatola alla cassa, e mostrarlo direbbe «Ciao»
 * a nessuno.
 */
app.use('/api/pubblico/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
});

app.get('/api/pubblico/tessera/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (!isValidCode(code)) return c.json({ errore: 'Codice non valido' }, 404);

  const customer = await findByCode(c.env.DB, code);
  if (!customer || !customer.activated_at) {
    return c.json({ errore: 'Tessera non trovata' }, 404);
  }

  const settings = await getSettings(c.env.DB);
  const mostraPremi = (settings.show_rewards_to_customer ?? '1') !== '0';

  const [movimenti, premi] = await Promise.all([
    customerHistory(c.env.DB, customer.id, 10),
    mostraPremi ? listRewards(c.env.DB) : Promise.resolve([]),
  ]);

  const saldo = customer.points_balance;
  const elenco = (premi as { name: string; points_cost: number }[]).map((p) => ({
    nome: p.name,
    punti: p.points_cost,
    raggiunto: p.points_cost <= saldo,
  }));
  const prossimo = elenco.find((p) => !p.raggiunto) ?? null;

  return c.json({
    negozio: settings.store_name ?? 'Pasticceria',
    nome: customer.first_name,
    punti: saldo,
    // Il QR porta l'indirizzo della pagina cliente, esattamente come quello
    // stampato sul cartoncino: il lettore della cassa non distingue lo
    // schermo dalla carta, e in negozio non cambia niente.
    qr: qrDataUrl(`${new URL(c.req.url).origin}/c/${customer.code}`),
    codice: customer.code,
    premi: elenco,
    prossimo: prossimo ? { ...prossimo, mancano: prossimo.punti - saldo } : null,
    movimenti: (movimenti as HistoryRow[]).map((m) => ({
      quando: m.created_at,
      cosa: m.kind === 'redeem' ? (m.reward_name ?? 'Premio') : 'Punti assegnati',
      delta: m.points_delta,
      annullato: !!m.voided_at,
    })),
  });
});

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

  const walletPronto = !!readConfig(c.env, settings, new URL(c.req.url).origin);
  return c.html(
    customerPage({ storeName, customer, history: history as HistoryRow[], rewards, walletPronto }),
  );
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
  walletPronto?: boolean;
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
    <h2>Puoi già ritirare</h2>
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

  <section class="card telefono">
    <h2>Porta la tessera nel telefono</h2>

    ${data.walletPronto ? `<p class="hint" style="margin-top:0">Se hai un telefono Android:</p>
    <p><a class="bottone" href="/c/${esc(cu.code)}/wallet">Aggiungi a Google Wallet</a></p>
    <p class="hint">I punti si aggiornano da soli: non devi rifare niente.</p>` : ''}

    <p class="hint"${data.walletPronto ? ' style="margin-top:18px"' : ' style="margin-top:0"'}>Se hai un iPhone (iOS 27 o successivo):</p>
    <ol class="passi">
      <li>Apri <b>Wallet</b></li>
      <li>Tocca <b>+</b> in alto, poi <b>Crea un pass</b></li>
      <li>Inquadra il <b>cartoncino della tessera</b>, non questo schermo</li>
    </ol>
    <p class="hint">La tessera nel Wallet di iPhone resta ferma al momento in cui la crei:
       serve a farti trovare il codice, ma per il saldo aggiornato torna su questa pagina.</p>
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
