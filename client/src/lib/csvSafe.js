/**
 * Spreadsheet formula injection guard for CSV / TSV the client writes (device tags, mapping rows).
 * Their cells carry topic names, OPC UA addresses and device tag names that come from the network; a
 * cell starting with = + - @ (or a tab / CR) runs as a formula when the file is opened in a spreadsheet.
 * Such text cells get a leading apostrophe, as the server's alert history and Trends exports do; numbers
 * (-5, 1e3) stay as they are. restoreFormula undoes it on import, so export -> import round trips.
 */
const FORMULA = /^[=+\-@\t\r]/;

export function neutralizeFormula(v) {
  if (typeof v !== 'string' || !FORMULA.test(v) || Number.isFinite(Number(v))) return v;
  return `'${v}`;
}

export function restoreFormula(s) {
  return typeof s === 'string' && s.length > 1 && s[0] === "'" && FORMULA.test(s.slice(1)) ? s.slice(1) : s;
}
