import assert from "node:assert/strict";
import test from "node:test";
import { trimGrid } from "./csv-grid";

test("padding added for the view is not written back to the document", () => {
  // The editor pads to 26 columns and 50 rows so there is always somewhere to
  // type. Saving that padded grid turned `a,b,c` into `a,b,c` plus twenty-three
  // commas, and re-committed the padding on every subsequent save.
  const padded = [
    ["a", "b", "c", "", "", ""],
    ["1", "2", "3", "", "", ""],
    ["", "", "", "", "", ""],
    ["", "", "", "", "", ""],
  ];

  assert.deepEqual(trimGrid(padded), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("an interior blank is data and survives", () => {
  // `a,,c` is a three-column row whose middle is empty. Collapsing it would
  // shift `c` into column two and change what the document says.
  assert.deepEqual(trimGrid([["a", "", "c", "", ""]]), [["a", "", "c"]]);
});

test("the result stays rectangular", () => {
  // Trimming each row to its own last value would turn a table into ragged
  // lines, which parses to a different shape.
  assert.deepEqual(
    trimGrid([
      ["a", "b", "c", ""],
      ["1", "", "", ""],
    ]),
    [
      ["a", "b", "c"],
      ["1", "", ""],
    ]
  );
});

test("an entirely empty grid is an empty document, not a rectangle of commas", () => {
  assert.deepEqual(
    trimGrid([
      ["", ""],
      ["", ""],
    ]),
    []
  );
  assert.deepEqual(trimGrid([]), []);
});

test("a blank row between two filled rows is kept", () => {
  // Only trailing rows are padding. A gap the author left in the middle is
  // theirs.
  assert.deepEqual(trimGrid([["a"], [""], ["b"], [""], [""]]), [
    ["a"],
    [""],
    ["b"],
  ]);
});

test("whitespace-only cells count as empty", () => {
  // A cell holding a space is what a stray keystroke leaves behind; treating
  // it as content would pin the whole width open.
  assert.deepEqual(trimGrid([["a", " ", "  "]]), [["a"]]);
});

test("a short row is filled out to the grid width", () => {
  // Rows arrive from the grid at differing lengths; the output must not have
  // holes in it.
  assert.deepEqual(trimGrid([["a", "b"], ["c"]]), [
    ["a", "b"],
    ["c", ""],
  ]);
});

test("content in the last column and row is not mistaken for padding", () => {
  const full = [
    ["a", "b"],
    ["c", "d"],
  ];
  assert.deepEqual(trimGrid(full), full);
});
