// Проверка синтаксиса всех JS-файлов проекта: node tools/check-syntax.js
//
// Именно этой проверки не хватало: файл card_parser.js почти год лежал
// с потерянным объявлением класса, и расширение молча не работало.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'card_templates', 'icons', '.git', '__pycache__', 'extension']);

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(root, []).sort();
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('  ok    ' + path.relative(root, file));
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + path.relative(root, file));
    const stderr = (e.stderr || '').toString().trim().split('\n').slice(0, 4).join('\n');
    if (stderr) console.log('        ' + stderr.replace(/\n/g, '\n        '));
  }
}

console.log('\nПроверено файлов: ' + files.length + ', ошибок: ' + failed);
process.exit(failed ? 1 : 0);
