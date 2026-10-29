import { UserError } from '../core/errors.js';

interface Fraction {
  n: bigint;
  d: bigint;
}
const abs = (n: bigint) => (n < 0n ? -n : n);
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return abs(a);
}
function fraction(n: bigint, d = 1n): Fraction {
  if (!d) throw new UserError('Division by zero.');
  if (abs(n).toString(2).length > 8192 || abs(d).toString(2).length > 8192)
    throw new UserError('Calculation exceeds the 8192-bit precision budget.');
  const factor = gcd(n, d),
    sign = d < 0n ? -1n : 1n;
  return { n: (n / factor) * sign, d: (d / factor) * sign };
}
/** Bounded exact rational arithmetic. This parser never evaluates JavaScript or executable expressions. */
export function calculateExact(expression: string): {
  expression: string;
  exact: string;
  decimal: string;
  rounded: boolean;
} {
  if (!expression.trim() || expression.length > 2000)
    throw new UserError('Use an arithmetic expression of 1–2000 characters.');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%^]|\S/g) ?? [];
  if (tokens.length > 256) throw new UserError('Calculation token limit is 256.');
  if (tokens.some((token) => !/^(?:(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%^])$/.test(token)))
    throw new UserError('Use decimal numbers, parentheses and + - * / % ^ operators only.');
  let index = 0,
    depth = 0;
  function number(): Fraction {
    const token = tokens[index++];
    if (token === '+' || token === '-') {
      const value = parse(25);
      return token === '-' ? fraction(-value.n, value.d) : value;
    }
    if (token === '(') {
      if (++depth > 32) throw new UserError('Parenthesis nesting limit is 32.');
      const value = parse(0);
      if (tokens[index++] !== ')') throw new UserError('Unbalanced parentheses.');
      depth--;
      return value;
    }
    if (!token || !/^\d*\.?\d*$/.test(token) || token.length > 150)
      throw new UserError('Expected a decimal number, at most 150 characters.');
    const [whole = '', decimals = ''] = token.split('.');
    return fraction(BigInt((whole || '0') + decimals), 10n ** BigInt(decimals.length));
  }
  function parse(min: number): Fraction {
    let a = number();
    while (index < tokens.length) {
      const op = tokens[index]!,
        power =
          op === '+' || op === '-' ? 10 : op === '*' || op === '/' || op === '%' ? 20 : op === '^' ? 30 : 0;
      if (!power || power < min) break;
      index++;
      const b = parse(op === '^' ? power : power + 1);
      if (op === '+') a = fraction(a.n * b.d + b.n * a.d, a.d * b.d);
      else if (op === '-') a = fraction(a.n * b.d - b.n * a.d, a.d * b.d);
      else if (op === '*') a = fraction(a.n * b.n, a.d * b.d);
      else if (op === '/') a = fraction(a.n * b.d, a.d * b.n);
      else if (op === '%') {
        if (a.d !== 1n || b.d !== 1n) throw new UserError('Remainder requires integers.');
        if (!b.n) throw new UserError('Division by zero.');
        a = fraction(a.n % b.n);
      } else {
        if (b.d !== 1n || abs(b.n) > 128n)
          throw new UserError('Exponents must be integers between -128 and 128.');
        if (
          abs(a.n).toString(2).length * Number(abs(b.n)) > 8192 ||
          a.d.toString(2).length * Number(abs(b.n)) > 8192
        )
          throw new UserError('Exponent exceeds the precision budget.');
        a = b.n < 0n ? fraction(a.d ** -b.n, a.n ** -b.n) : fraction(a.n ** b.n, a.d ** b.n);
      }
    }
    return a;
  }
  const value = parse(0);
  if (index !== tokens.length) throw new UserError('Unexpected token or missing operator.');
  const negative = value.n < 0n,
    numerator = abs(value.n),
    whole = numerator / value.d;
  let remainder = numerator % value.d,
    decimals = '';
  while (remainder && decimals.length < 60) {
    remainder *= 10n;
    decimals += String(remainder / value.d);
    remainder %= value.d;
  }
  return {
    expression,
    exact: value.d === 1n ? String(value.n) : `${value.n}/${value.d}`,
    decimal: `${negative ? '-' : ''}${whole}${decimals ? '.' + decimals : ''}`,
    rounded: remainder !== 0n,
  };
}
