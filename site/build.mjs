// build — data/ から静的サイトを生成する。依存パッケージなし。
//
// ★原則: **表示する値は data/ から取るだけ。ここで計算しない。**
//   サイト側で計算し直すと、公開している数字とデータの数字が食い違いうる。
//   受け入れ基準 A-007 は「画面の値が data/ と一致すること」なので、一致は構造で保証する。
//
// ★出典と時点を必ず併記する（docs/03 の運用ルール）。例外は作らない。
// ★更新が止まっている事業者は「更新停止中」と明示する（docs/04 の品質ゲート5）。
//
// 使い方:
//   node site/build.mjs                 # site/dist/ に出力
//   node site/build.mjs --check         # 出力せず、表示予定の値とdata/の一致を検証

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, layout, jsonLd, e } from './lib/html.mjs';
import { yen, yenSigned, jstDateTime, jstDate, isoDate, daysSince, host, planName } from './lib/format.mjs';
import { planSlugsFor, reconstructSeries } from './lib/series.mjs';
import { stepChart, sparkline, CHART_CSS } from './lib/chart.mjs';
import { staleInfo } from './lib/stale.mjs';
import { searchConsoleToken } from './lib/owner.mjs';
import { loadMobile, renderMobile, mobileLlms } from './mobile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(HERE, 'dist');

export const SITE_URL = 'https://tsushinhi-index.com';
const SITE_NAME = '通信費インデックス';

// トップの条件切り替え。素のJSファイルをそのまま配信する（site/app.js の先頭に方針）
const APP_JS = await readFile(join(HERE, 'app.js'), 'utf8');

// 全社を横並びにできる唯一の軸。collect 側の PRIMARY と必ず一致させること
const HORIZON = 36;

// これ日数を超えて更新できていない収集元は「更新停止中」と明示する
const STALE_DAYS = 3;

// 広告リンクの条件は手で確認して記録する（自動収集できない）。
// ★手で書いた事実は自動で直らないので、確認から離れたら出すのをやめる。
const AD_CONFIRM_MAX_DAYS = 60;

async function main() {
  const checkOnly = process.argv.includes('--check');
  const data = await loadAll();

  const problems = verify(data);
  if (problems.length) {
    console.error('表示前の検証に失敗:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`検証OK: ${data.offers.length}観測 / 掲載可 ${data.publishable.length} / 要確認 ${data.needsReview.length}`);

  if (checkOnly) return;

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 広告表記は全ページのヘッダ直下（ファーストビュー）に置く。広告が無ければ空文字
  const disclosure = adDisclosure(data);
  const pending = [];

  // ★所有権確認タグは全ページに入れる。Googleはトップにあれば足りるが、
  //   確認後に外すと所有権が失効する。1か所にしか無いと、ページ構成を
  //   いじった拍子に黙って消える。
  const siteHead = data.owner.searchConsoleToken
    ? `<meta name="google-site-verification" content="${data.owner.searchConsoleToken}">
`
    : '';
  if (!siteHead) console.warn('  ⚠ Search Console の所有権確認タグが未設定です（インデックス状況を確認できません）');
  await page('index.html', renderIndex(data), disclosure, siteHead);
  await page('changes/index.html', renderChanges(data), disclosure, siteHead);
  const days = eventsByDay(data);
  days.forEach(([day, list], i) => {
    // days は新しい順。prev＝1つ古い日、next＝1つ新しい日
    pending.push(page(`changes/${day}/index.html`, renderChangeDay(data, day, list, days[i + 1]?.[0], days[i - 1]?.[0]), disclosure, siteHead));
  });
  await Promise.all(pending);
  console.log(`  変化の日別ページ ${days.length}件`);
  await page('method/index.html', renderMethod(data), disclosure, siteHead);
  await page('data/index.html', renderData(data), disclosure, siteHead);
  await page('about/index.html', renderAbout(data), disclosure, siteHead);
  await page('privacy/index.html', renderPrivacy(data), disclosure, siteHead);
  await page('contact/index.html', renderContact(data), disclosure, siteHead);

  // 事業者ページとプランページ。掲載可のものだけ（要確認の値をURLで指せるようにしない）
  for (const id of providerIds(data)) {
    await page(`p/${id}/index.html`, renderProvider(data, id), disclosure, siteHead);
  }
  for (const o of data.publishable) {
    await page(`p/${o.providerId}/${o.slug}/index.html`, renderPlan(data, o), disclosure, siteHead);
  }
  console.log(`  事業者ページ ${providerIds(data).length}件 / プランページ ${data.publishable.length}件`);

  // スマホ料金（data/mobile/）。光回線の data とは混ぜない（collect/effective.mjs の dirsFor を参照）
  const mobile = await loadMobile(ROOT, data.failures, STALE_DAYS);
  await page('mobile/index.html', renderMobile(mobile, { siteName: SITE_NAME, siteUrl: SITE_URL, breadcrumb }), disclosure, siteHead);
  console.log(`  スマホ料金ページ: ${new Set(mobile.live.map((o) => o.providerId)).size}社 / ${mobile.live.length}プラン（記録停止 ${mobile.paused.length}・掲載保留 ${mobile.offers.length - mobile.publishable.length}）`);

  await out('style.css', STYLE);
  await out('app.js', APP_JS);
  await out('favicon.svg', FAVICON);
  await out('llms.txt', renderLlmsTxt(data) + mobileLlms(mobile));
  await out('sitemap.xml', renderSitemap(data));
  await out('feed.xml', renderFeed(data));
  await out('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  console.log(`生成: site/dist/`);
}

// ── データ読み込み ───────────────────────────────────────────────

/**
 * 広告を読む。★条件を満たさないものは黙って落とす（出さない側に倒す）。
 *
 * 落とす条件と理由:
 *   adCode が空                      … 貼るものが無い
 *   confirmedAt / confirmedNote が空 … 人が確認した証跡が無い。確認していないものは出さない
 *   確認から日が経ちすぎている       … 手で書いた事実は自動で直らない
 *   mode が無い / differenceNote が空 … 飛び先が出典と同条件かどうかを判断できない
 * 詳細は site/affiliate.json と docs/03_法務コンプラ.md の 6-5。
 */
async function loadAds() {
  const conf = (await readJson(join(HERE, 'affiliate.json'))) ?? { links: [] };
  const same = new Map();     // 飛び先の条件＝出典の条件。比較表の行にリンクを出す
  const different = [];       // 飛び先が別条件。行には出さず、独立ブロックで別物として出す

  for (const a of conf.links ?? []) {
    // ★adCode は ASP が生成したコードそのもの。url を受け取らないのは意図的で、
    //   リンク部分だけ抜き出して自前のボタンを作るのが広告素材の改変にあたるため。
    if (!String(a.adCode ?? '').trim() || !a.providerId) continue;
    if (!a.confirmedAt || !String(a.confirmedNote ?? '').trim()) continue;

    // ★手で記録した事実は放っておくと古くなる。収集値と違って自動で直らない。
    //   古い条件のまま広告を出し続けるのは「事実と異なる情報」になる。
    const age = daysSince(a.confirmedAt);
    if (age != null && age > AD_CONFIRM_MAX_DAYS) {
      console.warn(`広告リンクを出しません（確認から${age}日経過・上限${AD_CONFIRM_MAX_DAYS}日）: ${a.providerId}`);
      continue;
    }

    if (a.mode === 'same') same.set(a.providerId, a);
    else if (a.mode === 'different' && String(a.differenceNote ?? '').trim()) different.push(a);
    else console.warn(`広告リンクを出しません（mode か differenceNote が不足）: ${a.providerId}`);
  }
  return { same, different };
}

/** 掲載可の観測がある事業者だけ。1件も無い事業者のページを作らない（中身が空になる） */
const providerIds = (data) => [...new Set(data.publishable.map((o) => o.providerId))];

/** 広告リンクを1本でも出すか。出さないなら広告表記も出さない（無いのに「広告あり」と書くのも嘘） */
const hasAds = (data) => data.ads.same.size > 0 || data.ads.different.length > 0;

/**
 * 運営者情報を読む。
 *
 * ★メールアドレスは `emailConfirmedAt` が入るまで出さない。
 *   まだ作られていない受信箱を問い合わせ先として掲げると、
 *   送った人のメールが**どこにも届かないまま黙って消える**。それが一番やってはいけない壊れ方。
 *   出せない間も窓口を閉じないため、GitHub Issues を必ず開けておく。
 */
async function loadOwner() {
  const o = (await readJson(join(HERE, 'owner.json'))) ?? {};
  const emailUsable = Boolean(o.email && o.emailConfirmedAt);
  if (o.email && !emailUsable) {
    console.warn(`  ⚠ ${o.email} は site/owner.json の emailConfirmedAt が空なので画面に出しません（受信できる確認が取れていない）`);
  }
  return { ...o, emailUsable, email: emailUsable ? o.email : null, searchConsoleToken: searchConsoleToken(o) };
}


async function loadAll() {
  const effective = await readDir(join(ROOT, 'data', 'effective'));
  const changes = await readDir(join(ROOT, 'data', 'effective-changes'));
  const failures = (await readJson(join(ROOT, 'data', 'failures.json'))) ?? { sources: {} };
  const health = await readJson(join(ROOT, 'data', 'health.json'));

  const offers = [];
  for (const snap of effective) {
    // ★URLは事業者ごとに一括で作る。衝突していたら例外を投げてビルドを止める。
    //   同じURLの2プランを黙って出すと、片方が消えたことに誰も気づけない。
    const slugs = planSlugsFor(snap.offers.map((o) => ({ ...o, providerId: snap.providerId })));
    for (const o of snap.offers) {
      const slug = slugs.get(o.planKey);
      offers.push({
        ...o,
        providerName: snap.providerName,
        providerId: snap.providerId,
        observedAt: o.observedAt ?? snap.observedAt,
        formula: snap.formula,
        building: normalizeBuilding(o),
        entry: normalizeEntry(o),
        effectiveMonthly: o.effective?.[HORIZON]?.effectiveMonthly ?? null,
        breakdown: o.effective?.[HORIZON]?.breakdown ?? null,
        stale: staleInfo(failures, o.sourceUrl, snap.providerId),
        slug,
        id: `${snap.providerId}--${slug}`,
        path: `/p/${snap.providerId}/${slug}/`,
      });
    }
  }

  // 収集を止めた事業者（遮断の意思表示を尊重して対象外にしたもの）。
  // ★理由は collect/targets.json の1か所にだけ書く。サイトはそれを読んで出す（二重管理しない）
  const targets = (await readJson(join(ROOT, 'collect', 'targets.json'))) ?? { niches: [] };
  const excluded = new Map(
    targets.niches
      .filter((n) => n.status === 'excluded' && n.excludedAt)
      .map((n) => [n.id, { since: n.excludedAt, publicNote: n.publicNote ?? null }])
  );
  for (const o of offers) {
    o.excluded = excluded.get(o.providerId) ?? null;
    // ★順位に入れてよいのは「いま記録が続いているもの」だけ。
    //   2026-11-20 まで、18日前の NURO光・9日前の So-net光の値が、トップの「答え」の
    //   上位3件に「更新停止中」の印なしで並んでいた（表の行には印があったが、答えの欄には無かった）。
    //   古い値を今日の順位に混ぜるのは、それ自体が「事実と異なる表示」になる。
    o.paused = Boolean(o.excluded) || Boolean(o.stale && o.stale.days >= STALE_DAYS);
    o.speedClass = /10ギガ/.test(`${o.planLabel ?? ''} ${o.planKey ?? ''} ${o.plan?.speed ?? ''}`) ? '10g' : 'other';
  }

  // 掲載できるのは「検算を通り、記載の食い違いが無く、実質月額が出ているもの」だけ
  const publishable = offers.filter((o) => o.publishable && o.effectiveMonthly != null);
  const needsReview = offers.filter((o) => !(o.publishable && o.effectiveMonthly != null));
  const ranked = publishable.filter((o) => !o.paused);
  const paused = publishable.filter((o) => o.paused);

  const events = [];
  for (const store of changes) {
    for (const batch of store.events) {
      for (const c of batch.changes) {
        events.push({ ...c, detectedAt: batch.detectedAt, providerName: store.providerName, providerId: store.providerId });
      }
    }
  }
  events.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));

  const updatedAt = effective.map((s) => s.observedAt).sort().pop() ?? new Date().toISOString();

  const operators = ((await readJson(join(HERE, 'providers.json'))) ?? {}).operators ?? {};

  return {
    effective, offers, publishable, needsReview, ranked, paused, excluded, events, failures, health, updatedAt,
    notices: await loadNotices(publishable),
    ads: await loadAds(),
    owner: await loadOwner(),
    operators,
    // ★「3社」と書かない。NURO光とSo-net光は同じ会社なので、サービス数と会社数は違う。
    serviceCount: new Set(publishable.map((o) => o.providerId)).size,
    operatorCount: new Set(publishable.map((o) => operators[o.providerId]?.name).filter(Boolean)).size,
  };
}

/**
 * 各社公式のお知らせ（収集の主系統）。事業者ページの「公式発表の年表」に使う。
 * ★料金・条件に関わる可能性があるもの（relevant）だけ。障害・メンテナンスは出さない。
 * ★表示の仕方は docs/research/2026-11-20_サイト刷新の表示可否.md の判定に従う。
 */
async function loadNotices(publishable) {
  const ids = new Set(publishable.map((o) => o.providerId));
  const out = new Map();
  for (const store of await readDir(join(ROOT, 'data', 'notices'))) {
    if (!ids.has(store.providerId)) continue;
    const list = (store.notices ?? [])
      .filter((n) => n.relevant && n.date && n.url)
      .sort((a, b) => b.date.localeCompare(a.date));
    out.set(store.providerId, { list, sourceUrl: store.sourceUrl, lastCollectedAt: store.lastCollectedAt });
  }
  return out;
}

async function readDir(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    const j = await readJson(join(dir, n));
    if (j) out.push(j);
  }
  return out;
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

// ── 事業者ごとに違う軸を、比較できる形に揃える ────────────────────

/** 建物タイプ。事業者ごとに呼び方が違うので揃える */
function normalizeBuilding(o) {
  const t = o.plan?.buildingType;
  if (t === 'apartment') return 'マンション';
  if (t === 'detached') return '戸建て';
  const b = o.plan?.building ?? '';
  if (/共通/.test(b)) return '共通';
  if (/マンション|集合/.test(b)) return 'マンション';
  if (/戸建/.test(b)) return '戸建て';
  return '共通';
}

/** 申込区分。書いていない事業者は新規申込のページなので新規として扱う */
function normalizeEntry(o) {
  const s = `${o.plan?.entry ?? ''}`;
  if (/転用|事業者変更/.test(s)) return '転用・事業者変更';
  return '新規';
}


// ── 表示前の検証（黙って壊れたものを出さない）──────────────────

function verify(data) {
  const problems = [];
  if (!data.effective.length) problems.push('data/effective/ が空');

  for (const o of data.publishable) {
    if (!o.sourceUrl) problems.push(`出典URLが無い: ${o.providerName} ${o.planKey}`);
    if (!o.observedAt) problems.push(`取得日時が無い: ${o.providerName} ${o.planKey}`);
    if (o.verified !== true) problems.push(`検算を通っていないのに掲載可になっている: ${o.planKey}`);
    // ★実質月額がデータのものと一致するか。サイト側で作り直していないことの確認
    const fromData = o.effective?.[HORIZON]?.effectiveMonthly;
    if (fromData !== o.effectiveMonthly) problems.push(`表示値がデータと不一致: ${o.planKey}`);
  }
  const providers = new Set(data.publishable.map((o) => o.providerId));
  if (providers.size < 2) problems.push(`掲載可のサービスが${providers.size}件。横並び比較が成立しない`);

  // ★新しい事業者を足したときに運営会社の記録を忘れないための歯止め。
  //   忘れると「運営N社」の数え方が黙って狂う。
  for (const id of providers) {
    const op = data.operators[id];
    if (!op?.name || !op?.source || !op?.confirmedAt) {
      problems.push(`運営会社が site/providers.json に無い（または出典・確認日が欠けている）: ${id}`);
    }
  }
  return problems;
}

// ── トップページ ─────────────────────────────────────────────────
//
// 2026-11-20 に作り直した。読者の動線から逆算している:
//   1. 自分の条件を選ぶ（住まい・申込・速さ・年齢）
//   2. その条件で安い会社が3つ、すぐ出る（会社ごとの最安。同じ会社の工事違いで上位を埋めない）
//   3. 根拠の一覧（同じ条件の全プラン）→ プランページで内訳と推移
//   4. 最近動いた料金（このサイトにしか無い情報）
//
// ★条件の切り替えはブラウザ側のJSで「選んで並べ替える」だけ。**値は作らない。**
//   表示する金額は data/ の実質月額（36か月）をそのまま埋め込んでいる。
//   JSが無くても既定の条件（戸建て・新規・速さ問わず・30歳以上）の答えと一覧は読める。
// ★「使う期間（2年／3年）」の切り替えは作らない。data の24か月値は
//   事業者ごとに工事費の数え方が揃っておらず（楽天は工事費を全額、NUROは24か月分だけ）、
//   どちらも途中解約時の解約金・工事費残債を含まない。並べると「2年で解約したときの比較」と誤読される。

// ★29歳以下限定の割引（U29応援割）を使った値は、既定では順位に入れない。
//   30歳以上は使えない値を「安い」と出すと、ほとんどの読者に対して嘘になる。
//   年齢で「29歳以下」を選んだときだけ入れる。
const isAgeLimited = (o) => /U29/.test(o.planKey ?? '');

const BUILDING_ID = { '戸建て': 'detached', 'マンション': 'apartment', '共通': 'both' };
const entryId = (o) => (o.entry === '新規' ? 'new' : 'switch');

/** 条件の選択肢。画面の文言はここにしか書かない（JSも同じものを読む） */
const PICKER = [
  // [値, ボタンの文言, 見出しに出す短い文言]
  { name: 'b', legend: 'お住まい', options: [['detached', '戸建て', '戸建て'], ['apartment', 'マンション', 'マンション']] },
  { name: 'e', legend: '申し込み', options: [['new', '新しく引く', '新しく引く'], ['switch', '乗り換え', '乗り換え（転用・事業者変更）']] },
  { name: 's', legend: '速さ', options: [['any', '問わない', '速さ問わず'], ['other', '10ギガ以外', '10ギガ以外'], ['10g', '10ギガ', '10ギガ']] },
  { name: 'y', legend: '年齢', options: [['0', '30歳以上', '30歳以上'], ['1', '29歳以下', '29歳以下']] },
];
const DEFAULT_COND = { b: 'detached', e: 'new', s: 'any', y: '0' };

function matches(o, c) {
  const b = BUILDING_ID[o.building];
  if (!(b === 'both' || b === c.b)) return false;
  if (entryId(o) !== c.e) return false;
  if (c.s !== 'any' && o.speedClass !== c.s) return false;
  if (c.y === '0' && isAgeLimited(o)) return false;
  return true;
}

const byValue = (a, b) => a.effectiveMonthly - b.effectiveMonthly || a.providerName.localeCompare(b.providerName);

/** 会社ごとにまとめる（並び順は保つ）。答えの欄は「会社ごとの最安」で3社まで */
function groupByProvider(rows) {
  const m = new Map();
  for (const o of rows) {
    if (!m.has(o.providerId)) m.set(o.providerId, []);
    m.get(o.providerId).push(o);
  }
  return [...m.values()];
}

function condLabel(c) {
  return PICKER.map((p) => p.options.find(([v]) => v === c[p.name])?.[2]).join('・');
}

/** 1社ぶんの答えカード。JSは <template> に入れた同じ部品を複製して並べ替える */
function pickCard(o, rank, others = []) {
  const notes = rowNotes(o);
  return html`
<li class="pick" data-id="${o.id}">
  <span class="pick-rank" aria-label="${rank}位">${rank}</span>
  <div class="pick-body">
    <p class="pick-prov">${o.providerName}</p>
    <a class="pick-plan" href="${o.path}">${planName(o)}</a>
    ${raw(notes.length ? `<p class="chips">${notes.map((n) => `<span class="chip">${e(n)}</span>`).join('')}</p>` : '')}
  </div>
  <div class="pick-fig">
    <p class="pick-price"><b>${yenMark(o.effectiveMonthly)}</b><span>／月</span></p>
    <p class="pick-total">3年の総額 ${yen(o.effective?.[HORIZON]?.total)}</p>
  </div>
  <p class="pick-src">出典 <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a> <time datetime="${o.observedAt}">${jstShort(o.observedAt)}</time></p>
  <p class="pick-range">${others.length ? `同じ会社のほかの条件 ${others.length}件（〜${yen(others[others.length - 1].effectiveMonthly)}）は下の一覧に` : ''}</p>
  <a class="pick-go" href="${o.path}">内訳と推移を見る<span aria-hidden="true"> →</span></a>
</li>`;
}

function rowNotes(o) {
  const notes = [];
  if (isAgeLimited(o)) notes.push('29歳以下限定');
  if (o.speedClass === '10g') notes.push('10ギガ');
  // 工事の区分は、プラン名に含まれていないときだけ印にする（同じ語を2度出さない）
  if (o.plan?.work && !planName(o).includes(o.plan.work)) notes.push(o.plan.work);
  if (o.setBenefits?.length) notes.push('一部の特典は不算入');
  // 印は「公式が代表例として示す額」のときだけ（ドコモ光）。ほかの工事費の説明はプランページにだけ出す
  if (/代表例/.test(o.constructionFee?.note ?? '')) notes.push('工事費は公式の代表例');
  if (o.stale && !o.paused) notes.push(`${o.stale.days}日前から取得できていません`);
  return notes;
}

function picker() {
  return html`
<form class="picker" id="picker" aria-label="条件を選ぶ">
  ${raw(PICKER.map((p) => html`
  <fieldset class="seg">
    <legend>${p.legend}</legend>
    <div class="seg-opts">${raw(p.options.map(([v, label, short]) => html`
      <label><input type="radio" name="${p.name}" value="${v}" data-short="${short}"${raw(DEFAULT_COND[p.name] === v ? ' checked' : '')}><span>${label}</span></label>`).join(''))}
    </div>
  </fieldset>`).join(''))}
  <noscript><p class="note">条件の切り替えにはJavaScriptが必要です。下は「${condLabel(DEFAULT_COND)}」の結果です。全プランは各サービスのページで見られます。</p></noscript>
</form>`;
}

/**
 * 比較の範囲。★「安い順」と言う以上、**何の中で**安いのかを見出しのすぐ下に必ず書く
 * （比較広告ガイドライン 3(1)・4(1)。docs/research/2026-11-20_サイト刷新の表示可否.md）。
 * ★最上級（「いちばん安い」「最安」）は使わない。記録が止まっているサービスがある限り、
 *   比較の母集団が欠けているため（同判定 3）。site/verify.mjs が最上級の混入を赤くする。
 */
/** プランと同じ条件をトップの # に入れる（共通プランは戸建てで開く） */
function condHash(o) {
  const b = BUILDING_ID[o.building] === 'apartment' ? 'apartment' : 'detached';
  return new URLSearchParams({ b, e: entryId(o), s: 'any', y: isAgeLimited(o) ? '1' : '0' }).toString();
}

function scopeLine(data, hits) {
  const services = new Set(data.ranked.map((o) => o.providerId)).size;
  const pausedNames = [...new Set(data.paused.map((o) => o.providerName))];
  return html`<p class="scope">当サイトが毎日記録している${services}サービス・${data.ranked.length}プランのうち、この条件に合う<b id="count-a">${hits}</b>プランを比べています（${jstDateTime(data.updatedAt)}時点）。${raw(pausedNames.length ? html`記録が止まっている${pausedNames.join('・')}は含みません。` : '')}<a href="/method/">計算方法</a></p>`;
}

function answer(data) {
  const rows = data.ranked.filter((o) => matches(o, DEFAULT_COND)).sort(byValue);
  const groups = groupByProvider(rows).slice(0, 3);
  // 29歳以下なら、もっと安い値があるか（既定では順位に入れていないので、存在だけ知らせる）
  const young = data.ranked.filter((o) => matches(o, { ...DEFAULT_COND, y: '1' })).sort(byValue)[0];
  const hint = young && isAgeLimited(young) && rows[0] && young.effectiveMonthly < rows[0].effectiveMonthly ? young : null;

  return html`
<section class="answer" aria-labelledby="answer-h">
  <h2 id="answer-h"><span class="cond" id="cond-label">${condLabel(DEFAULT_COND)}</span>の実質月額 安い順</h2>
  ${raw(scopeLine(data, rows.length))}
  <ol class="podium" id="podium" aria-live="polite">${raw(groups.map((g, i) => pickCard(g[0], i + 1, g.slice(1))).join(''))}</ol>
  <p class="empty" id="empty"${raw(groups.length ? ' hidden' : '')}>この条件に当てはまるプランは、いま記録しているサービスにはありません。</p>
  <p class="young-hint" id="young-hint"${raw(hint ? '' : ' hidden')}>${raw(hint ? html`<span class="chip">29歳以下なら</span> ${hint.providerName}の${planName(hint)}が${yen(hint.effectiveMonthly)}／月（出典 <a href="${hint.sourceUrl}" rel="nofollow noopener">${host(hint.sourceUrl)}</a> ${jstShort(hint.observedAt)}）。年齢で「29歳以下」を選ぶと順位に入ります。` : '')}</p>
  <p class="note">
    金額は<strong>3年（${HORIZON}か月）使ったときの1か月あたり</strong>。毎月の料金に、工事費・事務手数料を足し、キャッシュバックを引いて${HORIZON}で割っています（<a href="/method/">計算方法</a>）。
    ${raw(data.ads.same.size || data.ads.different.length ? '<strong>順位は金額だけで決めており、広告の有無は関係しません。</strong>' : '')}
  </p>
  <template id="tpl-cards">${raw(data.ranked.map((o) => pickCard(o, 0)).join(''))}</template>
</section>`;
}

function renderIndex(data) {
  const recentDays = eventsByDay(data).slice(0, 4);
  const since = observedSince(data);

  const body = html`
<section class="hero">
  <p class="eyebrow"><span class="live" aria-hidden="true"></span>毎日自動で記録 ／ 最終更新 ${jstDateTime(data.updatedAt)}</p>
  <h1><span>光回線、</span><span>3年使うと</span><span>毎月いくら？</span></h1>
  <p class="lead">
    各社の公式サイトの料金を毎日集め、工事費・手数料・キャッシュバックまで入れて<strong>「1か月あたり」に直しました。</strong>
    条件を選ぶと、安い順がすぐ出ます。
  </p>
  ${raw(picker())}
</section>

${raw(answer(data))}

${raw(rankingSection(data))}

${raw(linkOnlyOffers(data))}

${raw(pausedSection(data))}

<section class="block">
  <div class="block-head">
    <h2>最近動いた料金</h2>
    <a class="more" href="/changes/">変化の記録をすべて見る →</a>
  </div>
  <p class="note">毎日の値を突き合わせ、<strong>実質月額が変わった日だけ</strong>を記録しています。公式の告知が無い小さな変更も拾います。</p>
  ${raw(recentDays.length ? `<ul class="digests">${recentDays.map(([day, list]) => dayDigest(data, day, list)).join('')}</ul>` : '<p>まだ変化を記録していません。収集は毎日走っています。</p>')}
</section>

<section class="block">
  <h2>サービスごとに見る</h2>
  <div class="pcards">${raw(providerIds(data).map((id) => providerCard(data, id)).join(''))}</div>
  ${raw(operatorNote(data))}
</section>

<details class="fold">
  <summary>言葉の説明（実質月額・新規と乗り換え・派遣工事 など）</summary>
  ${raw(legend())}
</details>

${raw(needsReviewSection(data))}

<section class="record">
  <h2>この数字の作り方</h2>
  <div class="record-grid">
    <div class="stat"><b>${data.ranked.length}</b><span>順位に入れているプラン</span></div>
    <div class="stat"><b>${new Set(data.ranked.map((o) => o.providerId)).size}</b><span>記録中のサービス</span></div>
    <div class="stat"><b>${data.events.length}</b><span>記録した料金の変化</span></div>
    <div class="stat"><b>${since ? daysSince(since) + 1 : '—'}<small class="cur">日</small></b><span>${since ? `${jstDate(since)}に記録開始（取得できなかった期間を含む）` : '記録開始前'}</span></div>
  </div>
  <ul class="promises">
    <li><strong>公式サイトの数字だけ</strong>を使います。口コミや推定は混ぜません</li>
    <li>全社を<strong>同じ計算式</strong>に通します。式も規則も<a href="/method/">全部公開</a>しています</li>
    <li>内訳から計算した月額が<strong>公式の表示と一致したものだけ</strong>を載せます</li>
    <li>取れなかった日を前日の値で埋めません。<strong>止まったら止まったと書きます</strong></li>
    <li>元データは<a href="/data/">CC BY 4.0</a>で誰でも使えます</li>
  </ul>
</section>
`;

  return {
    title: `光回線の実質月額を毎日比較｜${SITE_NAME}`,
    description: `光回線${new Set(data.ranked.map((o) => o.providerId)).size}サービスの料金・工事費・割引・キャッシュバックを公式サイトから毎日自動収集し、同じ計算式で${HORIZON}か月の実質月額に換算。住まい・申込・速さ・年齢で絞り込めます。計算式と出典を全公開。`,
    canonical: `${SITE_URL}/`,
    head: [
      jsonLd(datasetLd(data)).value,
      jsonLd(itemListLd(data)).value,
    ].join('\n'),
    body,
    scripts: ['/app.js'],
    updatedAt: data.updatedAt,
  };
}

function providerCard(data, id) {
  const mine = data.publishable.filter((o) => o.providerId === id);
  const live = mine.filter((o) => !o.paused);
  const evAll = data.events.filter((c) => c.providerId === id);
  const lastAt = evAll.map((c) => c.detectedAt).sort().pop() ?? null;
  const pool = live.length ? live : mine;
  const cheapest = pool.reduce((a, b) => (a.effectiveMonthly <= b.effectiveMonthly ? a : b));
  const paused = !live.length;
  return html`
    <div class="pcard${raw(paused ? ' is-paused' : '')}">
      <a class="pname" href="/p/${id}/">${mine[0].providerName}${raw(paused ? ' <span class="chip warn">記録停止</span>' : '')}</a>
      <span class="pmin"><small>${paused ? '最後に記録した実質月額' : '実質月額'}</small><b>${yenMark(cheapest.effectiveMonthly)}</b><small>／月〜</small></span>
      <span class="pmeta">
        <span>${pool.length}プラン ／ 記録した変化 ${evAll.length}件</span>
        <span>${raw(lastAt ? html`最後に料金が動いた日 ${jstDate(lastAt)}` : 'まだ料金は動いていません')}</span>
        <span class="psrc">出典 <a href="${cheapest.sourceUrl}" rel="nofollow noopener">${host(cheapest.sourceUrl)}</a> <time datetime="${cheapest.observedAt}">${jstShort(cheapest.observedAt)}</time></span>
      </span>
    </div>`;
}

/**
 * 金額の「円」だけを小さく落として返す。
 * ★数字そのものは1文字も変えない。yen() の結果の末尾を包むだけ。
 *   検算する側（site/verify.mjs）はタグを剥がしてから数字を読む。
 */
function yenMark(n) {
  const t = e(yen(n));
  return raw(t.endsWith('円') ? `${t.slice(0, -1)}<small class="cur">円</small>` : t);
}

/**
 * 観測を続けている日数。**後から資金で買えない資産はこれだけ**なので正面に出す。
 * ★起点は「記録に残っている最も古い観測時刻」。観測そのものの履歴は
 *   保存していないので、これより前には遡らない。
 */
function observedSince(data) {
  const ts = data.events.map((c) => c.previousObservedAt ?? c.detectedAt).filter(Boolean).sort();
  return ts[0] ?? null;
}

/**
 * 表を読むための言葉の説明。
 *
 * ★「実質月額」も「事務手数料」も、知っている人にしか通じない。
 *   略語は使わない（「CB」と書いていて意味が通じなかった）。
 */
function legend() {
  const money = [
    ['実質月額',
     `${HORIZON}か月（3年）使い続けたとき、ならすと毎月いくら払ったことになるかの金額です。`
     + '毎月の料金だけでなく、工事費もキャッシュバックも全部ふくめて計算しています。'],
    ['3年の総額', `${HORIZON}か月で払うお金の合計から、受け取れるキャッシュバックを引いた金額です。実質月額はこれを${HORIZON}で割ったものです。`],
    ['事務手数料', '申し込むときに1回だけかかるお金です。毎月はかかりません。'],
    ['工事費', '回線を家に引く工事の代金です。割引が出る会社もあるので、引いたあとの自己負担だけを数えています。'],
    ['キャッシュバック', 'あとから受け取れるお金です。3年以内に受け取れる分だけを総額から引いています。'],
    ['推移', 'その料金がこれまでどう動いたかの形です。赤は上がった、緑は下がったことを表します。'],
  ];
  // ★プラン名は各社の公式表記をそのまま出している（勝手に言い換えない）。
  //   そのぶん、意味はここで説明する。
  const words = [
    ['戸建て / マンション', '一戸建て向けか、集合住宅向けかの違いです。同じ会社でも料金が変わります。'],
    ['1ギガ / 2ギガ / 10ギガ', '通信速度の上限です。数字が大きいほど速く、そのぶん高くなるのがふつうです。'],
    ['新しく引く / 乗り換え', '「新しく引く」は、はじめて回線を引く申し込み（新規）です。「乗り換え」は、いまのフレッツ光や光コラボの回線をそのまま使って会社だけ変えること（転用・事業者変更）です。工事費や特典の条件が違うので、分けて並べています。'],
    ['派遣工事', '工事の人が家に来る工事のことです。来ない場合（派遣工事なし）より費用がかかります。どちらになるかは家の設備で決まります。'],
    ['2年割 / U29応援割', '会社がつけている割引の名前です。その割引を使った状態で計算しています。U29応援割は29歳以下だけが使えます。'],
    ['一部の特典は不算入', 'スマホとのセット割引や、期間・用途が限られたポイントの特典は計算に入れていません。'
      + 'セット割引は契約している携帯会社で額が変わり、ポイントは現金と同じには使えないため、同じ条件で比べられなくなるからです。'],
  ];
  const grid = (items) => html`<dl>${raw(items.map(([t, d]) =>
    html`<div><dt>${t}</dt><dd>${d}</dd></div>`).join(''))}</dl>`;
  return html`
<section class="legend">
  <h3 class="legend-h">お金の言葉</h3>
  ${raw(grid(money))}
  <h3 class="legend-h">プラン名に出てくる言葉</h3>
  ${raw(grid(words))}
</section>`;
}

/**
 * 表の行に入れる推移。イベントから復元できたときだけ描く。
 * ★描けないときに横棒を引かない。「ずっと横ばいだった」は確かめていない。
 */
function rowSpark(data, o) {
  const s = reconstructSeries({
    planKey: o.planKey,
    currentValue: o.effectiveMonthly,
    currentAt: o.observedAt,
    events: data.events.filter((c) => c.providerId === o.providerId),
    horizonMonths: HORIZON,
  });
  const svg = s.ok ? sparkline(s.points) : null;
  return svg ?? '<span class="spark-none">変化なし</span>';
}

/**
 * 根拠の一覧。**順位に入れている全プランを1つの表に出し**、既定の条件に合わない行は hidden にする。
 * JSが条件に合わせて hidden を付け替え、順位の数字を振り直す（値は変えない）。
 * ★hidden の行も HTML には残る。AIや検索エンジンが全条件の値を読めるようにするため。
 */
function rankingSection(data) {
  const rows = [...data.ranked].sort(byValue);
  if (!rows.length) return '';

  // 申込列を出すのは「飛び先の条件＝出典の条件」のリンクがあるときだけ。
  // 条件が違うリンクは行に混ぜない（数字と食い違うため）。別ブロックに出す。
  const ads = data.ads.same.size > 0;
  let rank = 0;
  const body = rows.map((o) => {
    const on = matches(o, DEFAULT_COND);
    return rankRow(o, data, on ? ++rank : 0, !on);
  }).join('');

  return html`
<section class="block" id="list">
  <div class="block-head">
    <h2>この条件の全プラン <span class="count"><span id="count">${rank}</span>件</span></h2>
  </div>
  <p class="note">安い順。速さの違うプランも並べているので、速さはプラン名と印で確かめてください。行を押すと内訳と推移が見られます。</p>
  <div class="card"><div class="table-wrap">
  <table class="ranking" id="ranking">
    <thead>
      <tr><th class="rank">順位</th><th>実質月額</th><th>サービス</th><th>プラン</th><th>3年の総額</th><th>推移</th><th>出典・取得日時</th>${raw(ads ? '<th>申込</th>' : '')}</tr>
    </thead>
    <tbody>${raw(body)}</tbody>
  </table>
  </div></div>
  <details class="fold fold-note">
    <summary>この順位の決め方</summary>
    <p class="note">
      ${HORIZON}か月換算です。契約期間は各社ばらばら（NURO光は縛りなし）なので、揃えないと比較になりません。
      数え方の統一規則は<a href="/method/">計算方法</a>に書いています。
    </p>
    <p class="note">
      <strong>順位は実質月額の安い順で、それ以外の基準は入れていません。</strong>
      選んだ条件に合う観測は<strong>1件も除外していません</strong>。
      ただし<strong>記録が止まっているサービスの値は、今日の値として比べられないので順位に入れず</strong>、下に分けて出しています。
      検算に通らなかったものはページ下部に理由つきで出しています。
    </p>
  </details>
</section>
`;
}

function rankRow(o, data, rank, hidden) {
  const ad = data.ads.same.get(o.providerId);
  const notes = rowNotes(o);
  const attrs = html`data-id="${o.id}" data-pid="${o.providerId}" data-b="${BUILDING_ID[o.building]}" data-e="${entryId(o)}" data-s="${o.speedClass}" data-y="${isAgeLimited(o) ? '1' : '0'}" data-v="${o.effectiveMonthly}" data-plan="${planName(o)}" data-provider="${o.providerName}"`;
  return html`
<tr class="row${raw(rank && rank <= 3 ? ' top' : '')}" ${raw(attrs)}${raw(hidden ? ' hidden' : '')}>
  <td class="rank">${rank || ''}</td>
  <td class="num strong">${yenMark(o.effectiveMonthly)}</td>
  <td class="prov">${o.providerName}</td>
  <td class="plan"><a class="plan-name" href="${o.path}">${planName(o)}</a>${raw(notes.length ? `<span class="chips">${notes.map((n) => `<span class="chip">${e(n)}</span>`).join('')}</span>` : '')}</td>
  <td class="num total">${yen(o.effective?.[HORIZON]?.total)}</td>
  <td class="trend">${raw(rowSpark(data, o))}</td>
  <td class="src">
    <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a>
    <time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time>
  </td>
  ${raw(data.ads.same.size > 0 ? adCell(ad) : '')}
</tr>
`;
}

/**
 * 記録が止まっているサービス。**順位には入れないが、隠しもしない。**
 * 止まった理由（遮断による対象外 / 取得の失敗）と、最後に記録できた日を書く。
 */
function pausedSection(data) {
  if (!data.paused.length) return '';
  const groups = groupByProvider([...data.paused].sort(byValue));
  return html`
<section class="paused" id="paused">
  <h2>記録が止まっているサービス</h2>
  <p class="note">今日の値として比べられないので、<strong>上の順位には入れていません。</strong>最後に記録できた値はサービスのページで見られます。</p>
  <ul>${raw(groups.map((g) => {
    const o = g[0];
    const last = g.map((x) => x.observedAt).sort().pop();
    const why = o.excluded
      ? (o.excluded.publicNote ?? `${o.excluded.since}から自動での記録を止めています。`)
      : `${jstDate(o.stale.since)}から公式ページを取得できていません（${o.stale.days}日）。直りしだい再開します。`;
    return html`<li>
      <p class="paused-name"><a href="/p/${o.providerId}/">${o.providerName}</a><span class="chip warn">${o.excluded ? '記録停止' : '更新停止中'}</span></p>
      <p>${why}</p>
      <p class="note">最後に記録できた日時: <time datetime="${last}">${jstDateTime(last)}</time> ／ ${g.length}プラン</p>
    </li>`;
  }).join(''))}</ul>
</section>`;
}

/**
 * ★飛び先の条件が出典と違う広告を、比較表と混ぜずに出すためのブロック。
 *
 *   実質月額は「誰でも見られる公式の料金ページ」を計測している。
 *   一方、広告経由の申込には別の条件が適用されることがあり、
 *   公開されている料金ページの条件と一致しない場合がある。
 *
 *   これを比較表の行に混ぜると、表示している数字と申込先が食い違う。
 *   かといって黙っていると、読者はより良い条件を知らずに終わる。
 *   **別物として、別条件であることを明記して出す。** 金額は書かない
 *   （自動で追えないものを数字で断定しない）。
 *
 * @param only 事業者IDを渡すと、その事業者の広告だけ出す（事業者・プランページ用）
 */
function linkOnlyOffers(data, only = null) {
  const list = data.ads.different.filter((a) => !only || a.providerId === only);
  if (!list.length) return '';

  return html`
<section class="link-only">
  <p class="link-only-kicker"><span class="tag">広告</span> 申込先によって条件が変わる特典</p>
  <p>
    ${only ? 'このページ' : '上の比較'}の金額は<strong>誰でも見られる公式の料金ページ</strong>から計算した値です。
    下記は<strong>申込経路によって条件が変わるもの</strong>で、<strong>実質月額には含まれていません。</strong>
    金額や条件は変わるので、<strong>必ず申込先のページで確認してください。</strong>
  </p>
  <ul>
    ${raw(list.map((a) => html`<li>
      <p class="link-only-name">${providerNameOf(data, a.providerId) ?? a.providerId}</p>
      <p>${a.differenceNote}</p>
      <p class="link-only-ad">${raw(adUnit(a))}</p>
      <p class="note">条件を確認した日: ${a.confirmedAt}</p>
    </li>`).join(''))}
  </ul>
  <p class="note">
    この欄の内容は<strong>自動収集ではなく、人が申込先を開いて確認して書いています。</strong>
    確認から${AD_CONFIRM_MAX_DAYS}日を過ぎたものは、古い条件を出し続けないよう自動で表示をやめます。
  </p>
</section>
`;
}

const providerNameOf = (data, id) => data.publishable.find((o) => o.providerId === id)?.providerName;

/**
 * 申込セル。提携していない事業者の行は空欄にする。
 * **空欄を埋めるために別条件の広告を入れない。**
 */
function adCell(ad) {
  if (!ad) return '<td class="cta">—</td>';
  return `<td class="cta">${adUnit(ad)}</td>`;
}

/**
 * 広告そのもの。★ASPが生成したコードを一字も変えずに出す。
 *
 *   リンク先URLだけ抜き出して自前のボタンにすること、文言や画像を差し替えることは
 *   「広告素材の改変」にあたる。ASPの広告コードには表示回数の計測用タグが含まれる
 *   こともあり、リンクだけ抜くとそれも落ちる。
 *
 *   我々が足してよいのは**コードの外側**だけ。「広告」の表示は隣に置き、
 *   コード自体（rel やテキストを含む）には触らない。
 */
function adUnit(ad) {
  return `<span class="ad-unit" data-ad="1"><span class="tag">広告</span> ${ad.adCode}</span>`;
}

/**
 * 広告表記。★ステマ規制（景表法・2023年10月〜）への対応。
 *   A8.net は「ファーストビュー等、一般消費者が認識できる位置にわかりやすく表示」を求めている。
 *   出典: https://a8pr.jp/2023/08/31/fairlabeling/
 *   ★広告リンクが1本も無いときは出さない。無いのに「広告を利用しています」と書くのも嘘になる。
 */
function adDisclosure(data) {
  if (!hasAds(data)) return '';
  return html`<p class="ad-disclosure">本ページはアフィリエイト広告を利用しています。
<strong>広告の有無は順位に影響しません。</strong>順位は実質月額だけで決めています。</p>`;
}

function needsReviewSection(data) {
  if (!data.needsReview.length) return '';
  return html`
<section class="review">
  <h2>掲載を保留している観測（${data.needsReview.length}件）</h2>
  <p>
    自動で読み取った結果が検算に通らなかったもの、または収集元のページ内で記載が食い違っているものです。
    <strong>確からしさが担保できないので、上の比較には入れていません。</strong>隠さずここに出します。
  </p>
  <ul class="review-list">
    ${raw(data.needsReview.map((o) => html`
      <li>
        <strong>${o.providerName}</strong> ${planName(o)}
        <br><span class="tag">${(o.ambiguities?.[0] ?? o.mismatch?.[0] ?? '実質月額を算出できなかった')}</span>
      </li>`).join(''))}
  </ul>
</section>
`;
}

// ── 変化のページ ─────────────────────────────────────────────────
//
// ★日付ごとに固定URLのページを作る（/changes/2026-11-20/）。
//   「今日○○が値下げした」はニュースであり、ニュースは**指し示せる単位**が無いと言及されない。
//   一覧ページ1枚だけだと、引用する側はリンク先を特定できない（手法設計: 言及される理由を毎日作る）。
// ★「記録した日」と「実際に変わった日」を混同しない。
//   収集は1日1回なので、変わったのは「前回の記録〜今回の記録」の間のどこか。
//   収集が止まっていた期間をまたぐと、この幅は何日にもなる（2026-11-20 の NURO光は 11/1〜11/20）。
//   幅が1日を超えるときは、必ず幅で書く。

/** JST の日付キー（YYYY-MM-DD） */
function jstDay(iso) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function eventsByDay(data) {
  const m = new Map();
  for (const c of data.events) {
    const k = jstDay(c.detectedAt);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])); // 新しい日から
}

/**
 * いつ変わったか。変化前の値を記録した時刻と、変化後の値を記録した時刻を両方書く。
 * 間が1日半を超えて空いていたら、その間は記録できていなかったことも書く。
 */
function whenChanged(c) {
  const prev = c.previousObservedAt;
  if (!prev) return `変化後の値の記録 ${jstShort(c.detectedAt)}`;
  const gap = new Date(c.detectedAt) - new Date(prev) > 36 * 3600e3;
  return `記録: 変化前 ${jstShort(prev)} → 変化後 ${jstShort(c.detectedAt)}${gap ? '（この間は記録が途切れており、変わったのはこの間のどこか）' : ''}`;
}

/** 「2026/11/20 17:45」（JST）。カードの中で時点を短く書くため */
function jstShort(iso) {
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(iso));
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

/** トップに置く「その日の変化」の要約。主な3件と、残りの件数、日付ページへの道 */
function dayDigest(data, day, list) {
  const s = daySummary(list);
  const top = [...s.moved].sort((a, b) => Math.abs(b.effectiveMonthlyDelta) - Math.abs(a.effectiveMonthlyDelta)).slice(0, 3);
  const rest = list.length - top.length;
  return html`
<li class="digest">
  <p class="dg-head"><a href="/changes/${day}/">${jstDate(list[0].detectedAt)}</a><span>${s.providers.join('・')}</span></p>
  <p class="dg-sum">${list.length}件の変化${raw(s.moved.length ? `<span class="pill down">値下げ ${s.down}</span><span class="pill up">値上げ ${s.up}</span>` : '')}</p>
  <ul>${raw(top.map((c) => {
    const dir = c.effectiveMonthlyDelta < 0 ? 'down' : 'up';
    return html`<li><span class="dg-name">${c.providerName} ${planName(c)}</span><span class="dg-v">${yen(c.before)} → <b>${yen(c.after)}</b> <em class="pill ${dir}">${raw(dir === 'down' ? '▼' : '▲')} ${yenSigned(c.effectiveMonthlyDelta)}</em></span></li>`;
  }).join(''))}</ul>
  ${raw(rest > 0 ? html`<p class="dg-rest">ほか${rest}件</p>` : '')}
  <a class="more" href="/changes/${day}/">この日の変化をすべて見る →</a>
</li>`;
}

const offerOf = (data, c) => data.publishable.find((o) => o.providerId === c.providerId && o.planKey === c.planKey);

function changeCard(c, data, { dayLink = true } = {}) {
  const o = offerOf(data, c);
  const plan = o ? html`<a href="${o.path}">${planName(o)}</a>` : html`${planName(c)}`;
  const day = jstDay(c.detectedAt);
  const links = [
    dayLink ? `<a href="/changes/${day}/">この日の変化</a>` : '',
    c.sourceUrl ? `<a href="${e(c.sourceUrl)}" rel="nofollow noopener">出典</a>` : '',
  ].filter(Boolean).join('');

  if (c.type !== 'effective-monthly-changed') {
    return html`
<li class="ev">
  <p class="ev-head"><time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time><span class="ev-prov">${c.providerName}</span></p>
  <p class="ev-plan">${raw(plan)}</p>
  <p class="ev-delta">${c.type === 'plan-added' ? 'プランが追加されました' : 'プランが見当たらなくなりました'}</p>
  <p class="ev-links">${raw(links)}</p>
</li>`;
  }
  const dir = c.effectiveMonthlyDelta < 0 ? 'down' : 'up';
  const cause = (c.cause ?? []).map((x) => `${x.label} ${yen(x.before)}→${yen(x.after)}`).join(' ／ ');
  return html`
<li class="ev ${dir}">
  <p class="ev-head"><time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time><span class="ev-prov">${c.providerName}</span></p>
  <p class="ev-plan">${raw(plan)}</p>
  <p class="ev-delta">実質月額 ${yen(c.before)} → <b>${yen(c.after)}</b>
    <em class="pill ${dir}">${raw(c.effectiveMonthlyDelta < 0 ? '▼' : '▲')} ${yenSigned(c.effectiveMonthlyDelta)}</em></p>
  ${raw(cause ? `<p class="ev-cause">${e(cause)}</p>` : '')}
  <p class="ev-when">${whenChanged(c)}</p>
  <p class="ev-links">${raw(links)}</p>
</li>`;
}

function daySummary(list) {
  const moved = list.filter((c) => c.type === 'effective-monthly-changed');
  const down = moved.filter((c) => c.effectiveMonthlyDelta < 0).length;
  const up = moved.length - down;
  const providers = [...new Set(list.map((c) => c.providerName))];
  return { moved, down, up, providers };
}

function renderChanges(data) {
  const days = eventsByDay(data);
  const body = html`
<section class="page-head">
  <h1>料金の変化の記録</h1>
  <p class="lead">
    各社の料金を毎日記録し、<strong>3年でならした1か月あたりの金額（実質月額）が動いた日</strong>だけを残しています。
    「キャッシュバックが5,000円増えた」ではなく「実質月額が139円下がった」と、読む人にとっての意味に直して書きます。
  </p>
  <p class="note">日付は<strong>このサイトが変化を記録した日</strong>です。収集は1日1回なので、実際に変わったのはその前の記録との間です。記録が途切れていた期間をまたぐ変化は、その幅を書いています。</p>
</section>
${raw(days.length ? days.map(([day, list]) => {
  const s = daySummary(list);
  return html`
<section class="day">
  <h2><a href="/changes/${day}/">${jstDate(list[0].detectedAt)}</a>
    <small>${s.providers.join('・')} ／ ${list.length}件${raw(s.moved.length ? `（値下げ${s.down}・値上げ${s.up}）` : '')}</small></h2>
  <ul class="feed">${raw(list.map((c) => changeCard(c, data, { dayLink: false })).join(''))}</ul>
</section>`;
}).join('') : '<p>まだ変化を記録していません。</p>')}
`;
  return {
    title: `料金の変化の記録｜${SITE_NAME}`,
    description: '光回線各社の実質月額が動いた記録。いつ・どのプランが・いくら変わったかを、原因の内訳と出典つきで日付ごとに残しています。',
    canonical: `${SITE_URL}/changes/`,
    body,
    updatedAt: data.updatedAt,
  };
}

function renderChangeDay(data, day, list, prev, next) {
  const s = daySummary(list);
  const date = jstDate(list[0].detectedAt);
  const crumb = breadcrumb([
    { name: '実質月額', path: '/' },
    { name: '料金の変化', path: '/changes/' },
    { name: date },
  ]);
  const headline = s.moved.length
    ? `${s.providers.join('・')}の実質月額が${s.moved.length}件変化（値下げ${s.down}件・値上げ${s.up}件）`
    : `${s.providers.join('・')}のプランに${list.length}件の変化`;
  const body = html`
${raw(crumb.visible)}
<section class="page-head">
  <p class="eyebrow">料金の変化 ／ ${date}</p>
  <h1>${headline}</h1>
  <p class="lead">${date}に、このサイトが記録した光回線の料金の変化です。金額は${HORIZON}か月（3年）使ったときの1か月あたり（実質月額）で、各社公式の料金ページの値から<a href="/method/">当サイトの計算式</a>で計算したものです。</p>
  <aside class="stale-note"><strong>これは${date}に記録した変化で、現在の料金ではありません。</strong>いまの値は各カードのプラン名から開けるページ、または<a href="/">比較のページ</a>でご確認ください。</aside>
</section>
<ul class="feed">${raw(list.map((c) => changeCard(c, data, { dayLink: false })).join(''))}</ul>
<p class="note">
  日付は<strong>このサイトが変化を記録した日</strong>です。収集は1日1回なので、実際に変わったのは前回の記録との間です。
  計算の仕方は<a href="/method/">計算方法</a>に全部書いています。各カードの「出典」が、変化を確かめた公式ページです。
</p>
<nav class="pager" aria-label="前後の日">
  ${raw(next ? `<a rel="next" href="/changes/${next}/">← ${e(next)}</a>` : '<span></span>')}
  <a href="/changes/">記録の一覧</a>
  ${raw(prev ? `<a rel="prev" href="/changes/${prev}/">${e(prev)} →</a>` : '<span></span>')}
</nav>
`;
  return {
    title: `${date}の光回線の料金の変化：${headline}｜${SITE_NAME}`,
    description: `${date}に記録した光回線の料金の変化。${s.moved.slice(0, 3).map((c) => `${c.providerName} ${planName(c)} ${yen(c.before)}→${yen(c.after)}`).join('、')}${s.moved.length > 3 ? ' ほか' : ''}。実質月額（${HORIZON}か月換算）と原因の内訳、出典つき。`,
    canonical: `${SITE_URL}/changes/${day}/`,
    head: crumb.ld,
    body,
    updatedAt: data.updatedAt,
  };
}

// ── 計算方法のページ（透明性そのものが価値）───────────────────────

function renderMethod(data) {
  const formula = data.effective[0]?.formula ?? '';
  const body = html`
<h1>実質月額の計算方法</h1>
<p class="lead">
  各社が自社に有利な条件で「実質○円」を出しているため、横並び比較が成立していません。
  ここでは<strong>全社を同じ式に通した値</strong>を出しています。<strong>誰でも検算できるように、式も規則も全部公開します。</strong>
</p>

<h2>式</h2>
<pre class="formula">${formula}</pre>

<h2>計算のルール</h2>
<ul>
  <li>月額は期間ごとに変わるため（例: 1か月目 / 2〜24か月目 / 25か月目〜）、<strong>月単位に展開して合計</strong>します。平均や代表値は使いません</li>
  <li>全社を横並びにできるよう <strong>${HORIZON}か月を主軸</strong>としています</li>
  <li>キャッシュバックは<strong>受取時期が計算期間を超える分は算入しません</strong>（受け取れない可能性があるため）</li>
  <li>必須オプション（キャッシュバック適用に加入が必要なもの）は費用に<strong>算入</strong>します。任意オプションは算入しません</li>
  <li>工事費は「分割請求額の合計 − 割引の合計」を実負担とします</li>
  <li><strong>値が取得できなかった項目は推定しません。</strong>実質月額を出さず、掲載を保留します</li>
  <li>端数は円未満を四捨五入します</li>
</ul>

<h2>事業者間で揃えていること</h2>
<p>同じ「${HORIZON}か月」でも、各社の数え方・載せ方が違います。<strong>揃えずに並べた比較は嘘になります。</strong></p>
<div class="card"><div class="table-wrap">
<table>
  <thead><tr><th>揃えている点</th><th>なぜ</th></tr></thead>
  <tbody>
    <tr><td>契約1か月目 = 開通月</td><td>NURO光は開通月を「1か月目」と呼び、So-net光は「開通月」と「1カ月目」を別に数えます。揃えないと片方だけ開通月を含む${HORIZON}か月を比べることになります</td></tr>
    <tr><td>開通月は各社が公開している上限額を使う</td><td>開通月は日割りで確定しません。上限を使うので<strong>高く見積もる側</strong>に倒れます</td></tr>
    <tr><td>キャッシュバックは掲載場所を問わず算入</td><td>NURO光は料金内訳表の中に、So-net光はページ上部の特典表にあります。片方だけ拾うと、拾えなかった側が不当に高く見えます</td></tr>
    <tr><td>他サービスの契約が前提の割引は算入しない</td><td>楽天ひかりの「最強おうちプログラム」（楽天モバイル契約が前提）、NURO光の「NUROでんき／ガスとのセット割」などです。算入すると<strong>その契約にかかる費用を無視して安く見せる</strong>ことになります</td></tr>
    <tr><td>対象者が限定された特典を全員に適用しない</td><td>So-net光の「会員限定キャッシュバック」はプラン変更者のみが対象です</td></tr>
    <tr><td>比較は新規申込で揃える</td><td>転用・事業者変更は工事費もキャッシュバックも条件が違うため、混ぜると比較になりません</td></tr>
  </tbody>
</table>
</div></div>

<h2>数字を検算しています</h2>
<p>
  各社の料金ページには、内訳（月額基本料金・工事費・割引）と、その適用後の月額の<strong>両方</strong>が載っています。
  内訳から月額を計算し、<strong>ページが公開している月額と一致するかを毎回突き合わせています。</strong>
  一致しないものは掲載しません。<strong>読み方を間違えたまま「値上げしました」と発信しないためです。</strong>
</p>
<p>
  ただし検算の手段は事業者によって異なります。<strong>弱い検算しかできない事業者を、強い検算ができたかのように扱いません。</strong>
</p>
<div class="card"><div class="table-wrap">
<table>
  <thead><tr><th>事業者</th><th>検算の方法</th></tr></thead>
  <tbody>${raw(verificationRows(data))}</tbody>
</table>
</div></div>

<h2>壊れたときにどうなるか</h2>
<p>
  自動収集の最悪の失敗は「静かに壊れること」です。収集元が変わっても気づかず古い値を出し続けるのが一番まずい状態です。
</p>
<ul>
  <li>取得に失敗したとき、<strong>前回の値を書き戻すことはしません</strong></li>
  <li>設定されたページを1つでも取得できなかった事業者は、<strong>差分を取らず、記録も更新しません</strong>（「取得できなかった」を「無くなった」と誤解釈しないため）</li>
  <li>${STALE_DAYS}日以上更新できていない場合は、このサイトに<strong>「更新停止中」と明示します</strong>。<strong>今日の値として比べられないので、順位にも入れません</strong>（別枠に、止まった日と理由を書いて残します）</li>
  <li>公式サイトが自動での取得を受け付けなくなった場合は、<strong>技術的に取得を続けられるかどうかに関わらず記録を止めます</strong>。運営者の意思を尊重するためです。止めた日と理由は、そのサービスのページに書きます</li>
</ul>

<h2>よくある質問</h2>
${raw(faqSection())}
`;
  return {
    title: `実質月額の計算方法｜${SITE_NAME}`,
    description: '光回線の実質月額をどう計算しているかの全公開。統一計算式、事業者間で揃えている数え方、検算の方法、壊れたときの挙動まで記載しています。',
    canonical: `${SITE_URL}/method/`,
    head: jsonLd(faqLd()).value,
    body,
    updatedAt: data.updatedAt,
  };
}

function verificationRows(data) {
  const seen = new Map();
  for (const o of data.offers) {
    const m = o.verificationMethod ?? '内訳から計算した月額と、ページが公開している適用後の月額を突き合わせ';
    if (!seen.has(o.providerName)) seen.set(o.providerName, m);
  }
  return [...seen].map(([name, m]) => html`<tr><td>${name}</td><td>${m}</td></tr>`).join('');
}

// ── データを使うページ（被引用の入口）────────────────────────────

function renderData(data) {
  const body = html`
<h1>データを使う</h1>
<p class="lead">
  このサイトの元データは <strong>CC BY 4.0</strong> で公開しています。
  <strong>出典を書いていただければ、商用・非商用を問わず自由にお使いいただけます。</strong>AIによる学習・回答生成も含みます。
</p>

<h2>置き場所</h2>
<ul>
  <li><a href="https://github.com/riugamesub3-coder/tsushinhi-index">GitHub リポジトリ</a> — 収集スクリプトとデータの全部</li>
  <li><code>data/effective/</code> — 実質月額の現在値（事業者ごとのJSON）</li>
  <li><code>data/effective-changes/</code> — 実質月額が動いたイベントの履歴</li>
  <li><code>data/notices/</code> — 各社のお知らせの日付・URLと、当サイトが付けた分類（各社の文章そのものは保存していません）</li>
  <li><a href="/feed.xml">RSS フィード</a> — 変化の通知</li>
</ul>

<h2>出典の書き方</h2>
<blockquote>
  出典: 通信費インデックス（tsushinhi-index）${SITE_URL} — CC BY 4.0
</blockquote>

<h2>収録している事業者</h2>
<div class="card"><div class="table-wrap">
<table>
  <thead><tr><th>事業者</th><th>観測数</th><th>最終取得</th><th>出典</th></tr></thead>
  <tbody>${raw(data.effective.map((s) => html`
    <tr>
      <td>${s.providerName}${raw(data.excluded.has(s.providerId) ? ` <span class="chip warn">${e(data.excluded.get(s.providerId).since)}から記録停止</span>` : '')}</td>
      <td class="num">${s.offers.length}</td>
      <td><time datetime="${s.observedAt}">${jstDateTime(s.observedAt)}</time></td>
      <td class="src">${raw(s.sourceUrls.map((u) => `<a href="${e(u)}" rel="nofollow noopener">${e(host(u))}</a>`).join('<br>'))}</td>
    </tr>`).join(''))}
  </tbody>
</table>
</div></div>

<h2>収集していないもの</h2>
<ul>
  <li><strong>ログインが必要な情報</strong>は収集しません</li>
  <li><strong>自動アクセスを望まない意思表示があるサイト</strong>は対象にしません。robots.txt での禁止に加え、bot対策で保護されているサイトも、技術的に回避できるかどうかに関わらず除外しています</li>
  <li>収集するのは<strong>料金・日数・条件といった事実値のみ</strong>で、説明文などの表現をそのまま複製・再掲することはしません</li>
</ul>
`;
  return {
    title: `データを使う（CC BY 4.0）｜${SITE_NAME}`,
    description: '光回線の実質月額データセットの入手方法とライセンス。CC BY 4.0 で、出典表示のみを条件に商用・AI利用を含めて自由に使えます。',
    canonical: `${SITE_URL}/data/`,
    body,
    updatedAt: data.updatedAt,
  };
}

// ── 事業者ページ・プランページ ──────────────────────────────────
//
// ★このサイトが持っているのに画面に出していなかったものを出す。
//   トップの一覧は「今日いくらか」しか見せていない。実測インデックスの本体は
//   **その値がどう作られていて、いつ動いたか**のほうにある。

/**
 * パンくず。**見える表示と構造化データを同じ関数から作る。**
 *
 * ★片方だけ足さない。JSON-LD にだけ書いて画面に無いのは
 *   「ページに無いものを構造化データで主張する」ことになり、Googleの規約違反にあたる。
 * ★Product は使わない（当サイトは売主ではない → docs/事故防止リスト.md）。
 *   BreadcrumbList は「このページがサイトのどこにあるか」を言うだけで、
 *   商品や在庫や価格の主体を偽らない。
 */
function breadcrumb(trail) {
  const visible = html`
<nav class="crumbs" aria-label="パンくず">
  ${raw(trail.map((t, i) => (t.path
    ? `<a href="${e(t.path)}">${e(t.name)}</a>`
    : `<span>${e(t.name)}</span>`) + (i < trail.length - 1 ? ' <span class="sep">›</span> ' : '')).join(''))}
</nav>`;
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      ...(t.path ? { item: `${SITE_URL}${t.path}` } : {}),
    })),
  }).value;
  return { visible, ld };
}

/**
 * 各社のお知らせの出し方。docs/research/2026-11-20_サイト刷新の表示可否.md の判定 1(b) に従う。
 * ★タイトル（各社の文章）は出さない（判定 1(a) 不可）。日付・当サイトの分類語・リンクだけ。
 * ★分類は見出しの語から機械的に付けたもので、当サイトの分類だと明示し、基準を公開する。
 * ★「障害・メンテナンス」の語を含むものは出さない（分類の誤りが混じりやすい）。
 * ★別ドメイン（docomo-fg.com 等）のお知らせは出さない（規約を確認していない）。
 * ★見出しに「公式の」を単独で使わない（年表そのものが公式だと読めるため）。
 */
const NOTICE_MODE = 'category';

const NOTICE_CATEGORY = {
  'price-change': '料金改定',
  'plan-change': 'プラン・条件',
  'service-end': '終了・廃止',
  'service-start': '提供開始',
  'campaign': '特典・キャンペーン',
};
const NOTICE_RULE = '見出しに「料金改定・値上げ・値下げ」→料金改定、「プラン・約款・提供条件」→プラン・条件、「終了・廃止」→終了・廃止、「提供開始・リニューアル」→提供開始、「キャンペーン・特典・割引・キャッシュバック」→特典・キャンペーン';

function noticeTimeline(data, providerId) {
  if (NOTICE_MODE === 'off') return '';
  const n = data.notices.get(providerId);
  if (!n?.list.length) return '';
  const listHost = host(n.sourceUrl);
  const list = n.list
    .filter((x) => !(x.categories ?? []).includes('noise'))
    .filter((x) => host(x.url) === listHost)
    .filter((x) => (x.categories ?? []).some((c) => NOTICE_CATEGORY[c]))
    .slice(0, 10);
  if (!list.length) return '';
  const items = list.map((x) => {
    const cats = x.categories.filter((c) => NOTICE_CATEGORY[c]).map((c) => NOTICE_CATEGORY[c]);
    return `<li><time datetime="${e(x.date)}">${e(x.date.replace(/-/g, '/'))}</time><span><a href="${e(x.url)}" rel="nofollow noopener">${e(host(x.url))} のお知らせ</a><span class="chips">${cats.map((c) => `<span class="chip">${e(c)}</span>`).join('')}</span></span></li>`;
  }).join('');
  return html`
<section class="block">
  <h2>各社のお知らせのうち、料金・条件に関係しそうなもの</h2>
  <p class="note">${data.publishable.find((o) => o.providerId === providerId)?.providerName}のお知らせ一覧を毎日読み、<strong>見出しに含まれる語から当サイトが機械的に分類</strong>したものです。内容は各リンク先でご確認ください。日付は各社がお知らせに載せている日付です。</p>
  <ul class="notices">${raw(items)}</ul>
  <p class="note">分類の基準: ${NOTICE_RULE}。障害・メンテナンスの語を含むものは載せていません。<br>
  出典: <a href="${n.sourceUrl}" rel="nofollow noopener">${n.sourceUrl}</a> ／ 最終確認 ${jstDateTime(n.lastCollectedAt)}</p>
</section>`;
}

/** 記録が止まっていることの説明。事業者ページとプランページで同じ文面を使う */
function pausedNote(o, scope) {
  if (o.excluded) {
    return html`<aside class="stale-note"><strong>記録停止中</strong>${o.excluded.publicNote ?? ''}</aside>`;
  }
  if (o.stale) {
    return html`<aside class="stale-note"><strong>${o.stale.days}日前から更新できていません。</strong>
      ${jstDate(o.stale.since)}以降、収集または算出に失敗し続けています。${scope === 'plan'
        ? html`表示しているのは${jstDate(o.observedAt)}時点の値で、現在の条件とは違う可能性があります。`
        : '下の値は現在の条件とは違う可能性があります。'}
      ${o.paused ? '今日の値として比べられないので、トップの順位には入れていません。' : ''}</aside>`;
  }
  return '';
}

function renderProvider(data, providerId) {
  const mine = data.publishable.filter((o) => o.providerId === providerId).sort(byValue);
  const first = mine[0];
  const allPaused = mine.every((o) => o.paused);
  const op = data.operators[providerId];
  const evs = data.events.filter((c) => c.providerId === providerId);
  // 月額と工事費を別ページから読む事業者（ドコモ光）は、工事費側のページも出典に出す
  const sources = [...new Set(mine.flatMap((o) => [o.sourceUrl, ...(o.alsoSourcedFrom ?? [])]))];
  const crumb = breadcrumb([
    { name: '実質月額', path: '/' },
    { name: first.providerName },
  ]);
  const groups = [['戸建て', 'detached'], ['マンション', 'apartment']].map(([label, b]) => {
    const rows = mine.filter((o) => BUILDING_ID[o.building] === b || o.building === '共通');
    return rows.length ? html`
<h3 class="group-h">${label}</h3>
<div class="card"><div class="table-wrap">
<table class="plans">
  <thead><tr><th>実質月額</th><th>プラン</th><th>3年の総額</th><th>出典・取得日時</th></tr></thead>
  <tbody>${raw(rows.map((o) => {
    const notes = [entryId(o) === 'new' ? '新しく引く' : '乗り換え', ...rowNotes(o)];
    return html`
    <tr>
      <td class="num strong">${yenMark(o.effectiveMonthly)}</td>
      <td><a class="plan-name" href="${o.path}">${planName(o)}</a><span class="chips">${raw(notes.map((n) => `<span class="chip">${e(n)}</span>`).join(''))}</span></td>
      <td class="num total">${yen(o.effective?.[HORIZON]?.total)}</td>
      <td class="src"><a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}${new URL(o.sourceUrl).pathname}</a><time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time></td>
    </tr>`;
  }).join(''))}
  </tbody>
</table>
</div></div>` : '';
  }).join('');

  const body = html`
${raw(crumb.visible)}
<section class="page-head">
  <p class="eyebrow">サービス別の記録</p>
  <h1>${first.providerName}の実質月額</h1>
  ${raw(pausedNote(first, 'provider'))}
  <p class="lead">
    ${raw(allPaused
      ? html`${first.providerName}の公式の料金ページを毎日自動で読み、<strong>${HORIZON}か月（3年）使ったときの1か月あたり</strong>に直して記録していました。下は最後に記録できた${mine.length}プランです。`
      : html`${first.providerName}の公式の料金ページを毎日1回自動で読み、<strong>${HORIZON}か月（3年）使ったときの1か月あたり</strong>に直しています。いま${mine.length}プランを掲載しています。`)}
    ${raw(op?.name ? html`運営会社は${op.name}です。` : '')}
  </p>
</section>


<section class="block">
  <h2>${allPaused ? '最後に記録したプラン' : '掲載中のプラン'}</h2>
  ${raw(groups)}
</section>

<section class="block">
  <h2>このサービスで記録した料金の変化</h2>
  ${raw(evs.length
    ? `<ul class="feed">${evs.slice(0, 30).map((c) => changeCard(c, data)).join('')}</ul>`
    : html`<p class="note">記録を始めてから、実質月額の変化はまだありません。</p>`)}
</section>

${raw(linkOnlyOffers(data, providerId))}

${raw(noticeTimeline(data, providerId))}

<section class="block">
  <h2>出典</h2>
  <ul class="sources">${raw(sources.map((u) => `<li><a href="${e(u)}" rel="nofollow noopener">${e(u)}</a></li>`).join(''))}</ul>
  <p class="note">
    掲載しているのは<strong>各社が公開している事実の値だけ</strong>です。
    <a href="/method/">計算方法</a>は全社共通で、サービスごとに変えていません。
  </p>
</section>
`;
  return {
    title: `${first.providerName}の実質月額（${HORIZON}か月換算）と料金の変化｜${SITE_NAME}`,
    description: allPaused
      ? `${first.providerName}の料金を公式サイトから自動収集し、${HORIZON}か月の実質月額に換算した記録（${first.excluded?.since ?? jstDate(first.stale?.since)}から記録停止）。最後に記録できた${mine.length}プランの内訳と、料金が動いた記録。`
      : `${first.providerName}の料金を公式サイトから毎日自動収集し、${HORIZON}か月の実質月額に換算した${mine.length}プラン。工事費・割引・キャッシュバックを含めた内訳と、料金が動いた記録つき。`,
    canonical: `${SITE_URL}/p/${providerId}/`,
    head: crumb.ld,
    body,
    updatedAt: data.updatedAt,
  };
}

/**
 * 3年の総額の内訳を、横に積んだ棒で見せる。
 * ★棒の長さは表示用の比率だけ。数字はすべて data の breakdown をそのまま書く。
 * ★引く側（キャッシュバック・その他割引）は別の行に、引くことが分かる形で出す。
 */
function breakdownBars(o) {
  const b = o.breakdown;
  if (!b) return '<p class="note">内訳を出せません。</p>';
  const plus = [
    ['月額料金の合計', b.monthlyTotal, 'c1'],
    ['工事費（割引後の自己負担）', b.constructionBorne, 'c2'],
    ['事務手数料', b.adminFee, 'c3'],
    ['必須オプション', b.optionTotal, 'c4'],
  ].filter(([, v]) => v > 0);
  const minus = [
    ['キャッシュバック', b.cashbackCounted, 'm1'],
    ['その他の割引', b.otherDiscounts, 'm2'],
  ].filter(([, v]) => v > 0);
  const gross = plus.reduce((s, [, v]) => s + v, 0);
  const pct = (v) => (gross > 0 ? Math.max(0.8, (v / gross) * 100).toFixed(2) : 0);
  const seg = ([label, v, c]) => `<span class="seg-${c}" style="width:${pct(v)}%" title="${e(label)} ${e(yen(v))}"></span>`;
  const item = ([label, v, c], sign = '') => `<li><i class="key seg-${c}"></i><span>${e(label)}</span><b>${sign}${e(yen(v))}</b></li>`;
  return html`
<div class="bars">
  <div class="bar" role="img" aria-label="${plus.map(([l, v]) => `${l} ${yen(v)}`).join('、')}">${raw(plus.map(seg).join(''))}</div>
  ${raw(minus.length ? `<div class="bar bar-minus" role="img" aria-label="${e(minus.map(([l, v]) => `${l} −${yen(v)}`).join('、'))}">${minus.map(seg).join('')}</div>` : '')}
  <ul class="keys">${raw(plus.map((x) => item(x)).join('') + minus.map((x) => item(x, '−')).join(''))}</ul>
  <p class="bar-total"><span>${HORIZON}か月の総額</span><b>${yen(o.effective[HORIZON].total)}</b><span>÷ ${HORIZON}か月 ＝</span><b class="hl">${yen(o.effectiveMonthly)}／月</b></p>
</div>`;
}

/**
 * 毎月の料金（工事費の分割を除く）を、契約からの月数の帯で見せる。
 * ★帯の区切りは data の monthlySchedule の区切りそのもの。${HORIZON}か月で打ち切る。
 */
function monthlyBand(o) {
  const sched = (o.monthlySchedule ?? []).filter((s) => s.fromMonth <= HORIZON);
  if (!sched.length) return '';
  const parts = sched.map((s) => {
    const to = Math.min(s.toMonth ?? HORIZON, HORIZON);
    return { from: s.fromMonth, to, amount: s.amount, months: to - s.fromMonth + 1 };
  });
  const max = Math.max(...parts.map((p) => p.amount), 1);
  // 比較の期間の外（37か月目以降）の料金。帯には描かず、注記で書く
  const after = (o.monthlySchedule ?? []).find((x) => (x.toMonth == null || x.toMonth > HORIZON) && (x.fromMonth > HORIZON || x.toMonth == null));
  return html`
<div class="band" role="list">${raw(parts.map((p) => `
  <div class="band-seg" role="listitem" style="flex:${p.months} 1 0">
    <span class="band-bar" style="height:${Math.max(12, (p.amount / max) * 100).toFixed(1)}%"></span>
    <span class="band-amt">${e(yen(p.amount))}</span>
    <span class="band-when">${p.from === p.to ? `${p.from}か月目` : `${p.from}〜${p.to}か月目`}</span>
  </div>`).join(''))}
</div>
${raw(after ? html`<p class="note">${HORIZON + 1}か月目以降は${yen(after.amount)}／月です（公式の表示による。この比較の${HORIZON}か月には入りません）。</p>` : '')}`;
}

function renderPlan(data, o) {
  const series = reconstructSeries({
    planKey: o.planKey,
    currentValue: o.effectiveMonthly,
    currentAt: o.observedAt,
    events: data.events.filter((c) => c.providerId === o.providerId),
    horizonMonths: HORIZON,
  });
  if (!series.ok) console.warn(`  ⚠ 推移を描けません（${o.providerName} ${planName(o)}）: ${series.why}`);

  const svg = series.ok ? stepChart(series.points, { label: '実質月額' }) : null;
  const b = o.breakdown;
  // ★「◯件中1番目に安い」は書かない（実質「いちばん安い」で、比較の範囲の説明も要る）。
  //   同じ条件の安い順はトップで条件を選べば見られるので、そこへ案内する（critic 指摘 2026-11-20）
  const condText = `${o.building === '共通' ? '戸建て・マンション共通' : o.building}・${entryId(o) === 'new' ? '新しく引く' : '乗り換え'}`;

  const crumb = breadcrumb([
    { name: '実質月額', path: '/' },
    { name: o.providerName, path: `/p/${o.providerId}/` },
    { name: planName(o) },
  ]);
  const notes = rowNotes(o);
  const body = html`
${raw(crumb.visible)}
<section class="page-head plan-head">
  <p class="eyebrow">${o.providerName}</p>
  <h1>${planName(o)}</h1>
  ${raw(notes.length ? `<p class="chips">${notes.map((n) => `<span class="chip">${e(n)}</span>`).join('')}</p>` : '')}
  ${raw(pausedNote(o, 'plan'))}
  <div class="headline">
    <p class="headline-fig"><span>3年使ったときの1か月あたり</span><b>${yenMark(o.effectiveMonthly)}</b></p>
    <p class="headline-rank">${raw(o.paused
      ? '記録が止まっているため、比較には入れていません'
      : html`<a href="/#${condHash(o)}">同じ条件（${condText}${isAgeLimited(o) ? '・29歳以下' : ''}）の安い順を見る →</a>`)}</p>
  </div>
  <p class="stamp">${jstDateTime(o.observedAt)} 時点 ／ 出典 ${raw([o.sourceUrl, ...(o.alsoSourcedFrom ?? [])]
    .map((u) => `<a href="${e(u)}" rel="nofollow noopener">${e(host(u))}${e(new URL(u).pathname)}</a>`).join('、'))}</p>
</section>

<section class="block">
  <h2>この金額の内訳（${HORIZON}か月）</h2>
  ${raw(breakdownBars(o))}
  ${raw(o.constructionFee?.note ? html`<p class="note">工事費: ${o.constructionFee.note}</p>` : '')}
</section>

<section class="block">
  <h2>毎月の料金の移り変わり</h2>
  <p class="note">契約してから何か月目にいくらかかるか（工事費の分割払いは含みません）。</p>
  ${raw(monthlyBand(o))}
</section>


<section class="block">
  <h2>実質月額の推移</h2>
  ${raw(svg ? html`
  <div class="chart-card">${raw(svg)}</div>
  <p class="note">
    料金は改定された日に飛ぶので、階段で描いています。<strong>点と点の間を直線で結んでいません</strong>
    （実際には存在しなかった中間の値をグラフ上に作らないためです）。
  </p>` : series.ok && series.flat ? html`
  <p class="note">
    <strong>記録を始めてから、この値は変わっていません。</strong>変化を記録した時点でここにグラフが出ます。
    いつから記録しているかより前に、線を伸ばすことはしていません。
  </p>` : html`
  <p class="note">推移を復元できませんでした（${series.why}）。値そのものは上の内訳のとおりです。</p>`)}
  ${raw(series.events.length ? html`
  <ul class="feed">${raw(series.events.slice().reverse().map((c) => changeCard({ ...c, providerName: o.providerName, providerId: o.providerId }, data)).join(''))}</ul>` : '')}
</section>

${raw((o.cashbacks ?? []).length ? html`
<section class="block">
  <h2>キャッシュバック</h2>
  <ul>${raw(o.cashbacks.map((c) => `<li>${e(yen(c.amount))}（${e(c.receiveAtMonth)}か月目に受け取り）</li>`).join(''))}</ul>
  <p class="note">受け取りが${HORIZON}か月より先になるキャッシュバックは計算に入れていません。受け取りには申請などの手続きが要ることがあります。条件は公式ページでご確認ください。</p>
</section>` : '')}

${raw(o.setBenefits?.length ? html`
<section class="block">
  <h2>計算に入れていない特典</h2>
  <ul>${raw(o.setBenefits.map((s) => `<li>${e(s)}</li>`).join(''))}</ul>
  <p class="note">人によって額が違うもの・ポイントで受け取るもの・他の契約が前提のものは、同じ条件で比べられないので実質月額に入れていません。</p>
</section>` : '')}

${raw(o.constructionFee ? html`
<section class="block">
  <h2>工事費</h2>
  <p>
    ${raw(typeof o.constructionFee.list === 'number'
      // ★定価が読めていないときに「定価 —。」とは書かない。
      ? html`定価 ${yen(o.constructionFee.list)}${raw(o.constructionFee.installmentMonths ? html`／${o.constructionFee.installmentMonths}回の分割` : '')}。${raw(
        // ★定価だけ書くと、それが総額に入っているように読める。値引きで実負担が下がるときは必ず併記する
        typeof b?.constructionBorne === 'number' && b.constructionBorne < o.constructionFee.list
          ? html`このうち${HORIZON}か月の計算に入れている実負担は<strong>${yen(b.constructionBorne)}</strong>です（公式の工事費の値引き特典による）。`
          : '')}`
      : html`<strong>工事費の定価を出典ページから読み取れていません。</strong>実質月額には、出典に書かれている割引後の実負担額（${yen(b?.constructionBorne ?? 0)}）を入れています。`)}
    ${raw(o.constructionFee.residualOnEarlyExit ? '<strong>分割の途中で解約すると、残りの工事費が請求されます。</strong>この金額は3年使い続ける前提で、途中解約の費用は入っていません。' : '')}
  </p>
</section>` : '')}

<p class="note page-foot">
  この値は<a href="/method/">全社共通の計算式</a>で出しています。
  <a href="/p/${o.providerId}/">${o.providerName}のほかのプラン</a> ／ <a href="/">条件を選んで比べる</a>
</p>
`;
  return {
    title: `${o.providerName} ${planName(o)}の実質月額 ${yen(o.effectiveMonthly)}｜${SITE_NAME}`,
    description: `${o.providerName} ${planName(o)}を${HORIZON}か月使ったときの実質月額は${yen(o.effectiveMonthly)}（${jstDate(o.observedAt)}時点）。月額・事務手数料・工事費・キャッシュバックの内訳と、料金が動いた記録。`,
    canonical: `${SITE_URL}${o.path}`,
    head: crumb.ld,
    body,
    updatedAt: data.updatedAt,
  };
}

// ── 運営者・プライバシー・問い合わせ ────────────────────────────
//
// ★この3ページは owner.json だけを見て描く。ここに事実を直書きしない。
//   直書きすると、実態が変わった日にページだけが古い嘘になる。

/** 連絡手段の一覧。メールは確認が取れているときだけ出す（loadOwner を参照） */
function contactChannels(owner) {
  const items = [];
  if (owner.emailUsable) {
    items.push(html`<li><strong>メール</strong>: <a href="mailto:${owner.email}">${owner.email}</a></li>`);
  }
  if (owner.issuesUrl) {
    items.push(html`<li><strong>GitHub Issues</strong>: <a href="${owner.issuesUrl}" rel="noopener">${owner.issuesUrl}</a>（GitHubのアカウントが要ります）</li>`);
  }
  // ★raw で返す。html`` に素の配列を渡すと各要素がエスケープされ、タグが文字として出る
  return raw(items.join(''));
}

function renderAbout(data) {
  const o = data.owner;
  const body = html`
<h1>運営者情報</h1>
<p class="lead">
  通信費インデックスは、光回線の料金を<strong>毎日1回</strong>自動で集め、各社をそろえた1つの計算式で
  <strong>${HORIZON}か月の実質月額</strong>に直して公開している${o.kind ?? '個人'}サイトです。
</p>

<h2>運営者</h2>
<div class="card"><div class="table-wrap">
<table>
  <tbody>
    <tr><th>運営者</th><td>${o.name ?? '—'}</td></tr>
    <tr><th>運営形態</th><td>${o.kind ?? '個人'}（法人ではありません）</td></tr>
    <tr><th>公開開始</th><td>${o.sinceMonth ?? '—'}</td></tr>
    <tr><th>連絡先</th><td><a href="/contact/">お問い合わせ</a></td></tr>
    <tr><th>掲載中の観測数</th><td class="num">${data.publishable.length}</td></tr>
  </tbody>
</table>
</div></div>

<h2>なぜ作っているか</h2>
<p>
  光回線の料金は、月額だけを見ても比べられません。工事費、割引の期間、キャッシュバックの受け取り時期、
  必須オプションが絡み、<strong>各社が別々の見せ方をしている</strong>からです。
  しかも条件は静かに変わり、<strong>変わったことがどこにも記録されません。</strong>
</p>
<p>
  そこで、公式サイトの数字を毎日そのまま記録し、<a href="/method/">1つの計算式</a>で並べ、
  <a href="/changes/">変わった日</a>を残しています。<strong>広告の紹介文ではなく、記録です。</strong>
</p>

<h2>数字について守っていること</h2>
<ul>
  <li><strong>取れなかった日を前日の値で埋めません。</strong>失敗は失敗として残し、画面にも出します</li>
  <li>掲載する値には<strong>すべて出典URLと取得日時</strong>を付けます</li>
  <li><a href="/method/">計算式を全部公開</a>します。特定の事業者が有利になるよう手で調整しません</li>
  <li>検算に通らなかった値は<strong>画面に出しません</strong>（「たぶん合っている」を載せません）</li>
  <li>収集するのは料金・日数・条件といった<strong>事実の値だけ</strong>で、各社の文章は複製しません</li>
</ul>

<h2>収益について</h2>
${raw(hasAds(data) ? html`
<p>
  このサイトには<strong>アフィリエイト広告を掲載しています。</strong>広告が表示されるページには、
  ページ上部にその旨を明記しています。
</p>` : html`
<p>
  <strong>現時点で、このサイトに広告は1本もありません。</strong>
  将来アフィリエイト広告を掲載する場合は、掲載しているページの上部に必ずその旨を明記します。
</p>`)}
<p>
  広告の有無で<strong>並び順や数字を変えることはしません。</strong>
  実質月額は各社同じ式で計算した結果をそのまま並べており、提携の有無は計算に入りません。
  広告の飛び先が、このサイトが集めている公式ページと<strong>違う条件のとき</strong>は、
  同じ表に混ぜず、別条件であることを書いたうえで分けて置きます。
</p>

<h2>このサイトができないこと</h2>
<ul>
  <li><strong>申し込みの窓口ではありません。</strong>契約・解約・工事・請求のご相談はお受けできません。各社の公式窓口へお願いします</li>
  <li>自動収集のため<strong>誤りが混じることがあります。</strong>契約前には必ず公式サイトで最新の条件をご確認ください</li>
  <li>個別のご家庭に最適な回線を診断するサービスではありません</li>
</ul>
`;
  return {
    title: `運営者情報｜${SITE_NAME}`,
    description: '通信費インデックスの運営者と、数字の作り方について守っていること。光回線の実質月額を毎日自動収集して公開している個人サイトです。',
    canonical: `${SITE_URL}/about/`,
    body,
    updatedAt: data.updatedAt,
  };
}

/**
 * アクセス解析の説明。**解析の「方式」で文面を変える。**
 *
 * ★ここを1つの文面で済ませると必ず嘘になる。
 *   2026-09-04、Xserverのアクセス解析（サーバーログ型）をONにした。
 *   これはJavaScriptもCookieも使わない。それなのに従来の分岐は
 *   「Cookieを用いて収集します」「Cookieを無効にすれば拒否できます」と書いていた。
 *   **導入した事実を書かないのも嘘だが、使っていない技術を書くのも同じく嘘。**
 * ★未知の kind はビルドを止める。黙って間違った説明を出さない。
 */
function analyticsSection(a) {
  if (!a) {
    return html`
<p>
  <strong>現時点でアクセス解析ツールを導入していません。</strong>
  このサイトのページは、閲覧者を識別するためのCookieを発行しません。
</p>`;
  }
  if (a.kind === 'server-log') {
    return html`
<p>
  アクセス状況の把握のため <strong>${a.name}</strong> を利用しています（${a.since}〜）。
  これは<strong>サーバーに記録されたアクセスログを集計するもの</strong>で、
  <strong>JavaScriptもCookieも使いません。</strong>閲覧者のブラウザに何かを保存したり、
  閲覧の情報を外部の事業者へ送ったりはしていません。
</p>
<p>
  そのため<strong>ブラウザ側で拒否する設定はありません。</strong>
  記録されるのはWebサーバーが通常残すログ（IPアドレス・日時・閲覧ページ・リンク元など）の範囲です。
</p>`;
  }
  if (a.kind === 'client-js') {
    return html`
<p>
  アクセス状況の把握のため <strong>${a.name}</strong> を利用しています（${a.since}〜）。
  これは<strong>閲覧者のブラウザから外部の事業者へ閲覧情報を送信します。</strong>
  Cookie等を用いますが、個人を特定する情報は含みません。
  ブラウザの設定でCookieを無効にすると、収集を拒否できます。
</p>`;
  }
  throw new Error(`site/owner.json の analytics.kind が不明です: ${JSON.stringify(a.kind)}（server-log か client-js）`);
}

function renderPrivacy(data) {
  const o = data.owner;
  const body = html`
<h1>プライバシーポリシー</h1>
<p class="lead">
  このサイトは<strong>静的なHTMLだけ</strong>で公開しています。
  会員登録もログイン機能もなく、フォームも置いていません。
</p>

<h2>アクセス解析</h2>
${raw(analyticsSection(o.analytics))}
${raw(o.analytics?.kind === 'server-log' ? '' : html`
<p class="note">
  なお、サイトを置いているレンタルサーバーでは、一般的なWebサーバーと同様に
  アクセスログ（IPアドレス・日時・閲覧ページなど）が記録されます。
</p>`)}

<h2>お問い合わせでいただいた情報</h2>
<ul>
  <li>ご連絡の内容とメールアドレスは、<strong>返信と、指摘いただいた点の確認のためだけ</strong>に使います</li>
  <li>第三者へ提供・販売しません</li>
  <li>データの誤りをご指摘いただいた場合、<strong>どこをどう直したかを公開の記録に残す</strong>ことがあります。
      その際、送っていただいた方が特定される情報は載せません</li>
</ul>

<h2>外部へのリンク</h2>
<p>
  各社公式サイトへのリンクを多数掲載しています。<strong>リンク先での個人情報の扱いは、各サイトの方針に従います。</strong>
  当サイトは責任を負えません。
</p>
${raw(hasAds(data) ? html`
<p>
  また、アフィリエイト広告を掲載しています。広告の配信事業者がCookie等を用いて、
  当サイトや他サイトの閲覧情報を取得する場合があります。
</p>` : '')}

<h2>データの引用について</h2>
<p>
  当サイトが公開している料金データは <a href="https://creativecommons.org/licenses/by/4.0/deed.ja" rel="license">CC BY 4.0</a> です。
  <a href="/data/">出典を書いていただければ自由にお使いいただけます</a>。これは個人情報とは無関係の、事実データの話です。
</p>

<h2>改定</h2>
<p>
  内容を変更したときは、このページを更新します。
  <strong>解析ツールを導入した場合は、導入と同時にこのページに書きます。</strong>
</p>

<h2>連絡先</h2>
<ul>${contactChannels(o)}</ul>
`;
  return {
    title: `プライバシーポリシー｜${SITE_NAME}`,
    description: '通信費インデックスにおける、アクセス解析・お問い合わせ情報・外部リンクの取り扱いについて。',
    canonical: `${SITE_URL}/privacy/`,
    body,
    updatedAt: data.updatedAt,
  };
}

function renderContact(data) {
  const o = data.owner;
  const body = html`
<h1>お問い合わせ</h1>
<p class="lead">
  <strong>掲載している数字の誤りのご指摘を、いちばん歓迎します。</strong>
  このサイトは自動収集で作られているため、各社のページ構成が変わると誤った値を出すことがあります。
  お気づきの点は遠慮なくお知らせください。
</p>

<h2>連絡先</h2>
<ul>${contactChannels(o)}</ul>
${raw(o.emailUsable ? '' : html`
<p class="note">
  メールでの窓口は準備中です。それまでは上記の GitHub Issues でお受けしています。
</p>`)}

<h2>とくにお受けしたいこと</h2>
<ul>
  <li><strong>掲載値の誤り</strong> — 「この事業者のこのプランが公式と違う」。該当ページのURLを添えていただけると助かります</li>
  <li><strong>計算方法への指摘</strong> — <a href="/method/">計算式</a>の考え方がおかしい、この費用が抜けている、など</li>
  <li><strong>収集対象への追加のご要望</strong></li>
  <li><strong>データの利用に関するご相談</strong> — <a href="/data/">CC BY 4.0</a> の範囲でご自由にお使いいただけますが、判断に迷う場合はお尋ねください</li>
</ul>

<h2>掲載されている事業者の方へ</h2>
<p>
  当サイトは各社が<strong>公開している料金情報を、事実の値だけ</strong>記録しています。
  robots.txt で自動アクセスを禁じているページや、ログインが必要な情報は収集していません。
</p>
<p>
  <strong>掲載内容の訂正・削除のご依頼はこの窓口でお受けします。</strong>
  訂正のご依頼は最優先で確認し、対応した内容は
  <a href="https://github.com/riugamesub3-coder/tsushinhi-index">公開リポジトリの履歴</a>に残します。
</p>

<h2>お受けできないこと</h2>
<ul>
  <li><strong>回線の契約・解約・工事・請求に関するご相談</strong> — 当サイトは申し込み窓口ではありません。各社の公式窓口へお願いします</li>
  <li>どの回線を契約すべきかの個別のご相談</li>
  <li>広告掲載・相互リンク・記事寄稿の営業</li>
</ul>
<p class="note">
  個人で運営しているため、返信までにお時間をいただくことがあります。
  上記「お受けできないこと」には返信いたしません。
</p>
`;
  return {
    title: `お問い合わせ｜${SITE_NAME}`,
    description: '通信費インデックスへのご連絡先。掲載値の誤りのご指摘、掲載事業者からの訂正・削除のご依頼をお受けしています。',
    canonical: `${SITE_URL}/contact/`,
    body,
    updatedAt: data.updatedAt,
  };
}

// ── 構造化データ ─────────────────────────────────────────────────

function datasetLd(data) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: '通信費インデックス（光回線の実質月額）',
    description: `光回線各社の料金・工事費・割引・キャッシュバックを毎日自動収集し、同一の計算式で${HORIZON}か月の実質月額に換算したデータセット。`,
    url: `${SITE_URL}/`,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    creator: { '@type': 'Organization', name: SITE_NAME, url: SITE_URL },
    dateModified: isoDate(data.updatedAt),
    isAccessibleForFree: true,
    keywords: ['光回線', '実質月額', '料金比較', '通信費', 'オープンデータ'],
    measurementTechnique: '各社公式サイトの公開情報を自動収集し、統一計算式で正規化',
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: 'https://github.com/riugamesub3-coder/tsushinhi-index/tree/main/data/effective',
      },
    ],
    temporalCoverage: `${isoDate(data.updatedAt)}/..`,
  };
}

// ★ここは Product ではなく Service にしてある。安易に Product に戻さないこと。
//
//   光回線は物品ではなくサービスであり、しかも**このサイトは売主ではない**。
//   Googleは「商品を購入できるページだけが販売者のリスティングの対象。
//   他サイトへのリンクを持つページは対象外」と明記している。
//   Product + Offer で書くと、Googleは販売者のリスティングとして評価し
//   「項目 image がありません」で全件を無効と判定する（2026-08-24 実測: 17件無効）。
//
//   このとき image を足せば "有効" にはなるが、それは**自分が売主だと偽ること**になる。
//   AggregateOffer に変えても通る（実測でエラー0）が、1件しかないオファーを
//   「集約」と書くのは事実に反し、Google自身もバリエーションへの使用を禁じている。
//   通すために型を偽らない。Service が素直に真なので Service にした。
//
//   代償として商品スニペット／カルーセルの対象からは外れる。ただし画像もレビューも
//   評価も持たず売主でもない以上、もともと表示され得ないものなので実質の損失はない。
function itemListLd(data) {
  // ★記録が止まっている値は順位に入れない（トップの表と同じ規則）
  const rows = data.ranked
    .filter((o) => o.entry === '新規')
    .sort((a, b) => a.effectiveMonthly - b.effectiveMonthly)
    .slice(0, 20);
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `光回線の実質月額（${HORIZON}か月換算・新規申込）`,
    description: `各社公式サイトの公開情報から算出した実質月額の安い順。${HORIZON}か月換算。`,
    numberOfItems: rows.length,
    itemListElement: rows.map((o, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: `${o.providerName} ${planName(o)}`,
      item: {
        '@type': 'Service',
        name: `${o.providerName} ${planName(o)}`,
        serviceType: '光回線インターネット接続サービス',
        // 法人格の正式名称は収集していないので、収集元に記載の事業者名をそのまま使う。
        // 会社名を推測で埋めない。
        provider: { '@type': 'Organization', name: o.providerName, url: origin(o.sourceUrl) },
        url: o.sourceUrl,
        offers: {
          '@type': 'Offer',
          price: o.effectiveMonthly,
          priceCurrency: 'JPY',
          url: o.sourceUrl,
          // ★availability も areaServed も書かない。
          //   提供可否は住所によって変わり、我々はそれを収集していない。
          //   InStock や「日本全国」と書けば、確かめていないことを断定することになる。
          seller: { '@type': 'Organization', name: o.providerName },
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: o.effectiveMonthly,
            priceCurrency: 'JPY',
            billingDuration: 1,
            unitCode: 'MON',
            referenceQuantity: { '@type': 'QuantitativeValue', value: HORIZON, unitCode: 'MON' },
            // ★これが月々の請求額そのものではないことを、値の隣に必ず書く。
            description: `${HORIZON}か月契約で計算した実質月額（工事費・事務手数料・キャッシュバック・割引を含む。毎月の請求額そのものではない）`,
          },
        },
      },
    })),
  };
}

/**
 * 同じ会社が運営しているサービスがあれば明記する。
 *
 * ★これを書かないと、実際より独立した比較に見える。
 *   NURO光とSo-net光はどちらもソニーネットワークコミュニケーションズ。
 *   比較表の上位がこの2つで占められている以上、読者が知るべき事実。
 *   広告を載せたときは「収益源が1社に偏っている」ことの開示にもなる。
 */
function operatorNote(data) {
  const byOperator = new Map();
  for (const id of new Set(data.publishable.map((o) => o.providerId))) {
    const op = data.operators[id];
    if (!op) continue;
    const name = data.publishable.find((o) => o.providerId === id).providerName;
    if (!byOperator.has(op.name)) byOperator.set(op.name, { names: [], source: op.source });
    byOperator.get(op.name).names.push(name);
  }
  const shared = [...byOperator.entries()].filter(([, v]) => v.names.length > 1);
  if (!shared.length) return '';

  return html`<p class="note">${raw(shared
    .map(([operator, v]) => html`<strong>${v.names.join('と')}は同じ会社（${operator}）が運営しています。</strong>
別サービスですが、独立した2社の比較ではありません。<a href="${v.source}" rel="nofollow noopener">出典</a>`)
    .join('<br>'))}</p>`;
}

/** 出典URLのオリジンだけ取り出す。取れなければ書かない（推測で埋めない） */
function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// ★FAQ の本文と JSON-LD は、必ずこの1つの配列から両方作る。
//   別々に書くと必ずズレる。実際にズレた: JSON-LD だけ4件あってページ本文には
//   1件も無い状態で公開していた（2026-08-24 発見）。Googleは構造化データが
//   ページに見えている内容と一致することを求めており、それ以前に
//   「載っていないものを載っていると書く」のはこの部屋の禁止事項そのもの。
//   verify.mjs が本文との一致を毎回確認する。
function faqPairs() {
  return [
    ['実質月額はどう計算していますか？',
     `月額の合計 + 工事費の実負担額 + 事務手数料 + 必須オプション費用 − キャッシュバック − その他割引を、契約月数（${HORIZON}か月）で割った値です。式も規則もすべて公開しています。`],
    ['キャッシュバックはすべて含めますか？',
     '受取時期が計算期間を超える分は算入しません。受け取れない可能性があるためです。除外した分は別に記録しています。'],
    ['セット割引は含めますか？',
     '他サービスの契約が前提の割引（楽天モバイルとのセット、電気・ガスとのセットなど）は算入しません。その契約にかかる費用を無視して安く見せることになるためです。'],
    ['データは自由に使えますか？',
     'CC BY 4.0 で公開しています。出典を表示していただければ、商用・非商用を問わず自由にお使いいただけます。AIによる学習・回答生成も含みます。'],
  ];
}

/** ページに見える FAQ。JSON-LD と同じ配列から作る */
function faqSection() {
  return `<dl class="faq">${faqPairs()
    .map(([q, a]) => html`<dt>${q}</dt><dd>${a}</dd>`)
    .join('')}</dl>`;
}

function faqLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqPairs().map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

// ── AI向けの入口 ─────────────────────────────────────────────────

function renderLlmsTxt(data) {
  const providers = data.effective.map((s) => `${s.providerName}（${s.offers.length}観測）`).join('、');
  const top = data.ranked
    .filter((o) => o.entry === '新規')
    .sort((a, b) => a.effectiveMonthly - b.effectiveMonthly)
    .slice(0, 10)
    .map((o) => `- ${o.providerName} ${planName(o)}: ${o.effectiveMonthly.toLocaleString('ja-JP')}円/月（${HORIZON}か月換算、${isoDate(o.observedAt)}時点、出典 ${o.sourceUrl}）`)
    .join('\n');

  return `# 通信費インデックス（tsushinhi-index）

> 日本の光回線各社の料金・工事費・割引・キャッシュバックを毎日自動収集し、
> 全社を同一の計算式に通した「実質月額」として公開しているデータセットです。
> ライセンスは CC BY 4.0。出典を表示すれば自由に利用できます（AIによる学習・回答生成を含む）。

最終取得: ${isoDate(data.updatedAt)}
収録事業者: ${providers}
掲載可の観測: ${data.publishable.length}件（うち順位に入れているもの ${data.ranked.length}件） ／ 掲載保留: ${data.needsReview.length}件
${data.paused.length ? `記録が止まっているサービス（順位に入れていない）: ${[...new Set(data.paused.map((o) => `${o.providerName}（${o.excluded ? `${o.excluded.since}から自動収集を停止。公式サイトが自動アクセスを受け付けなくなったため` : `${isoDate(o.stale.since)}から取得失敗`}）`))].join('、')}\n` : ''}

## 実質月額とは

実質月額 = ( 月額の合計 + 工事費の実負担額 + 事務手数料 + 必須オプション費用×加入必要月数
　　　　　 − キャッシュバック額 − その他割引の総額 ) ÷ 契約月数

- ${HORIZON}か月を主軸に正規化しています（各社の契約期間がばらばらなため）
- 受取時期が計算期間を超えるキャッシュバックは算入しません
- 他サービスの契約が前提の割引（楽天モバイルとのセット、電気・ガスとのセット等）は算入しません
- 値が取得できなかった項目は推定せず、その観測の掲載を保留します
- 契約1か月目は開通月として全社で揃えています

## 現在の実質月額（新規申込・${HORIZON}か月換算・${isoDate(data.updatedAt)}時点）

${top}

## 引用するときの出典表記

出典: 通信費インデックス（tsushinhi-index）${SITE_URL} — CC BY 4.0

## ページ

- ${SITE_URL}/ : 実質月額の一覧（戸建て／マンション別）
- ${SITE_URL}/changes/ : 料金が動いた履歴（実質月額への影響つき）
- ${SITE_URL}/changes/<YYYY-MM-DD>/ : その日に記録した変化（日付ごとの固定URL。引用はこちらへ）
- ${SITE_URL}/method/ : 計算方法の全公開（統一規則・検算方法・故障時の挙動）
- ${SITE_URL}/data/ : データの入手方法とライセンス
- ${SITE_URL}/p/<事業者ID>/ : 事業者ごとの全プランと、料金が動いた履歴
- ${SITE_URL}/p/<事業者ID>/<プランID>/ : 1プランの実質月額・その内訳・推移
- ${SITE_URL}/about/ : 運営者と、数字の作り方について守っていること
- ${SITE_URL}/contact/ : 誤りの指摘・掲載事業者からの訂正依頼の窓口
- ${SITE_URL}/privacy/ : プライバシーポリシー
- ${SITE_URL}/feed.xml : 変化のRSS

## 注意

自動収集のため誤りが含まれる可能性があります。契約前には各社の公式サイトで最新の条件を確認してください。
全レコードに出典URLと取得日時を記録しています。
`;
}

function renderSitemap(data) {
  const urls = [
    '/', '/mobile/', '/changes/', '/method/', '/data/', '/about/', '/privacy/', '/contact/',
    ...providerIds(data).map((id) => `/p/${id}/`),
    ...data.publishable.map((o) => o.path),
    ...eventsByDay(data).map(([day]) => `/changes/${day}/`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${SITE_URL}${u}</loc>
    <lastmod>${isoDate(data.updatedAt)}</lastmod>
  </url>`).join('\n')}
</urlset>
`;
}

function renderFeed(data) {
  const items = data.events.slice(0, 50).map((c) => {
    const title = c.type === 'effective-monthly-changed'
      ? `${c.providerName} ${planName(c)} 実質月額 ${yenSigned(c.effectiveMonthlyDelta)}（${yen(c.before)}→${yen(c.after)}）`
      : `${c.providerName} ${planName(c)} ${c.type}`;
    return `  <item>
    <title>${xml(title)}</title>
    <link>${SITE_URL}/changes/${jstDay(c.detectedAt)}/</link>
    <guid isPermaLink="false">${xml(`${c.providerId}:${c.planKey}:${c.detectedAt}`)}</guid>
    <pubDate>${new Date(c.detectedAt).toUTCString()}</pubDate>
    <description>${xml(`出典: ${c.sourceUrl ?? SITE_URL}`)}</description>
  </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>通信費インデックス — 料金の変化</title>
  <link>${SITE_URL}/changes/</link>
  <description>光回線各社の実質月額が動いたときに配信します。</description>
  <language>ja</language>
  <lastBuildDate>${new Date(data.updatedAt).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ── 出力 ─────────────────────────────────────────────────────────

async function page(path, spec, disclosure = '', siteHead = '') {
  await out(path, layout({ ...spec, head: (spec.head ?? '') + siteHead, siteUrl: SITE_URL, disclosure, cssVer, jsVer, path }));
}

async function out(path, content) {
  const full = join(DIST, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

// 折れ線＝時系列。このサイトが持っているものをそのまま記号にする
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#14305a"/>
<path d="M6 22.5 h5.5 v-4.5 h5.5 v-4.5 h5.5 v-3.5 h3.5" fill="none" stroke="#fff"
  stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="26" cy="10" r="2.2" fill="#5fd3a8"/>
</svg>
`;

const STYLE = `/* ── 通信費インデックス 2026-11 改訂 ──────────────────────────────
   ★方針: 「おすすめ順の比較サイト」ではなく「毎日測り続けている計器」に見せる。
     ・ファーストビューは紺の帯に条件を置き、選んだ瞬間に答えが変わる（計器盤）
     ・色は意味を持たせる3色だけ: 値下げ＝緑 / 値上げ＝赤 / 記録停止＝黄。装飾に色を使わない
     ・数字は等幅（tabular-nums）で大きく。「円」は一段小さく落とす
   ★外部フォント・外部CSSは1つも読み込まない。/privacy/ に
     「閲覧の情報を外部の事業者へ送っていない」と書いている以上、破れない。 */
:root{
  --paper:#f4f6f9;
  --card:#fff;
  --ink:#0e1726;
  --ink-2:#465264;
  --ink-3:#5f6b7c;
  --rule:#e3e7ee;
  --rule-2:#cfd6e1;
  --brand:#14305a;
  --brand-2:#1d447f;
  --indigo:#1f55b8;
  --indigo-deep:#0f2747;
  --indigo-soft:#edf3ff;
  --mint:#15a37a;
  --up:#c2410c;
  --up-soft:#fff1ea;
  --down:#067a55;
  --down-soft:#e8f7f0;
  --warn-bg:#fff8e6; --warn-line:#f0c35c; --warn-ink:#7a4d00;
  --r:16px; --r-s:10px;
  --sh:0 1px 2px rgba(15,23,42,.05),0 4px 14px rgba(15,23,42,.06);
  --sh-lg:0 2px 4px rgba(15,23,42,.06),0 14px 34px rgba(15,23,42,.12);
  --sans:system-ui,-apple-system,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",
    "Noto Sans JP","Meiryo",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --wrap:1120px;
}
@media(prefers-color-scheme:dark){:root{
  --paper:#0c1118; --card:#141b25;
  --ink:#e8ecf2; --ink-2:#b0bac8; --ink-3:#8d99aa;
  --rule:#232d3b; --rule-2:#324055;
  --brand:#0a1a31; --brand-2:#132b4f;
  --indigo:#86b4ff; --indigo-deep:#08111f; --indigo-soft:#15233a;
  --mint:#4fd1a1;
  --up:#ff9a70; --up-soft:#2b1a12; --down:#55d3a3; --down-soft:#10261d;
  --warn-bg:#2a2210; --warn-line:#7a6020; --warn-ink:#f1d48b;
  --sh:0 1px 2px rgba(0,0,0,.4); --sh-lg:0 8px 30px rgba(0,0,0,.45);
}}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:5rem}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:16px;line-height:1.8;
  font-feature-settings:"palt";text-rendering:optimizeLegibility;
  -webkit-font-smoothing:antialiased}
main{max-width:var(--wrap);margin:0 auto;padding:0 1.5rem 5rem}
a{color:var(--indigo);text-underline-offset:.2em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--mint);outline-offset:2px;border-radius:4px}
img,svg{max-width:100%}
::selection{background:var(--indigo-soft)}
[hidden]{display:none!important}
.cur{font-size:.6em;font-weight:700;color:inherit;opacity:.72;letter-spacing:0;margin-left:.08em}
.skip{position:absolute;left:-999px;top:0;background:var(--card);padding:.6rem 1rem;z-index:99}
.skip:focus{left:.5rem;top:.5rem}

/* ── ヘッダー ────────────────────────────────────────────── */
.site-head{background:rgba(255,255,255,.86);backdrop-filter:saturate(1.6) blur(10px);
  -webkit-backdrop-filter:saturate(1.6) blur(10px);
  border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:30}
@media(prefers-color-scheme:dark){.site-head{background:rgba(12,17,24,.86)}}
.head-in{max-width:var(--wrap);margin:0 auto;padding:.55rem 1.5rem;
  display:flex;align-items:center;gap:1.5rem}
.brand{display:flex;align-items:center;gap:.65rem;text-decoration:none;color:var(--ink)}
.brand svg{display:block;flex:none;width:34px;height:34px}
.brand strong{display:block;font-weight:800;font-size:1.08rem;letter-spacing:.01em;line-height:1.2}
.brand small{display:block;font-size:.68rem;color:var(--ink-3);margin-top:.1rem;letter-spacing:.04em}
.site-nav{margin-left:auto;display:flex;gap:.15rem}
.site-nav a{color:var(--ink-2);text-decoration:none;font-size:.88rem;font-weight:650;
  padding:.5rem .8rem;white-space:nowrap;border-radius:999px}
.site-nav a:hover{color:var(--ink);background:var(--indigo-soft)}
.site-nav a[aria-current=page]{color:var(--brand);background:var(--indigo-soft)}
@media(prefers-color-scheme:dark){.site-nav a[aria-current=page]{color:var(--ink)}}
.ad-disclosure{background:var(--card);border-bottom:1px solid var(--rule);margin:0;
  padding:.45rem max(1.5rem,calc((100% - var(--wrap)) / 2 + 1.5rem));
  font-size:.74rem;line-height:1.6;color:var(--ink-2)}

/* ── 見出し・文 ──────────────────────────────────────────── */
h1{font-weight:800;font-size:clamp(1.55rem,1.15rem + 1.5vw,2.25rem);line-height:1.35;
  letter-spacing:-.02em;margin:1.4rem 0 .7rem;text-wrap:balance}
h2{font-weight:800;font-size:clamp(1.2rem,1.05rem + .6vw,1.45rem);line-height:1.45;
  letter-spacing:-.015em;margin:0 0 .7rem;text-wrap:balance}
h3{font-weight:750;font-size:1.05rem;margin:1.6rem 0 .5rem}
.lead{font-size:1.02rem;line-height:1.9;max-width:46em;color:var(--ink-2)}
.lead strong{color:var(--ink)}
.note,.meta{color:var(--ink-2);font-size:.84rem;line-height:1.8;max-width:56em}
.note strong{color:var(--ink)}
.eyebrow{font-size:.76rem;font-weight:700;letter-spacing:.08em;color:var(--ink-3);margin:1.6rem 0 0;
  display:flex;align-items:center;gap:.45rem}
.stamp{font-size:.78rem;color:var(--ink-3);margin:.4rem 0 0}
.live{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--mint);
  box-shadow:0 0 0 0 rgba(21,163,122,.5)}
@media(prefers-reduced-motion:no-preference){.live{animation:pulse 2.4s ease-out infinite}}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(21,163,122,.55)}70%{box-shadow:0 0 0 8px rgba(21,163,122,0)}100%{box-shadow:0 0 0 0 rgba(21,163,122,0)}}

.block{margin-top:3.2rem}
.block-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.block-head h2{margin-bottom:.3rem}
.more{font-size:.86rem;font-weight:700;text-decoration:none;white-space:nowrap}
.more:hover{text-decoration:underline}
.count{font-size:.8rem;font-weight:700;color:var(--ink-3);margin-left:.3rem;letter-spacing:0}
.count span{color:var(--ink);font-variant-numeric:tabular-nums}

/* ── 冒頭（紺の帯）───────────────────────────────────────
   main の幅の外まで帯を伸ばす（box-shadow で左右に塗り広げ、clip-path で上下を切る） */
.hero{position:relative;background:var(--brand);color:#fff;
  box-shadow:0 0 0 100vmax var(--brand);clip-path:inset(0 -100vmax);
  padding:1.6rem 0 2.2rem;margin-bottom:1.6rem;
  background-image:radial-gradient(1200px 400px at 85% -20%,rgba(95,211,168,.18),transparent 60%)}
.hero .eyebrow{color:#b9c9e2;margin-top:.2rem}
.hero h1{color:#fff;font-size:clamp(1.75rem,1.1rem + 2.6vw,2.9rem);line-height:1.22;letter-spacing:-.035em;margin:.6rem 0 .7rem}
.hero .lead{color:#d5def0;font-size:.98rem;margin:0 0 1.4rem}
.hero .lead strong{color:#fff}

/* 条件の選択。ラジオボタンを「ひと押しで切り替わる札」に見せる */
.picker{background:var(--card);color:var(--ink);border-radius:var(--r);box-shadow:var(--sh-lg);
  padding:1rem 1.15rem;display:grid;grid-template-columns:repeat(4,auto);gap:.6rem 1.6rem;
  justify-content:start}
.seg{border:0;margin:0;padding:0;min-width:0}
.seg legend{font-size:.72rem;font-weight:800;letter-spacing:.08em;color:var(--ink-3);padding:0;margin-bottom:.35rem}
.seg-opts{display:flex;gap:.3rem;flex-wrap:wrap}
.seg label{position:relative;cursor:pointer}
.seg input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.seg label span{display:block;padding:.42rem .85rem;border-radius:999px;font-size:.88rem;font-weight:700;
  border:1px solid var(--rule-2);color:var(--ink-2);background:var(--card);white-space:nowrap;
  line-height:1.5}
.seg label:hover span{border-color:var(--indigo);color:var(--ink)}
.seg input:checked + span{background:var(--brand);border-color:var(--brand);color:#fff}
@media(prefers-color-scheme:dark){.seg input:checked + span{background:var(--indigo);border-color:var(--indigo);color:#08111f}}
.seg input:focus-visible + span{outline:3px solid var(--mint);outline-offset:2px}
.picker noscript{grid-column:1/-1}
/* 見出しは文節で折り返す（「3年使/うと」のような切れ方をさせない） */
.hero h1 span{display:inline-block}

/* カード・行は全体を押せるようにする（プラン名のリンクを面に広げる）。
   出典・広告のリンクはその上に重ねて、別々に押せるようにする */
.pick,.ranking tbody tr{position:relative}
.pick-plan::after,.ranking .plan-name::after{content:"";position:absolute;inset:0}
.ranking td.src a,.ranking td.cta,.pick-go{position:relative;z-index:1}
.ranking tbody tr{cursor:pointer}

/* トップの「その日の変化」要約 */
.digests{list-style:none;padding:0;margin:1rem 0 0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:.8rem}
.digest{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--sh);
  padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.35rem}
.digest p{margin:0}
.dg-head{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}
.dg-head a{font-weight:800;font-size:1rem;color:var(--ink);text-decoration:none}
.dg-head a:hover{color:var(--indigo);text-decoration:underline}
.dg-head span{font-size:.78rem;color:var(--ink-3);font-weight:700}
.dg-sum{font-size:.82rem;color:var(--ink-2);display:flex;gap:.3rem;align-items:center;flex-wrap:wrap}
.dg-sum .pill{margin-left:.1rem}
.digest ul{list-style:none;margin:.2rem 0 0;padding:0}
.digest li li{display:flex;flex-direction:column;padding:.45rem 0;border-top:1px solid var(--rule)}
.dg-name{font-size:.76rem;color:var(--ink-2);line-height:1.5}
.dg-v{font-size:.88rem;font-variant-numeric:tabular-nums}
.dg-rest{font-size:.76rem;color:var(--ink-3)}
.digest .more{margin-top:auto;padding-top:.4rem;font-size:.82rem}

/* ── 答え（会社ごとの最安3つ）────────────────────────────── */
.answer h2{font-size:clamp(1.15rem,1rem + .7vw,1.5rem)}
.cond{display:inline-block;color:var(--brand);background:var(--indigo-soft);border-radius:8px;
  padding:0 .45rem;margin-right:.3rem}
@media(prefers-color-scheme:dark){.cond{color:var(--ink)}}
.podium{list-style:none;margin:1rem 0 .8rem;padding:0;display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;counter-reset:none}
.pick{position:relative;background:var(--card);border:1px solid var(--rule);border-radius:var(--r);
  box-shadow:var(--sh);padding:1.15rem 1.2rem 1rem;display:flex;flex-direction:column;gap:.15rem}
.pick:first-child{border-color:var(--mint);box-shadow:0 0 0 1px var(--mint),var(--sh)}
.pick:first-child::before{content:"安い順 1位";position:absolute;top:-.7rem;left:1rem;
  background:var(--mint);color:#fff;font-size:.68rem;font-weight:800;letter-spacing:.06em;
  padding:.1rem .6rem;border-radius:999px}
@media(prefers-color-scheme:dark){.pick:first-child::before{color:#06281c}}
.pick-rank{position:absolute;top:1rem;right:1.1rem;font-size:.8rem;font-weight:800;color:var(--ink-3);
  font-variant-numeric:tabular-nums}
.pick-rank::after{content:"位"}
.pick:first-child .pick-rank{display:none}
.pick-prov{margin:0;font-weight:800;font-size:1.15rem;letter-spacing:-.01em}
.pick-plan{font-size:.82rem;color:var(--ink-2);text-decoration:none;line-height:1.55}
.pick-plan:hover{text-decoration:underline;color:var(--indigo)}
.pick .chips{margin:.3rem 0 0}
.pick-fig{margin-top:auto;padding-top:.7rem}
.pick-price{margin:0;display:flex;align-items:baseline;gap:.3rem}
.pick-price b{font-size:2.3rem;font-weight:800;letter-spacing:-.035em;line-height:1.1;
  font-variant-numeric:tabular-nums}
.pick:first-child .pick-price b{color:var(--down)}
.pick-price span{font-size:.82rem;color:var(--ink-3);font-weight:700}
.pick-total{margin:.1rem 0 0;font-size:.78rem;color:var(--ink-3);font-variant-numeric:tabular-nums}
.pick-src{margin:.35rem 0 0;font-size:.7rem;color:var(--ink-3);overflow-wrap:anywhere}
.pick-src a{position:relative;z-index:1;color:var(--ink-2)}
.pcard{position:relative}
.pcard .pname{color:var(--ink);text-decoration:none}
.pcard .pname::after{content:"";position:absolute;inset:0}
.psrc a{position:relative;z-index:1;color:var(--ink-2)}
.pick-range{margin:.5rem 0 0;font-size:.74rem;color:var(--ink-3);line-height:1.6}
.pick-range:empty{display:none}
.pick-go{margin-top:.7rem;font-size:.84rem;font-weight:700;text-decoration:none;
  border-top:1px solid var(--rule);padding-top:.65rem}
.pick-go:hover{text-decoration:underline}
.empty{background:var(--card);border:1px dashed var(--rule-2);border-radius:var(--r);padding:1.2rem;
  color:var(--ink-2)}
.scope{font-size:.8rem;color:var(--ink-3);margin:-.2rem 0 0;line-height:1.7}
.scope b{color:var(--ink);font-variant-numeric:tabular-nums}
.scope a{margin-left:.3rem}
.young-hint{font-size:.84rem;color:var(--ink-2);margin:.2rem 0 .6rem}

/* 小さな印 */
.chips{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.35rem}
.chip,.tag{display:inline-block;font-size:.68rem;font-weight:700;color:var(--ink-2);
  background:var(--paper);border:1px solid var(--rule);border-radius:999px;
  padding:.05rem .5rem;line-height:1.6;letter-spacing:.02em;white-space:nowrap}
.chip.warn{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-ink)}

/* ── 表 ─────────────────────────────────────────────────── */
.card{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
thead th{background:var(--card);font-size:.7rem;font-weight:800;letter-spacing:.08em;color:var(--ink-3);
  text-align:left;white-space:nowrap;padding:.8rem .8rem .55rem;border-bottom:1px solid var(--rule-2)}
td{padding:.9rem .8rem;border-bottom:1px solid var(--rule);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody th{text-align:left;font-weight:650;padding:.9rem .8rem;border-bottom:1px solid var(--rule)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.strong{font-weight:800;font-size:1.3rem;letter-spacing:-.03em;line-height:1.3}
.total{color:var(--ink-2);font-size:.86rem}
.plan-name{font-weight:650;font-size:.93rem;line-height:1.55;text-decoration:none;color:var(--ink)}
.plan-name:hover{color:var(--indigo);text-decoration:underline}
.src{font-size:.72rem;color:var(--ink-3);line-height:1.6}
.src a{color:var(--ink-2)}
.src time{display:block}
/* スマホ料金（/mobile/） */
.mtable{min-width:560px}
.mtable.mall{min-width:860px}
.mtable th[scope=row]{white-space:nowrap;font-weight:800;color:var(--ink);background:var(--card)}
.m-cap{caption-side:top;text-align:left;font-size:.78rem;color:var(--ink-3);padding:.6rem .8rem 0}
.m-cell .m-eff{font-size:1.15rem;font-variant-numeric:tabular-nums;color:var(--ink)}
.m-cell .m-per{font-size:.75rem;color:var(--ink-3);margin-left:.1rem}
.m-cell .m-plan{display:block;font-size:.8rem;color:var(--ink-2);margin-top:.2rem}
.m-cell .src{display:block;margin-top:.3rem}
.m-none{font-size:.78rem;color:var(--ink-3)}
tr.total th,tr.total td{border-top:1px solid var(--rule-2);background:var(--paper)}

.ranking{min-width:900px}
.ranking tbody tr{transition:background .12s ease}
.ranking tbody tr:hover{background:var(--indigo-soft)}
.ranking td.rank,.ranking th.rank{width:3.4rem;text-align:center}
.ranking td.rank{font-weight:800;color:var(--ink-3);font-variant-numeric:tabular-nums;padding-top:1.05rem}
.ranking tr.top td.rank{color:var(--brand)}
@media(prefers-color-scheme:dark){.ranking tr.top td.rank{color:var(--indigo)}}
.ranking tr.top{box-shadow:inset 3px 0 0 var(--mint)}
.ranking td.prov{white-space:nowrap;font-weight:700}
.ranking td.trend{width:7.5rem}
.ranking td.src{width:10rem}
.cta{white-space:nowrap}
.plans .num.strong{width:8.5rem}
.group-h{font-size:.85rem;letter-spacing:.06em;color:var(--ink-3);margin:1.4rem 0 .5rem}

/* ── 折りたたみ ─────────────────────────────────────────── */
.fold{margin-top:2.6rem;border:1px solid var(--rule);border-radius:var(--r);background:var(--card)}
.fold>summary{cursor:pointer;padding:.95rem 1.2rem;font-weight:750;font-size:.9rem;color:var(--ink);list-style:none;
  display:flex;align-items:center;gap:.6rem}
.fold>summary::-webkit-details-marker{display:none}
.fold>summary::before{content:"";width:.55rem;height:.55rem;border-right:2px solid var(--ink-3);
  border-bottom:2px solid var(--ink-3);transform:rotate(-45deg);transition:transform .15s ease;flex:none}
.fold[open]>summary::before{transform:rotate(45deg)}
.fold-note{margin-top:.8rem;border-radius:var(--r-s)}
.fold-note>summary{font-size:.84rem;color:var(--ink-2);padding:.7rem 1rem}
.fold-note .note{padding:0 1rem}
.fold .legend{padding:0 1.2rem 1.2rem}
.legend-h{font-size:.76rem;letter-spacing:.1em;color:var(--ink-3);font-weight:800;margin:1.4rem 0 .6rem}
.legend dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:.6rem;margin:0}
.legend div{padding:.9rem 1rem;border:1px solid var(--rule);border-radius:var(--r-s);background:var(--paper)}
.legend dt{font-weight:800;font-size:.9rem;color:var(--ink);margin-bottom:.2rem}
.legend dd{margin:0;font-size:.82rem;line-height:1.8;color:var(--ink-2)}

/* ── 料金の変化（カードの流れ）────────────────────────────── */
.feed{list-style:none;padding:0;margin:1rem 0 0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:.8rem}
.ev{background:var(--card);border:1px solid var(--rule);border-radius:var(--r-s);
  padding:.9rem 1rem .8rem 1.15rem;position:relative;box-shadow:var(--sh)}
.ev::before{content:"";position:absolute;left:0;top:.8rem;bottom:.8rem;width:3px;border-radius:0 3px 3px 0;background:var(--rule-2)}
.ev.down::before{background:var(--down)}
.ev.up::before{background:var(--up)}
.ev p{margin:0}
.ev-head{display:flex;gap:.6rem;align-items:baseline;font-size:.75rem;color:var(--ink-3)}
.ev-prov{font-weight:800;color:var(--ink);font-size:.86rem}
.ev-plan{font-size:.82rem;line-height:1.55;margin-top:.15rem!important}
.ev-plan a{color:var(--ink-2);text-decoration:none}
.ev-plan a:hover{color:var(--indigo);text-decoration:underline}
.ev-delta{font-weight:700;font-size:.95rem;margin-top:.45rem!important;font-variant-numeric:tabular-nums}
.ev-delta b{font-size:1.1rem}
.pill{display:inline-block;font-size:.74rem;font-weight:800;padding:.02rem .5rem;margin-left:.35rem;
  border-radius:999px;font-style:normal;vertical-align:.1em;font-variant-numeric:tabular-nums}
.pill.down{background:var(--down-soft);color:var(--down)}
.pill.up{background:var(--up-soft);color:var(--up)}
.ev-cause{font-size:.74rem;color:var(--ink-2);margin-top:.3rem!important;line-height:1.6;font-variant-numeric:tabular-nums}
.ev-when{font-size:.7rem;color:var(--ink-3);margin-top:.25rem!important}
.ev-links{display:flex;gap:1rem;font-size:.74rem;margin-top:.45rem!important}
.day{margin-top:2.4rem}
.day h2 a{color:var(--ink);text-decoration:none}
.day h2 a:hover{color:var(--indigo);text-decoration:underline}
.day h2 small{display:block;font-size:.78rem;font-weight:600;color:var(--ink-3);letter-spacing:0;margin-top:.15rem}
.pager{display:flex;justify-content:space-between;gap:1rem;margin-top:2.4rem;font-size:.88rem;font-weight:700}

/* ── サービスのカード ───────────────────────────────────── */
.pcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));gap:.8rem;margin-top:1rem}
.pcard{display:flex;flex-direction:column;gap:.3rem;padding:1.15rem 1.2rem;text-decoration:none;color:var(--ink);
  background:var(--card);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--sh);
  transition:transform .12s ease,box-shadow .12s ease}
.pcard:hover{transform:translateY(-2px);box-shadow:var(--sh-lg)}
.pcard.is-paused{background:var(--paper);box-shadow:none}
.pname{font-size:1.08rem;font-weight:800;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.pmin{display:flex;align-items:baseline;gap:.35rem;flex-wrap:wrap}
.pmin b{font-size:1.75rem;font-weight:800;letter-spacing:-.03em;line-height:1.15;font-variant-numeric:tabular-nums}
.pmin small{font-size:.72rem;color:var(--ink-3);font-weight:700}
.pmin small:first-child{flex-basis:100%}
.pcard.is-paused .pmin b{color:var(--ink-3)}
.pmeta{font-size:.74rem;color:var(--ink-3);margin-top:.4rem;padding-top:.6rem;border-top:1px solid var(--rule)}
.pmeta span{display:block}

/* ── 記録が止まっているもの・注意 ─────────────────────────── */
.paused{margin-top:3rem;background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:var(--r);padding:1.2rem 1.3rem}
.paused h2{font-size:1.1rem;color:var(--warn-ink)}
.paused ul{list-style:none;margin:.6rem 0 0;padding:0}
.paused li{padding:.8rem 0;border-top:1px solid var(--warn-line)}
.paused li p{margin:.15rem 0;font-size:.88rem}
.paused-name{display:flex;gap:.5rem;align-items:center;font-weight:800}
.stale-note,.banner.warn{display:block;background:var(--warn-bg);border:1px solid var(--warn-line);
  border-left-width:4px;border-radius:var(--r-s);color:var(--warn-ink);padding:.9rem 1.1rem;margin:1rem 0;
  font-size:.88rem;line-height:1.8}
.stale-note strong{display:block;color:var(--warn-ink)}

/* ── 広告の独立ブロック（別条件）────────────────────────────
   ★表の行と見分けがつくように、形も位置も分ける。「広告」の札を先頭に置く */
.link-only{background:var(--card);border:1px solid var(--rule-2);border-radius:var(--r);
  padding:1.1rem 1.3rem;margin:2.4rem 0;box-shadow:var(--sh)}
.link-only-kicker{display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:.95rem;margin:0 0 .4rem}
.link-only p{font-size:.86rem;margin:.4rem 0}
.link-only ul{list-style:none;padding:0;margin:.6rem 0}
.link-only li{padding:.9rem 1rem;border:1px solid var(--rule);border-radius:var(--r-s);background:var(--paper)}
.link-only-name{font-weight:800;font-size:.98rem}
.link-only-ad{font-size:.98rem;font-weight:700}
.ad-unit{display:inline-block}

/* ── この数字の作り方 ───────────────────────────────────── */
.record{margin-top:3.6rem;background:var(--card);border:1px solid var(--rule);border-radius:var(--r);
  padding:1.6rem 1.6rem 1.2rem;box-shadow:var(--sh)}
.record-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8rem;margin:1rem 0 1.2rem}
.stat{border-left:3px solid var(--mint);padding:.1rem 0 .1rem .8rem}
.stat b{display:block;font-size:1.7rem;font-weight:800;letter-spacing:-.02em;line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:.74rem;color:var(--ink-3)}
.promises{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:.4rem 1.6rem}
.promises li{position:relative;padding-left:1.5rem;font-size:.86rem;color:var(--ink-2);line-height:1.75}
.promises li::before{content:"";position:absolute;left:.1rem;top:.45em;width:.8rem;height:.45rem;
  border-left:2px solid var(--mint);border-bottom:2px solid var(--mint);transform:rotate(-45deg)}
.promises strong{color:var(--ink)}

/* ── 下層ページ ─────────────────────────────────────────── */
.page-head{padding-bottom:.4rem}
.crumbs{font-size:.76rem;color:var(--ink-3);margin:1.4rem 0 0}
.crumbs a{color:var(--ink-2);text-decoration:none}
.crumbs a:hover{color:var(--indigo);text-decoration:underline}
.crumbs .sep{margin:0 .4rem;color:var(--rule-2)}
.plan-head h1{margin-top:.3rem}
.headline{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.6rem 2rem;margin:1rem 0 .3rem;
  background:var(--card);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--sh);padding:1.1rem 1.3rem}
.headline-fig{margin:0}
.headline-fig span{display:block;font-size:.78rem;color:var(--ink-3);font-weight:700}
.headline-fig b{font-size:clamp(2.4rem,1.8rem + 2vw,3.2rem);font-weight:800;letter-spacing:-.04em;line-height:1.05;
  font-variant-numeric:tabular-nums}
.headline-rank{margin:0 0 .35rem;font-size:.88rem;color:var(--ink-2)}
.headline-rank b{color:var(--ink)}
.big{font-size:2.1rem;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink)}

/* 内訳の棒 */
.bars{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);box-shadow:var(--sh);padding:1.2rem 1.3rem}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;background:var(--paper);gap:2px}
.bar span{display:block;height:100%}
.bar-minus{margin-top:.4rem;height:14px;background:transparent}
.seg-c1{background:#1f55b8}.seg-c2{background:#6f93d6}.seg-c3{background:#a9bfe6}.seg-c4{background:#c9b27a}
.seg-m1{background:#15a37a}.seg-m2{background:#7fd0b4}
@media(prefers-color-scheme:dark){.seg-c1{background:#6ea2ff}.seg-c2{background:#4f78c2}.seg-c3{background:#33507f}}
.keys{list-style:none;margin:1rem 0 0;padding:0;display:grid;gap:.35rem}
.keys li{display:grid;grid-template-columns:.8rem 1fr auto;gap:.6rem;align-items:center;font-size:.88rem}
.keys .key{display:block;width:.8rem;height:.8rem;border-radius:3px}
.keys b{font-variant-numeric:tabular-nums;font-weight:700}
.bar-total{display:flex;flex-wrap:wrap;align-items:baseline;gap:.3rem .6rem;margin:1rem 0 0;padding-top:.8rem;
  border-top:1px solid var(--rule);font-size:.88rem;color:var(--ink-2)}
.bar-total b{color:var(--ink);font-variant-numeric:tabular-nums}
.bar-total .hl{font-size:1.15rem}

/* 毎月の料金の帯 */
.band{display:flex;align-items:flex-end;gap:3px;height:150px;background:var(--card);border:1px solid var(--rule);
  border-radius:var(--r);box-shadow:var(--sh);padding:1rem 1rem .6rem}
.band-seg{position:relative;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:3.6rem}
.band-bar{display:block;background:linear-gradient(180deg,var(--indigo),#5e86d0);border-radius:5px 5px 2px 2px;opacity:.85}
.band-amt{font-size:.8rem;font-weight:800;font-variant-numeric:tabular-nums;margin-top:.3rem;white-space:nowrap}
.band-when{font-size:.68rem;color:var(--ink-3);white-space:nowrap}

/* 公式のお知らせ・出典 */
.notices{list-style:none;padding:0;margin:.8rem 0}
.notices li{display:grid;grid-template-columns:6.5rem 1fr;gap:.2rem .8rem;padding:.55rem 0;border-bottom:1px solid var(--rule);font-size:.86rem}
.notices time{color:var(--ink-3);font-variant-numeric:tabular-nums}
.notices .chips{grid-column:2}
.sources{font-size:.82rem;word-break:break-all}
.page-foot{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule)}

/* 文書系 */
.faq dt{font-weight:800;font-size:1rem;margin-top:1.6rem}
.faq dd{margin:.3rem 0 0;color:var(--ink-2)}
.review{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);padding:1.3rem 1.5rem;margin-top:3rem}
.review-list{font-size:.85rem}
.formula{background:var(--card);border:1px solid var(--rule);border-radius:var(--r-s);padding:1rem 1.2rem;
  overflow-x:auto;font-size:.83rem;white-space:pre-wrap;font-family:var(--mono);line-height:1.9}
blockquote{margin:1.2rem 0;padding:.9rem 1.3rem;background:var(--card);border-left:3px solid var(--indigo);
  border-radius:0 var(--r-s) var(--r-s) 0;font-size:.9rem;color:var(--ink-2)}
code{background:var(--indigo-soft);padding:.08rem .35rem;border-radius:4px;font-size:.87em;font-family:var(--mono)}
.btn{display:inline-block;padding:.55rem 1.2rem;background:var(--brand);color:#fff;border-radius:999px;
  text-decoration:none;font-size:.86rem;font-weight:700}
.btn:hover{background:var(--brand-2)}
main>h1:first-child,main>.crumbs+h1{margin-top:1.6rem}

/* ── 奥付 ──────────────────────────────────────────────── */
.site-foot{background:var(--indigo-deep);color:#b8c6da;margin-top:2rem}
.foot-in{max-width:var(--wrap);margin:0 auto;padding:2.6rem 1.5rem 3rem;
  display:grid;grid-template-columns:1.6fr repeat(3,1fr);gap:1.6rem 2rem;font-size:.84rem;line-height:1.85}
.foot-in p{margin:0}
.foot-brand p+p{margin-top:.5rem}
.foot-name{display:flex;align-items:center;gap:.55rem;color:#fff;font-weight:800;font-size:1rem}
.foot-name svg{width:28px;height:28px}
.foot-stamp{color:#8ea2bf;font-size:.78rem}
.foot-nav{display:flex;flex-direction:column;gap:.2rem}
.foot-h{color:#fff;font-weight:800;font-size:.76rem;letter-spacing:.1em;margin-bottom:.2rem!important}
.site-foot a{color:#dbe6f5;text-decoration:none}
.site-foot a:hover{text-decoration:underline}
.disclaimer{grid-column:1/-1;border-top:1px solid rgba(255,255,255,.14);padding-top:1.2rem;font-size:.78rem;color:#9fb0c9}
.disclaimer strong{color:#fff}

/* ── 画面が狭いとき ─────────────────────────────────────── */
@media(max-width:900px){
  .picker{grid-template-columns:repeat(2,minmax(0,1fr))}
  .podium{grid-template-columns:1fr}
  .pick{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:1rem;align-items:start}
  .pick-body{grid-column:1}
  .pick-fig{grid-column:2;grid-row:1/span 2;padding-top:1.3rem;text-align:right}
  .pick-price{justify-content:flex-end}
  .pick-range,.pick-go,.pick-src{grid-column:1/-1}
  .pick-rank{position:static;font-size:.75rem;order:-1}
  .record-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .foot-in{grid-template-columns:1fr 1fr}
  .foot-brand{grid-column:1/-1}
}
@media(max-width:640px){
  body{font-size:15px}
  main{padding:0 1rem 4rem}
  .head-in{padding:.5rem 1rem;gap:.6rem;flex-wrap:wrap}
  .brand small{display:none}
  .site-nav{margin:0 -1rem;padding:0 .5rem .1rem;width:calc(100% + 2rem);overflow-x:auto;scrollbar-width:none}
  .site-nav::-webkit-scrollbar{display:none}
  .site-nav a{font-size:.84rem;padding:.4rem .7rem}
  .site-head{position:static}
  .ad-disclosure{padding:.5rem 1rem}
  .hero{padding:1rem 0 1.5rem}
  .hero .lead{font-size:.9rem;margin-bottom:1rem}
  .picker{grid-template-columns:1fr;padding:.8rem .85rem;gap:.55rem}
  .seg{display:grid;grid-template-columns:4.2rem minmax(0,1fr);align-items:center}
  .seg legend{float:left;margin:0;padding-top:.15rem}
  .seg-opts{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-right:-.85rem;padding-right:.85rem}
  .seg-opts::-webkit-scrollbar{display:none}
  .seg label span{padding:.36rem .75rem;font-size:.84rem}
  .pick{padding:.85rem .95rem .8rem}
  .pick:first-child{margin-top:.5rem}
  .pick:first-child .pick-rank{display:none}
  .pick-prov{font-size:1.05rem}
  .pick-fig{padding-top:1rem}
  .pick-price b{font-size:1.75rem}
  .pick-range{margin-top:.3rem}
  .pick-go{display:none}
  .podium{gap:.7rem}
  .pcards{grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem}
  .pcard{padding:.85rem .9rem}
  .pname{font-size:.95rem}
  .pmin b{font-size:1.4rem}
  .pmeta{font-size:.7rem}
  .block{margin-top:2.6rem}

  /* 比較表は横スクロールさせず、1プラン＝1枚に組み替える */
  .table-wrap{overflow:visible}
  .ranking,.plans{min-width:0}
  .ranking thead,.plans thead{display:none}
  .ranking,.ranking tbody,.plans,.plans tbody{display:block}
  .ranking tbody tr{display:grid;grid-template-columns:1.7rem minmax(0,1fr) auto;column-gap:.6rem;
    padding:.85rem .9rem;border-bottom:1px solid var(--rule)}
  .ranking tbody tr:last-child{border-bottom:0}
  .ranking tbody td{display:block;padding:0;border:0}
  .ranking td.rank{grid-column:1;grid-row:1/span 2;padding-top:.1rem;text-align:left;width:auto}
  .ranking td.prov{grid-column:2;grid-row:1;font-size:.84rem}
  .ranking td.num.strong{grid-column:3;grid-row:1/span 2;align-self:center;font-size:1.25rem}
  .ranking td.plan{grid-column:2;grid-row:2}
  .ranking td.total,.ranking td.trend{display:none}
  .ranking td.src{grid-column:2/4;grid-row:3;margin-top:.35rem;width:auto}
  .ranking td.src time{display:inline;margin-left:.5rem}
  .ranking td.cta{grid-column:2/4;margin-top:.4rem}
  .plans tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:.6rem;padding:.8rem .9rem;border-bottom:1px solid var(--rule)}
  .plans tbody td{display:block;padding:0;border:0;width:auto}
  .plans td.num.strong{grid-column:2;grid-row:1/span 2;font-size:1.15rem;align-self:center;width:auto}
  .plans td:nth-child(2){grid-column:1;grid-row:1}
  .plans td.total{grid-column:1;grid-row:2;text-align:left;font-size:.76rem}
  .plans td.src{display:none}
  .record{padding:1.2rem 1.1rem}
  .headline{padding:1rem}
  .band{height:130px;padding:.8rem .6rem .5rem;overflow-x:auto}
  .notices li{grid-template-columns:1fr}
  .notices .chips{grid-column:1}
  .foot-in{grid-template-columns:1fr;padding:2rem 1rem 2.4rem}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{
  .site-head,.picker,.site-foot,.link-only{display:none}
  .hero{background:none;color:#000;box-shadow:none;clip-path:none}
  .hero h1,.hero .lead{color:#000}
  body{background:#fff}
  .ranking tr[hidden]{display:none}
}
${CHART_CSS}
`;

// CSS本文のハッシュ。中身が変わったときだけ変わる＝変わらない限りキャッシュは効いたまま。
// ★STYLE の定義より後に置くこと（const は巻き上げても初期化前は参照できない）。
export const cssVer = createHash('sha1').update(STYLE).digest('hex').slice(0, 8);
export const jsVer = createHash('sha1').update(APP_JS).digest('hex').slice(0, 8);

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
