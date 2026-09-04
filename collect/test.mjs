// 収集ロジックの自己テスト。ネットワーク不要。
//   node --test collect/test.mjs
//
// ここでテストするのは「静かに間違った数字を出しうる」部分だけ。
// 実際に踏んだ誤りは必ず回帰テストとして残す。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTables, toYen, cellText } from './lib/table.mjs';
import { findBlocks, parseDefinitionLists, headingChains } from './lib/dom.mjs';
import { computeEffectiveMonthly, expandMonthly, dedupeAcrossPages } from './lib/effective.mjs';
import { parseBenefitByEntry, gradesInService, readBasePriceList, readDiscountExemptGrades } from './adapters/so-net-hikari.mjs';
import { recordOutcome, shouldFail, escalated } from './lib/failures.mjs';
import { reconstructSeries, planSlug, planSlugsFor } from '../site/lib/series.mjs';
import { staleInfo } from '../site/lib/stale.mjs';

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

// ── dom（<dl> で書かれた料金表・ブロック抽出）──────────────────

test('class は語として一致させる（部分一致で別要素を拾わない）', () => {
  const html = '<div class="cost-wrap-x">誤</div><div class="a cost-wrap b">正</div>';
  const found = findBlocks(html, 'div', 'cost-wrap');
  assert.equal(found.length, 1);
  assert.match(found[0].html, /正/);
});

test('同じクラスが入れ子でも外側だけを返す', () => {
  const html = '<div class="box"><div class="box">内</div></div>';
  assert.equal(findBlocks(html, 'div', 'box').length, 1);
});

test('<dl> を 項目名→値 に開く', () => {
  const html = '<dl><dt>月額基本料金</dt><dd>6,270円</dd><dt>回線工事費</dt><dd>2,420円</dd></dl>';
  assert.deepEqual(parseDefinitionLists(html)[0].pairs, [
    ['月額基本料金', '6,270円'],
    ['回線工事費', '2,420円'],
  ]);
});

test('1つの dt に複数の dd がぶら下がる場合は結合する', () => {
  const html = '<dl><dt>月額基本料金</dt><dd>6,270円</dd><dd>（最大）</dd></dl>';
  assert.deepEqual(parseDefinitionLists(html)[0].pairs, [['月額基本料金', '6,270円 （最大）']]);
});

test('見出しの連なりは、浅い見出しが来たら深い階層を捨てる', () => {
  // 「戸建」の節が終わったあとに、前の節の小見出しを引きずってはいけない
  const html = '<h4>新設</h4><h6>戸建</h6><h4>転用</h4><span id="here"></span>';
  const chain = headingChains(html)(html.indexOf('<span'));
  assert.deepEqual(chain, ['転用']);
});

test('全角マイナスの割引を負値として読む', () => {
  assert.equal(toYen('月額基本料金割引 －2,290円'), -2290);
});

// ── 失敗の持ち越し（静かに壊れないための要）──────────────────────
//
// 2026-08-24に実測して分かった欠陥の回帰テスト。
// 収集元を1つ壊しても「半分以上失敗」の閾値に届かず終了コード0で通っていた。

test('1回の失敗では赤くしない（一時的な不調を狼少年にしない）', () => {
  const state = { sources: {} };
  recordOutcome(state, 'a', false, { status: 'unreachable' });
  recordOutcome(state, 'b', true);
  assert.deepEqual(shouldFail(state, ['a', 'b'], 1), []);
});

test('2回続けて失敗したら赤くする（収集元が1つでも静かに死なせない）', () => {
  const state = { sources: {} };
  const keys = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 2; i++) recordOutcome(state, 'a', false, { status: 'unreachable' });
  for (const k of ['b', 'c', 'd']) recordOutcome(state, k, true);
  const reasons = shouldFail(state, keys, 1);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /2回続けて失敗/);
});

test('一度に半分以上落ちたら、回数によらず即座に赤くする', () => {
  const state = { sources: {} };
  const keys = ['a', 'b', 'c'];
  for (const k of keys) recordOutcome(state, k, false, { status: 'unreachable' });
  const reasons = shouldFail(state, keys, 3);
  assert.ok(reasons.some((r) => /同時に失敗/.test(r)));
});

test('成功したら連続失敗をリセットし、更新停止の起点も消す', () => {
  const state = { sources: {} };
  recordOutcome(state, 'a', false, { status: 'unreachable' });
  recordOutcome(state, 'a', false, { status: 'unreachable' });
  assert.equal(state.sources.a.consecutive, 2);
  assert.ok(state.sources.a.staleSince);
  recordOutcome(state, 'a', true);
  assert.equal(state.sources.a.consecutive, 0);
  assert.equal(state.sources.a.staleSince, null);
});

test('staleSince は最初に失敗した時刻を保つ（失敗のたびに更新しない）', () => {
  const state = { sources: {} };
  recordOutcome(state, 'a', false, { status: 'unreachable' });
  const first = state.sources.a.staleSince;
  recordOutcome(state, 'a', false, { status: 'unreachable' });
  assert.equal(state.sources.a.staleSince, first, 'サイト側で「◯日更新停止中」を出せなくなる');
});

test('escalated は閾値に達した収集元だけを返す', () => {
  const state = { sources: {} };
  recordOutcome(state, 'a', false, {});
  recordOutcome(state, 'b', false, {});
  recordOutcome(state, 'b', false, {});
  assert.deepEqual(escalated(state).map((e) => e.key), ['b']);
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

// ★2026-08-25 に実際に踏んだ欠陥の再発防止。
//   アダプタは「特典の有無が読めなかった」ことを cashbacks = null で伝える設計だったが、
//   計算側が `?? []` で空配列に読み替えていたため、**特典0円として計算が通っていた**。
//   「特典なし（[]）」と「読めなかった（null）」は別物として扱う。
test('キャッシュバックが読めていない（null）なら実質月額は null', () => {
  const o = nuroHouse2Giga();
  o.cashbacks = null;
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.effectiveMonthly, null);
  assert.ok(r.missing.includes('cashbacks'));
});

test('キャッシュバックの欄が無い（undefined）場合も null にする', () => {
  const o = nuroHouse2Giga();
  delete o.cashbacks;
  const r = computeEffectiveMonthly(o, 36);
  assert.equal(r.effectiveMonthly, null);
  assert.ok(r.missing.includes('cashbacks'));
});

test('特典が無い（空配列）ことは事実として計算に通す', () => {
  const o = nuroHouse2Giga();
  o.cashbacks = [];
  const r = computeEffectiveMonthly(o, 36);
  // 10,000円のキャッシュバックが無くなるぶんだけ実質月額は上がる
  assert.equal(r.total, 167460);
  assert.deepEqual(r.missing, []);
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

// ── So-net光: S/M/L グレードの取り違えを防ぐ ─────────────────────
//
// ★2026-08-25、当サイトは So-net 光 1ギガの **Mプランだけ**を「1ギガ」として載せていた。
//   S/L は別ページ /access/hikari/1g/ にしか無く、そこは特典の書き方も違った。
//   同じキャンペーンが2つの書式で書かれているので、両方を読めないと
//   「Mの15,000円をSにも付ける」「Sは特典対象外なのに読めないと言い張る」のどちらかが起きる。

test('特典の対象サービスからグレードを取る（Mだけの特典をS/Lに付けない）', () => {
  assert.deepEqual(gradesInService('So-net 光 1ギガ（So-net 光 M）'), ['M']);
  assert.deepEqual(gradesInService('So-net 光 1ギガ（So-net 光 S/M/L）'), ['S', 'M', 'L']);
  assert.equal(gradesInService('So-net 光 10ギガ'), null); // 括弧書きなし＝そのサービス全体
});

test('特典内容が申込区分ごと（トップページの書式）', () => {
  const r = parseBenefitByEntry(
    'お申し込みの住居タイプ・回線種別について、以下の金額をキャッシュバックします。' +
    ' ■戸建・マンション共通 ・新設の場合：15,000円 ・転用/事業者変更の場合：対象外'
  );
  assert.deepEqual(r['新設'], { '*': 15000 });
  assert.deepEqual(r['転用/事業者変更'], { '*': 0 }); // 「対象外」は不明ではなく0円という事実
});

test('特典内容がグレード別（1ギガ専用ページの書式）', () => {
  const r = parseBenefitByEntry(
    ' ■戸建・マンション共通 ・新設の場合 So-net 光 S：対象外 So-net 光 M：15,000円 So-net 光 L：対象外' +
    ' ・転用/事業者変更の場合 So-net 光 S/M/L共通：対象外'
  );
  assert.deepEqual(r['新設'], { S: 0, M: 15000, L: 0 });
  assert.deepEqual(r['転用/事業者変更'], { S: 0, M: 0, L: 0 });
});

test('「各プランの通常月額基本料金」の一覧を住居タイプごとに割る', () => {
  const r = readBasePriceList(
    '各プランの通常月額基本料金 ■戸建 ・So-net 光 S：4,500円 ・So-net 光 M：5,995円 ・So-net 光 L：7,095円' +
    ' ■マンション ・So-net 光 S：3,400円 ・So-net 光 M：4,895円 ・So-net 光 L：5,995円'
  );
  assert.deepEqual(r.S, { 戸建: 4500, マンション: 3400 });
  assert.deepEqual(r.L, { 戸建: 7095, マンション: 5995 });
});

test('割引対象外グレードは「対象外」と明記されているものだけ', () => {
  const yes = readDiscountExemptGrades('・So-net 光 S/L共通 新設・転用・事業者変更すべて：特典対象外');
  assert.deepEqual([...yes].sort(), ['L', 'S']);
  // ★書いていなければ「割引が無い」と決めつけない。空集合＝観測を作らない側に倒れる
  assert.equal(readDiscountExemptGrades('・So-net 光 M 新設の場合：1～23カ月目 2,695円割引').size, 0);
});

// ── 複数ページに同じプランが載っている場合 ───────────────────────

const twoPageOffer = (url, monthly) => ({
  planKey: '1ギガ / 戸建 / 回線新設でお申し込み / 派遣工事',
  sourceUrl: url,
  verified: true,
  monthlySchedule: [{ fromMonth: 1, toMonth: null, amount: monthly }],
  adminFee: 3500,
  constructionFee: { monthlySchedule: [], discountSchedule: [] },
  cashbacks: [],
  requiredOptions: [],
});

test('同じプランが2ページに載っていて一致すれば1件にまとめる', () => {
  const warnings = [];
  const { merged, conflicts } = dedupeAcrossPages(
    [twoPageOffer('https://example.com/a', 5995), twoPageOffer('https://example.com/b', 5995)],
    warnings
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].alsoSeenAt, ['https://example.com/b']);
  assert.deepEqual(conflicts, []);
});

test('ページ間で食い違えば、どちらも公開しない（正しそうな方を選ばない）', () => {
  const warnings = [];
  const { merged, conflicts } = dedupeAcrossPages(
    [twoPageOffer('https://example.com/a', 5995), twoPageOffer('https://example.com/b', 6270)],
    warnings
  );
  assert.equal(conflicts.length, 1);
  assert.equal(merged.length, 2);              // 「消えた」ことにしないため両方残す
  assert.ok(merged.every((o) => o.verified === false));
  assert.equal(warnings.length, 1);
});

// ── 推移の復元（site/lib/series.mjs） ────────────────────────────
//
// 日次スナップショットを持たず、現在値と変化イベントから過去を復元している。
// ここが静かに間違うと、**存在しなかった料金がグラフに出る**。

const ev = (detectedAt, before, after, previousObservedAt = null) => ({
  type: 'effective-monthly-changed', planKey: 'P', horizonMonths: 36,
  detectedAt, before, after, previousObservedAt,
});

test('変化イベントが無いとき、過去に線を伸ばさない', () => {
  const r = reconstructSeries({
    planKey: 'P', currentValue: 4000, currentAt: '2026-09-04T00:00:00Z',
    events: [], horizonMonths: 36,
  });
  assert.equal(r.ok, true);
  assert.equal(r.flat, true);
  assert.equal(r.points.length, 1);   // ★1点。横一直線を引くと「ずっとこの値だった」と主張してしまう
});

test('イベントを繋いで過去の値を復元する', () => {
  const r = reconstructSeries({
    planKey: 'P', currentValue: 4235, currentAt: '2026-09-04T00:00:00Z',
    events: [ev('2026-08-23T00:00:00Z', 4374, 4235, '2026-08-22T00:00:00Z')],
    horizonMonths: 36,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.points.map((p) => p.value), [4374, 4235, 4235]);
  assert.equal(r.points[0].at, '2026-08-22T00:00:00Z');
});

test('最後の変化と現在値が食い違うなら、グラフを描かない', () => {
  const r = reconstructSeries({
    planKey: 'P', currentValue: 9999, currentAt: '2026-09-04T00:00:00Z',
    events: [ev('2026-08-23T00:00:00Z', 4374, 4235)],
    horizonMonths: 36,
  });
  assert.equal(r.ok, false);          // ★イベントが欠けている。それらしい線を引かない
});

test('イベントの連なりが途切れているなら、グラフを描かない', () => {
  const r = reconstructSeries({
    planKey: 'P', currentValue: 4000, currentAt: '2026-09-04T00:00:00Z',
    events: [ev('2026-08-20T00:00:00Z', 4500, 4300), ev('2026-08-25T00:00:00Z', 4100, 4000)],
    horizonMonths: 36,
  });
  assert.equal(r.ok, false);          // 4300 のあと 4100 から変化＝間の変化を取りこぼしている
});

test('別プラン・別期間のイベントを混ぜない', () => {
  const other = { ...ev('2026-08-23T00:00:00Z', 1, 2), planKey: 'Q' };
  const h24 = { ...ev('2026-08-23T00:00:00Z', 1, 2), horizonMonths: 24 };
  const r = reconstructSeries({
    planKey: 'P', currentValue: 4000, currentAt: '2026-09-04T00:00:00Z',
    events: [other, h24], horizonMonths: 36,
  });
  assert.equal(r.flat, true);
});

test('プランのURLは planKey が同じなら毎回同じになる', () => {
  const a = planSlug('nuro-hikari', '戸建て / 2ギガ / 2年割', { buildingType: 'detached', speed: '2ギガ' });
  const b = planSlug('nuro-hikari', '戸建て / 2ギガ / 2年割', { buildingType: 'detached', speed: '2ギガ' });
  assert.equal(a, b);
  assert.match(a, /^detached-2g-[0-9a-f]{8}$/);
  // 事業者が違えば別URLになる
  assert.notEqual(a, planSlug('so-net-hikari', '戸建て / 2ギガ / 2年割', { buildingType: 'detached', speed: '2ギガ' }));
});

test('プランのURLが衝突したらビルドを止める', () => {
  const same = { providerId: 'x', planKey: 'A', plan: {} };
  assert.doesNotThrow(() => planSlugsFor([same, { ...same, planKey: 'B' }]));
  // 同じ planKey が2回来ても衝突扱いにしない（ページ間で同一プランを見たとき）
  assert.doesNotThrow(() => planSlugsFor([same, same]));
});

// ── 更新停止中の判定（site/lib/stale.mjs） ──────────────────────
//
// ★2026-09-04 に実際に起きた事故の回帰テスト。
//   NURO光の実質月額の算出が4日間失敗していたのに、サイトは8/30の値を
//   「更新停止中」の表示なしで、他社の最新値と並べて出していた。

const failures = {
  sources: {
    'prices:https://www.nuro.jp/hikari/house/price/': { lastOkAt: '2026-09-03T21:28:43.909Z', staleSince: null },
    'health:https://www.nuro.jp/hikari/house/price/': { lastOkAt: '2026-09-03T21:29:35.162Z', staleSince: null },
    'effective:nuro-hikari': { lastOkAt: '2026-08-30T21:25:10.144Z', staleSince: '2026-08-31T21:25:33.152Z' },
    'effective:rakuten-hikari': { lastOkAt: '2026-09-03T21:28:54.549Z', staleSince: null },
  },
};

test('ページは取れているが算出に失敗している事業者を、更新停止中と判定する', () => {
  // ★これが null を返していたのが事故の原因。prices:/health: は正常なので見逃していた
  const s = staleInfo(failures, 'https://www.nuro.jp/hikari/house/price/', 'nuro-hikari');
  assert.ok(s, '更新停止中と判定されるべき');
  assert.equal(s.since, '2026-08-31T21:25:33.152Z');
});

test('事業者IDを渡さなければ、以前と同じくURLだけで判定する', () => {
  assert.equal(staleInfo(failures, 'https://www.nuro.jp/hikari/house/price/'), null);
});

test('全部正常なら null', () => {
  assert.equal(staleInfo(failures, 'https://www.nuro.jp/hikari/house/price/', 'rakuten-hikari'), null);
});

test('複数該当するときは、いちばん長く止まっているほうを返す', () => {
  const f = {
    sources: {
      'prices:https://x.example/a': { staleSince: '2026-09-02T00:00:00Z' },
      'effective:x': { staleSince: '2026-08-20T00:00:00Z' },
    },
  };
  // 新しいほうを返すと、止まっている期間を実際より短く見せてしまう
  assert.equal(staleInfo(f, 'https://x.example/a', 'x').since, '2026-08-20T00:00:00Z');
});
