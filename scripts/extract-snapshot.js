// Helper: extracts the embedded snapshot JSON string from the wrapping
// `[{ "snapshot": "..." }]` shape that Supabase SQL Editor returns when a
// query produces a single jsonb_pretty() column. Reads from stdin, writes
// the inner JSON to ../schema-snapshot.json. Used once after pasting the
// SQL editor result into a temp file.
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const arr = JSON.parse(raw);
const inner = JSON.parse(arr[0].snapshot);
const outPath = path.join(__dirname, '..', 'schema-snapshot.json');
fs.writeFileSync(outPath, JSON.stringify(inner, null, 2) + '\n');
console.log('Wrote', outPath);
console.log('Tables:', Object.keys(inner.tables).join(', '));
for (const [t, cols] of Object.entries(inner.tables)) {
  console.log('  ' + t + ': ' + cols.length + ' columns');
}
