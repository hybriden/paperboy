/**
 * Drops trailing "/" characters. A loop, not `replace(/\/+$/, "")`: that regex
 * is quadratic in V8 on a long run of slashes that isn't at the end
 * (CodeQL js/polynomial-redos; trailing-slash-redos.test.ts).
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}
