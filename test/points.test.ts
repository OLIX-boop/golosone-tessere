import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePoints, pointsLabel } from '../src/points.ts';
import { parseInput, generateCode, isValidCode, CODE_LENGTH } from '../src/codes.ts';

const MAX = 20;

test('punti validi', () => {
  assert.deepEqual(parsePoints('2', MAX), { ok: true, points: 2 });
  assert.deepEqual(parsePoints(3, MAX), { ok: true, points: 3 });
  assert.deepEqual(parsePoints(' 5 ', MAX), { ok: true, points: 5 });
  assert.deepEqual(parsePoints('2 punti', MAX), { ok: true, points: 2 });
  assert.deepEqual(parsePoints(String(MAX), MAX), { ok: true, points: MAX });
});

test('il tetto per movimento ferma il 2 diventato 22', () => {
  const r = parsePoints('22', MAX);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Massimo 20/);
});

test('un importo digitato nel campo punti viene rifiutato, non interpretato', () => {
  // "12,50" nel campo dei punti e' quasi sempre lo scontrino battuto per
  // sbaglio: se lo accettassimo come 12 sarebbero 12 punti regalati.
  for (const bad of ['12,50', '12.50', '2,5', '-3', 'abc', '']) {
    assert.equal(parsePoints(bad, MAX).ok, false, `avrebbe dovuto rifiutare: ${bad}`);
  }
});

test('zero punti non e un movimento', () => {
  const r = parsePoints('0', MAX);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Zero punti/);
});

test('singolare e plurale', () => {
  assert.equal(pointsLabel(1), 'punto');
  assert.equal(pointsLabel(0), 'punti');
  assert.equal(pointsLabel(2), 'punti');
  assert.equal(pointsLabel(-1), 'punto');
});

test('la cassa riconosce URL, codice nudo e telefono dallo stesso campo', () => {
  const code = generateCode();
  assert.equal(parseInput(`https://tessere.example.dev/c/${code}`).value, code);
  assert.equal(parseInput(code).value, code);
  assert.equal(parseInput(` ${code} `).value, code);

  const phone = parseInput('+39 333 123 4567');
  assert.equal(phone.type, 'phone');
  assert.equal(phone.value, '3331234567');

  assert.equal(parseInput('Maria Rossi').type, 'name');
  assert.equal(parseInput('').type, 'empty');
});

test('URL storpiato dal lettore barcode col layout sbagliato', () => {
  const code = generateCode();
  // con layout US su tastiera IT, ":" e "/" escono come altri simboli
  const mangled = `https;''tessere.example.dev'c'${code}`;
  assert.equal(parseInput(mangled).value, code);
});

test('i codici generati sono sempre validi e senza caratteri ambigui', () => {
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.ok(isValidCode(c));
    assert.ok(!/[01ILOSUV]/.test(c), `codice ambiguo generato: ${c}`);
  }
});
