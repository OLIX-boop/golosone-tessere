import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashPin, verifyPin, randomHex, timingSafeEqual } from '../src/auth.ts';

/**
 * Questo test esiste per un guasto vero, scoperto solo in produzione:
 * Cloudflare rifiuta PBKDF2 sopra le 100.000 iterazioni, ma il runtime locale
 * non applica il limite. Con 150.000 tutto funzionava in sviluppo e ogni
 * accesso dava 500 una volta online.
 *
 * Si legge il sorgente invece di esportare la costante: cosi' il test protegge
 * il valore anche se qualcuno lo cambia senza passare dalle funzioni.
 */
test('le iterazioni PBKDF2 restano entro il tetto di Cloudflare', () => {
  const sorgente = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
  const m = /PBKDF2_ITERATIONS\s*=\s*([\d_]+)/.exec(sorgente);
  assert.ok(m, 'non trovo la costante delle iterazioni');

  const iterazioni = Number(m![1].replace(/_/g, ''));
  assert.ok(
    iterazioni <= 100_000,
    `${iterazioni} iterazioni: Cloudflare ne accetta al massimo 100000, in produzione darebbe 500`,
  );
  // e nemmeno troppo poche: il PIN e' corto, l'hash deve costare qualcosa
  assert.ok(iterazioni >= 50_000, `${iterazioni} iterazioni sono troppo poche per un PIN`);
});

test('un PIN corretto verifica, uno sbagliato no', async () => {
  const salt = randomHex(16);
  const hash = await hashPin('4271', salt);
  assert.ok(await verifyPin('4271', salt, hash));
  assert.equal(await verifyPin('4272', salt, hash), false);
  assert.equal(await verifyPin('', salt, hash), false);
});

test('lo stesso PIN con sale diverso da hash diversi', async () => {
  const a = await hashPin('4271', randomHex(16));
  const b = await hashPin('4271', randomHex(16));
  assert.notEqual(a, b, 'senza sale distinti due negozi con lo stesso PIN avrebbero lo stesso hash');
});

test('il confronto a tempo costante si comporta come un confronto normale', () => {
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('randomHex non si ripete', () => {
  const visti = new Set(Array.from({ length: 200 }, () => randomHex(16)));
  assert.equal(visti.size, 200);
});
