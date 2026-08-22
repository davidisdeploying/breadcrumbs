// scripts/import-cli.mjs
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { importOrdersJson } from '../server/import.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-cli.mjs <file.json>');
  process.exit(1);
}

const absolutePath = path.resolve(filePath);
if (!fs.existsSync(absolutePath)) {
  console.error(`File not found: ${absolutePath}`);
  process.exit(1);
}

try {
  const content = fs.readFileSync(absolutePath, 'utf8');
  const filename = path.basename(absolutePath);
  const result = importOrdersJson(db, content, filename);
  console.log('Import summary:', JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Import failed:', err.message);
  process.exit(1);
}
