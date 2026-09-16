import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEarn, parseAmountToCents, formatCents } from '../src/points.ts';
import { parseInput, generateCode, isValidCode, CODE_LENGTH } from '../src/codes.ts';

const P = 500; // 5 EUR = 1 punto

test('spesa esatta sulla soglia', () => {
  const r = computeEarn(0, 500, P);
  assert.equal(r.pointsEarned, 1);
  assert.equal(r.newCarry, 0);
});

test('il resto non si butta, si accumula', () => {
  const a = computeEarn(0, 1200, P);        // 12 EUR -> 2 punti, avanzano 2 EUR
  assert.equal(a.pointsEarned, 2);
  assert.equal(a.newCarry, 200);

  const b = computeEarn(a.newCarry, 300, P); // +3 EUR -> i 2 avanzati chiudono il punto
  assert.equal(b.pointsEarned, 1);
  assert.equal(b.newCarry, 0);
});

test('spesa sotto soglia non da punti ma non si perde', () => {
  const r = computeEarn(0, 499, P);
  assert.equal(r.pointsEarned, 0);
  assert.equal(r.newCarry, 499);
  assert.equal(r.centsToNextPoint, 1);
});

test('tanti micro-acquisti arrivano allo stesso punto di uno grande', () => {
  let carry = 0, points = 0;
  for (let i = 0; i < 10; i++) {
    const r = computeEarn(carry, 123, P);
    points += r.pointsEarned;
    carry = r.newCarry;
  }
  // 10 x 1,23 = 12,30 EUR -> 2 punti, 2,30 di resto
  assert.equal(points, 2);
  assert.equal(carry, 230);
});

test('importi rifiutati invece di essere arrotondati a caso', () => {
  assert.equal(parseAmountToCents('12,50'), 1250);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents('7'), 700);
  assert.equal(parseAmountToCents('12,505'), null);
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents('-5'), null);
  assert.equal(parseAmountToCents(''), null);
});

test('niente errori di virgola mobile su importi tipici', () => {
  // 0.1 + 0.2 in float fa 0.30000000000000004: qui deve fare 30 centesimi netti
  const a = parseAmountToCents('0,10')!;
  const b = parseAmountToCents('0,20')!;
  assert.equal(a + b, 30);
  assert.equal(formatCents(a + b), '0,30');
  assert.equal(formatCents(1250), '12,50');
  assert.equal(formatCents(1200), '12,00');
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
