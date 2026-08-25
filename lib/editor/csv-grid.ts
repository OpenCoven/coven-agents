/**
 * Trimming the display grid back to the data the sheet actually holds.
 *
 * The spreadsheet editor pads what it renders to a minimum size so there are
 * always spare cells to type into — 26 columns by 50 rows. That padding is a
 * property of the *view*, not of the document, but every save serialised the
 * padded grid: editing one cell of `a,b,c` wrote back `a,b,c` followed by
 * twenty-three commas, and fifty lines of nothing after it.
 *
 * That is not cosmetic. The saved value is what a later version diff is taken
 * against and what any consumer of the artifact parses, so the padding grew
 * into the stored document and every subsequent save re-committed it.
 */

/** True when a row holds nothing a reader would call content. */
function isBlank(cell: string): boolean {
  return cell.trim() === "";
}

/**
 * Drops trailing empty columns and trailing empty rows.
 *
 * Interior blanks are preserved — `a,,c` is a three-column row with an empty
 * middle, and collapsing it would change the data. Only the padding *after*
 * the last cell that holds something is removed.
 *
 * Width is computed across the whole grid rather than per row, so the result
 * stays rectangular. Trimming each row to its own last value would turn a
 * table into ragged lines, which parses differently.
 */
export function trimGrid(rows: readonly (readonly string[])[]): string[][] {
  let lastRow = -1;
  let width = 0;

  for (const [index, row] of rows.entries()) {
    let lastCell = -1;
    for (const [column, cell] of row.entries()) {
      if (!isBlank(cell)) {
        lastCell = column;
      }
    }
    if (lastCell >= 0) {
      lastRow = index;
      width = Math.max(width, lastCell + 1);
    }
  }

  // Every cell was blank. An empty document is an empty string, not a
  // rectangle of separators.
  if (lastRow < 0) {
    return [];
  }

  return rows
    .slice(0, lastRow + 1)
    .map((row) =>
      Array.from({ length: width }, (_, column) => row[column] ?? "")
    );
}
