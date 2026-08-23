// 収集ロジックの自己テスト。ネットワーク不要。
//   node --test collect/test.mjs
//
// ここでテストするのは「静かに間違った数字を出しうる」部分だけ。
// 実際に踏んだ誤りは必ず回帰テストとして残す。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTables, toYen, cellText } from './lib/table.mjs';
import { computeEffectiveMonthly, expandMonthly } from './lib/effective.mjs';

// ── toYen ────────────────────────────────────────────────────────

test('注記番号を金額に取り込まない（実際に踏んだ誤り）', () => {
  // 空白を除くと「※1」と「5,720」が繋がり 15,720円 と誤読していた
  assert.equal(toYen('月額基本料金 ※1 5,720円'), 5720);
  assert.equal(toYen('基本工事費 ※2 2,074円'), 2074);
});

test('0円 と 未記載 を区別する', () => {
  assert.equal(toYen('0円'), 0);
  assert.equal(toYen('ー'), null);   // 全角ダッシュ（該当なし）
  assert.equal(toYen('−'), null);
  assert.equal(toYen(''), null);
  assert.equal(toYen(null), null);
});

test('割引の負号を保つ', () => {
  assert.equal(toYen('2年割 -1,740円/月'), -1740);
  assert.equal(toYen('工事費相当割引 -2,062円'), -2062);
});

test('プラン名の数字を金額と誤らない', () => {
  assert.equal(toYen('U29応援割 -2,620円'), -2620);
  assert.equal(toYen('10ギガプラン'), null);
});

test('先頭の金額を採る（後続の別項目に引きずられない）', () => {
  assert.equal(toYen('3,980円 別途、契約事務手数料3,300円が発生'), 3980);
});

// ── parseTables ──────────────────────────────────────────────────

test('colspan を複製して列位置を揃える', () => {
  const { tables } = parseTables('<table><tr><td colspan="2">A</td><td>B</td></tr></table>');
  assert.deepEqual(tables[0].rows[0], ['A', 'A', 'B']);
});

test('rowspan を次の行に繰り越す', () => {
  const html = '<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>';
  const { tables } = parseTables(html);
  assert.deepEqual(tables[0].rows, [['A', 'B'], ['A', 'C']]);
});

test('入れ子の table を取り違えない', () => {
  // 正規表現の非貪欲マッチだと外側の table が最初の </table> で閉じてしまう。
  //   お知らせ抽出で同じ形の誤りを踏んでいる
  const html = '<table><tr><td><table><tr><td>内</td></tr></table></td></tr></table>';
  const { tables } = parseTables(html);
  assert.equal(tables.length, 1, '外側だけを1つ返す（内側は入れ子として含まれる）');
  assert.match(tables[0].html, /内/);
});

test('script と HTMLコメントの中身を値にしない', () => {
  const html = '<table><tr><td>実<script>var x="偽";</script><!-- 偽 --></td></tr></table>';
  const { tables } = parseTables(html);
  assert.equal(tables[0].rows[0][0], '実');
});

test('文字実体参照を戻す', () => {
  assert.equal(cellText('5,720&nbsp;円'), '5,720 円');
});

// ── expandMonthly ────────────────────────────────────────────────

test('期間に隙間があれば null（黙って埋めない）', () => {
  assert.equal(expandMonthly([{ fromMonth: 1, toMonth: 12, amount: 100 }], 24), null);
});

test('期間が重なっていれば null', () => {
  const s = [
    { fromMonth: 1, toMonth: 24, amount: 100 },
    { fromMonth: 12, toMonth: null, amount: 200 },
  ];
  assert.equal(expandMonthly(s, 24), null);
});

test('末尾が開いていれば最後まで伸ばす', () => {
  const s = [
    { fromMonth: 1, toMonth: 2, amount: 100 },
    { fromMonth: 3, toMonth: null, amount: 200 },
  ];
  assert.deepEqual(expandMonthly(s, 4), [100, 100, 200, 200]);
});

// ── computeEffectiveMonthly ──────────────────────────────────────

/** NURO光 戸建て / 2ギガ / 2年割 の実データ相当（2026-08-23に実物で確認した値） */
function nuroHouse2Giga() {
  return {
    monthlySchedule: [
      { fromMonth: 1, toMonth: 1, amount: 3980 },
      { fromMonth: 2, toMonth: 24, amount: 3980 },
      { fromMonth: 25, toMonth: null, amount: 5720 },
    ],
    adminFee: 3300,
    constructionFee: {
      monthlySchedule: [
        { fromMonth: 1, toMonth: 1, amount: 2074 },
        { fromMonth: 2, toMonth: 24, amount: 2062 },
        { fromMonth: 25, toMonth: null, amount: 0 },
      ],
      discountSchedule: [
        { fromMonth: 1, toMonth: 1, amount: 2074 },
        { fromMonth: 2, toMonth: 24, amount: 2062 },
        { fromMonth: 25, toMonth: null, amount: 0 },
      ],
    },
    cashbacks: [{ amount: 10000, receiveAtMonth: 18 }],
    requiredOptions: [],
  };
}

test('実質月額が手計算と一致する', () => {
  const r = computeEffectiveMonthly(nuroHouse2Giga(), 36);
  // (3,980×24 + 5,720×12 + 3,300 - 10,000) ÷ 36 = 157,460 ÷ 36
  assert.equal(r.total, 157460);
  assert.equal(r.effectiveMonthly, 4374);
  assert.deepEqual(r.missing, []);
});

test('工事費が期間内に割引で相殺されれば実負担は0', () => {
  const r = computeEffectiveMonthly(nuroHouse2Giga(), 36);
  assert.equal(r.breakdown.constructionBorne, 0);
});

test('受取時期が計算期間を超えるキャッシュバックは算入しない', () => {
  const o = nuroHouse2Giga();
  o.cashbacks = [{ amount: 60000, receiveAtMonth: 48 }];
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.breakdown.cashbackCounted, 0);
  assert.equal(r.breakdown.excludedCashback.length, 1);
});

test('一項目でも欠ければ実質月額は null（推定で埋めない）', () => {
  const o = nuroHouse2Giga();
  o.adminFee = null;
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.effectiveMonthly, null);
  assert.ok(r.missing.includes('adminFee'));
});

test('受取時期が不明なキャッシュバックは全体を null にする', () => {
  const o = nuroHouse2Giga();
  o.cashbacks = [{ amount: 10000, receiveAtMonth: null }];
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.effectiveMonthly, null);
});

test('必須オプションは加入必要月数ぶんだけ加算する', () => {
  const o = nuroHouse2Giga();
  o.requiredOptions = [{ name: 'ひかりTV', monthlyFee: 1000, requiredMonths: 6 }];
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.breakdown.optionTotal, 6000);
  assert.equal(r.total, 163460);
});
