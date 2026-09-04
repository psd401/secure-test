// In-memory TIDE xlsx builder for slice-23a tests. Mirrors the two
// load-bearing columns from a real TIDE accommodations export:
//   SSID | Subject | Tool Name | Value
//
// docs/AccommodationData.xlsx contains real student SSIDs and is NOT
// committed to source control; tests build a tiny synthetic xlsx in
// memory via this helper so the test harness never touches the real
// file.
import ExcelJS from "exceljs";

export interface TideFixtureRow {
  ssid: string;
  subject: string;
  tool: string;
  value: string;
}

export async function buildTideXlsxBuffer(
  rows: readonly TideFixtureRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Accommodations");
  // Header row — column titles match what the real TIDE export emits.
  ws.addRow(["Student ID", "Subject", "Tool Name", "Value"]);
  for (const r of rows) {
    ws.addRow([r.ssid, r.subject, r.tool, r.value]);
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}
