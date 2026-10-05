// Запуск всех тестов подряд: node tools/run-tests.js
//
// Тесты, которым нужен браузер (test_parser_svg.py на playwright), здесь
// не запускаются — они помечены как опциональные и описаны в README.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const suites = [
  ['test_hand_eval.js', 'Оценщик комбинаций и эквити'],
  ['test_range_equity.js', 'Эквити против диапазона'],
  ['test_preflop_ranges.js', 'Префлоп-диапазоны по позициям'],
  ['test_postflop_ranges.js', 'Постфлоп-диапазоны и решения'],
  ['test_action_logic.js', 'Разбор действий и решения'],
  ['test_frame_diff.js', 'Сравнение кадров (dhash)'],
  ['test_parser_node.js', 'Парсер карт из DOM/SVG'],
  ['test_dom_e2e.js', 'E2E: мок-стол → карты → эквити']
];

let failed = 0;
const results = [];

for (const [file, title] of suites) {
  console.log('\n' + '='.repeat(60));
  console.log('== ' + title + ' (' + file + ')');
  console.log('='.repeat(60));
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(root, file)], { stdio: 'inherit' });
  const ms = Date.now() - started;
  const ok = res.status === 0;
  if (!ok) failed++;
  results.push({ file, title, ok, ms });
}

console.log('\n' + '='.repeat(60));
console.log('ИТОГ');
for (const r of results) {
  console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + '  ' + r.title + '  (' + r.ms + ' мс)');
}
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
