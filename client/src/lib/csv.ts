/**
 * CSV download — no library needed. A CSV is just text:
 *   header1,header2
 *   value1,value2
 *
 * The only trick: if a value contains a comma or quote, wrap it in
 * quotes and double the inner quotes ("Rao, Traders" → """Rao, Traders""").
 *
 * The download itself: wrap the text in a Blob (a file living in
 * memory), mint a temporary URL for it, and click an invisible link.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number)[][]
) {
  const escape = (value: string | number) => {
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const text = [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\n");

  const blob = new Blob([`﻿${text}`], {
    type: "text/csv;charset=utf-8;",
  }); // ﻿ = BOM, makes Excel read ₹ and other symbols correctly

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url); // clean up the temporary URL
}
