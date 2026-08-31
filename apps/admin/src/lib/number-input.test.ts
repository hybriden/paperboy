import { describe, expect, it } from "vitest";
import { numberInputValue } from "./number-input.js";

// A number field's onChange did `Number(e.target.value)`: `Number("")` is 0, so
// emptying the input wrote a zero and the field could never be cleared (browsers
// hand back "" for partial input like "-" or "1e" too, so those also saved 0).
describe("numberInputValue", () => {
  it("stores the number the browser parsed", () => {
    expect(numberInputValue({ value: "12", valueAsNumber: 12 })).toBe(12);
    expect(numberInputValue({ value: "-1.5", valueAsNumber: -1.5 })).toBe(-1.5);
    expect(numberInputValue({ value: "0", valueAsNumber: 0 })).toBe(0);
  });

  it("an emptied input CLEARS the field (null), it does not write 0", () => {
    expect(numberInputValue({ value: "", valueAsNumber: Number.NaN })).toBeNull();
  });

  it("unparseable input is ignored (undefined = keep what is stored), never NaN", () => {
    expect(numberInputValue({ value: "abc", valueAsNumber: Number.NaN })).toBeUndefined();
  });
});
