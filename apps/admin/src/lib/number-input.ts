/**
 * What a `<input type="number">` change should store: the parsed number, null
 * for an emptied input (`Number("")` is 0, which made the field impossible to
 * clear), or undefined for input the browser can't parse yet — keep what is
 * stored rather than write NaN.
 */
export function numberInputValue(input: Pick<HTMLInputElement, "value" | "valueAsNumber">): number | null | undefined {
  if (input.value === "") return null;
  return Number.isNaN(input.valueAsNumber) ? undefined : input.valueAsNumber;
}
