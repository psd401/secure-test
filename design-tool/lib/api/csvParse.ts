// Minimal RFC-4180 CSV tokenizer (slice 41). No CSV dependency exists in
// the workspace, and item-import CSVs are small teacher-authored files, so
// a hand-rolled parser is the right size. Handles: quoted fields, embedded
// commas / quotes ("" escape) / newlines inside quotes, and CRLF or LF row
// endings. Returns rows of raw string cells; a trailing newline does not
// produce a spurious empty row.
// Review fix (2026-08-14): records carry the PHYSICAL 1-based line each
// record starts on. Quoted fields may contain newlines, so a record index
// is NOT a source line — error reporting that says "line N" must use this.
export interface CsvRecord {
  cells: string[];
  line: number;
}

export function parseCsvRecords(text: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  let line = 1; // current physical line (1-based)
  let rowStartLine = 1; // physical line the in-progress record started on
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push({ cells: row, line: rowStartLine });
    row = [];
    rowStartLine = line;
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // Embedded newlines inside quotes advance the physical line but do
      // NOT end the record.
      if (c === "\r") {
        if (text[i + 1] === "\n") {
          field += "\r\n";
          i += 2;
        } else {
          field += "\r";
          i++;
        }
        line++;
        continue;
      }
      if (c === "\n") {
        field += c;
        line++;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow CRLF as one terminator
      if (text[i + 1] === "\n") i++;
      i++;
      line++;
      endRow();
      continue;
    }
    if (c === "\n") {
      i++;
      line++;
      endRow();
      continue;
    }
    field += c;
    i++;
  }
  // Flush the final field/row unless the input ended exactly on a newline
  // (field empty AND row empty means the last endRow already ran).
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows;
}

export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((r) => r.cells);
}
