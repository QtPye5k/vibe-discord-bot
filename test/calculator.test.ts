import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExact } from '../src/features/calculator.js';
test('calculator preserves decimal precision, rational values and conventional exponent precedence', () => {
  assert.equal(calculateExact('0.1+0.2').exact, '3/10');
  assert.equal(calculateExact('0.1+0.2').decimal, '0.3');
  assert.equal(calculateExact('2^3^2').exact, '512');
  assert.equal(calculateExact('-2^2').exact, '-4');
  assert.equal(calculateExact('2^-3').exact, '1/8');
  assert.equal(calculateExact('(9+3)/4%2').exact, '1');
  assert.equal(calculateExact('99999999999999999999+1').exact, '100000000000000000000');
  assert.equal(calculateExact('1/3').rounded, true);
  assert.equal(calculateExact('1/8').rounded, false);
});
test('calculator rejects executable syntax, malformed expressions and resource amplification', () => {
  for (const value of [
    'process.exit()',
    '1;2',
    'Math.sqrt(4)',
    '1/0',
    '0^-1',
    '2^999',
    '1.1%2',
    '(1+2',
    '1 2',
    '()',
    '1+',
    '2(3)',
  ])
    assert.throws(() => calculateExact(value), Error, value);
  assert.throws(() => calculateExact('('.repeat(33) + '1' + ')'.repeat(33)), /nesting/);
  assert.throws(() => calculateExact('1+'.repeat(200) + '1'), /token/);
  assert.throws(() => calculateExact('9'.repeat(150) + '^128'), /precision/);
});
