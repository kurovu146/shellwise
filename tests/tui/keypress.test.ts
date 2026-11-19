import { describe, test, expect } from "bun:test";
import { parseKeypress } from "../../src/tui/input";

const bytes = (...b: number[]) => Buffer.from(b);

describe("parseKeypress on Windows VT-input byte sequences", () => {
  test.each([
    [bytes(0x1b, 0x5b, 0x41), { type: "special", key: "up" }],
    [bytes(0x1b, 0x5b, 0x5a), { type: "special", key: "shift-tab" }],
    [bytes(0x1b, 0x5b, 0x33, 0x7e), { type: "special", key: "delete" }],
    [bytes(0x12), { type: "ctrl", char: "r" }],
    [bytes(0x1b), { type: "special", key: "escape" }],
    [bytes(0x0d), { type: "special", key: "enter" }],
    [bytes(0x09), { type: "special", key: "tab" }],
    [bytes(0x7f), { type: "special", key: "backspace" }],
    [bytes(0xe1, 0xbb, 0x87), { type: "char", char: "ệ" }],
  ])("%p", (input, expected) => {
    expect(parseKeypress(input)).toEqual(expected as never);
  });
});
