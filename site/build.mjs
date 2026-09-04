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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, layout, jsonLd, e } from './lib/html.mjs';
import { yen, yenSigned, jstDateTime, jstDate, isoDate, daysSince, host, planName } from './lib/format.mjs';
import { planSlugsFor, reconstructSeries } from './lib/series.mjs';
import { stepChart, CHART_CSS } from './lib/chart.mjs';
import { staleInfo } from './lib/stale.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(HERE, 'dist');

export const SITE_URL = 'https://tsushinhi-index.com';
const SITE_NAME = '通信費インデックス';

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
  await page('index.html', renderIndex(data), disclosure);
  await page('changes/index.html', renderChanges(data), disclosure);
  await page('method/index.html', renderMethod(data), disclosure);
  await page('data/index.html', renderData(data), disclosure);
  await page('about/index.html', renderAbout(data), disclosure);
  await page('privacy/index.html', renderPrivacy(data), disclosure);
  await page('contact/index.html', renderContact(data), disclosure);

  // 事業者ページとプランページ。掲載可のものだけ（要確認の値をURLで指せるようにしない）
  for (const id of providerIds(data)) {
    await page(`p/${id}/index.html`, renderProvider(data, id), disclosure);
  }
  for (const o of data.publishable) {
    await page(`p/${o.providerId}/${o.slug}/index.html`, renderPlan(data, o), disclosure);
  }
  console.log(`  事業者ページ ${providerIds(data).length}件 / プランページ ${data.publishable.length}件`);

  await out('style.css', STYLE);
  await out('favicon.svg', FAVICON);
  await out('llms.txt', renderLlmsTxt(data));
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
  return { ...o, emailUsable, email: emailUsable ? o.email : null };
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
        path: `/p/${snap.providerId}/${slug}/`,
      });
    }
  }

  // 掲載できるのは「検算を通り、記載の食い違いが無く、実質月額が出ているもの」だけ
  const publishable = offers.filter((o) => o.publishable && o.effectiveMonthly != null);
  const needsReview = offers.filter((o) => !(o.publishable && o.effectiveMonthly != null));

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
    effective, offers, publishable, needsReview, events, failures, health, updatedAt,
    ads: await loadAds(),
    owner: await loadOwner(),
    operators,
    // ★「3社」と書かない。NURO光とSo-net光は同じ会社なので、サービス数と会社数は違う。
    serviceCount: new Set(publishable.map((o) => o.providerId)).size,
    operatorCount: new Set(publishable.map((o) => operators[o.providerId]?.name).filter(Boolean)).size,
  };
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

function renderIndex(data) {
  const buildings = ['戸建て', 'マンション'];
  const recent = data.events.slice(0, 8);

  const body = html`
<section class="hero">
  <h1>光回線の実質月額インデックス</h1>
  <p class="lead">
    各社が公表している料金・工事費・割引・キャッシュバックを毎日自動で収集し、
    <strong>全社を同一の計算式に通した「実質月額」</strong>として${HORIZON}か月で均した値です。
    計算式は<a href="/method/">すべて公開</a>しています。
  </p>
  <p class="meta">
    ${data.publishable.length}件の観測 ／ ${data.serviceCount}サービス（運営${data.operatorCount}社） ／
    最終取得 ${jstDateTime(data.updatedAt)}
  </p>
  ${raw(operatorNote(data))}
</section>

${raw(staleBanner(data))}

${raw(buildings.map((b) => rankingSection(data, b)).join(''))}

${raw(linkOnlyOffers(data))}

<section>
  <h2>最近の変化</h2>
  ${raw(recent.length
    ? `<ul class="changes">${recent.map(changeItem).join('')}</ul>
       <p><a href="/changes/">変化の履歴をすべて見る</a></p>`
    : '<p>まだ変化を検知していません。収集は毎日走っています。</p>')}
</section>

${raw(needsReviewSection(data))}
`;

  return {
    title: `光回線の実質月額インデックス｜${SITE_NAME}`,
    description: `光回線${data.serviceCount}サービス（運営${data.operatorCount}社）の料金・工事費・割引・キャッシュバックを毎日自動収集し、同一の計算式で${HORIZON}か月の実質月額に換算して比較しています。計算式と出典を全公開。`,
    canonical: `${SITE_URL}/`,
    head: [
      jsonLd(datasetLd(data)).value,
      jsonLd(itemListLd(data)).value,
    ].join('\n'),
    body,
    updatedAt: data.updatedAt,
  };
}

function rankingSection(data, building) {
  // 「共通」は戸建て・マンションのどちらにも当てはまるので両方に出す
  const rows = data.publishable
    .filter((o) => o.entry === '新規')
    .filter((o) => o.building === building || o.building === '共通')
    .sort((a, b) => a.effectiveMonthly - b.effectiveMonthly);

  if (!rows.length) return '';

  // 申込列を出すのは「飛び先の条件＝出典の条件」のリンクがあるときだけ。
  // 条件が違うリンクは行に混ぜない（数字と食い違うため）。別ブロックに出す。
  const ads = data.ads.same.size > 0;

  return html`
<section>
  <h2>${building}：実質月額の安い順（新規申込・${HORIZON}か月換算）</h2>
  <div class="table-wrap">
  <table>
    <thead>
      <tr><th>実質月額</th><th>事業者</th><th>プラン</th><th>内訳</th><th>出典・取得日時</th>${raw(ads ? '<th>申込</th>' : '')}</tr>
    </thead>
    <tbody>
      ${raw(rows.map((o) => rankRow(o, data)).join(''))}
    </tbody>
  </table>
  </div>
  <p class="note">
    ${HORIZON}か月換算です。契約期間は各社ばらばら（NURO光は縛りなし）なので、揃えないと比較になりません。
    数え方の統一規則は<a href="/method/">計算方法</a>に書いています。
  </p>
  <p class="note">
    <strong>順位は実質月額の安い順で、それ以外の基準は入れていません。</strong>
    速度（1ギガ／2ギガ／10ギガ）が異なるプランも同じ表に並べているので、速度は各行で確かめてください。
    条件に合う観測は<strong>1件も除外していません</strong>（検算に通らなかったものはページ下部に理由つきで出しています）。
  </p>
</section>
`;
}

function rankRow(o, data) {
  const ad = data.ads.same.get(o.providerId);
  const b = o.breakdown;
  const notes = [];
  if (o.setBenefits?.length) notes.push('セット特典は不算入');
  if (o.plan?.work) notes.push(o.plan.work);
  if (o.stale) notes.push(`更新停止中（${o.stale.days}日）`);

  return html`
<tr${raw(o.stale ? ' class="stale"' : '')}>
  <td class="num strong">${yen(o.effectiveMonthly)}</td>
  <td>${o.providerName}</td>
  <td><a href="${o.path}">${planName(o)}</a>${raw(notes.length ? `<br><span class="tag">${notes.map(e).join(' / ')}</span>` : '')}</td>
  <td class="breakdown">
    ${raw(b ? `月額計 ${e(yen(b.monthlyTotal))}<br>事務手数料 ${e(yen(b.adminFee))}<br>工事費実負担 ${e(yen(b.constructionBorne))}<br>CB −${e(yen(b.cashbackCounted))}` : '—')}
  </td>
  <td class="src">
    <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a><br>
    <time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time>
  </td>
  ${raw(data.ads.same.size > 0 ? adCell(ad) : '')}
</tr>
`;
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
 */
function linkOnlyOffers(data) {
  const list = data.ads.different;
  if (!list.length) return '';

  return html`
<section class="link-only">
  <h2>このサイト経由の申込にだけ適用される特典</h2>
  <p>
    上の比較表は<strong>誰でも見られる公式の料金ページ</strong>を毎日計測した値です。
    下記は<strong>申込経路によって条件が変わるもの</strong>で、
    <strong>上の実質月額には含まれていません。</strong>
    金額や条件は変わるので、<strong>必ず申込先のページで確認してください。</strong>
  </p>
  <ul>
    ${raw(list.map((a) => html`<li>
      <strong>${providerNameOf(data, a.providerId) ?? a.providerId}</strong><br>
      ${a.differenceNote}<br>
      ${raw(adUnit(a))}
      <span class="tag">条件を確認した日: ${a.confirmedAt}</span>
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

function staleBanner(data) {
  const stale = data.publishable.filter((o) => o.stale && o.stale.days >= STALE_DAYS);
  if (!stale.length) return '';
  const names = [...new Set(stale.map((o) => o.providerName))];
  return html`
<aside class="banner warn">
  <strong>更新停止中：${names.join('、')}</strong>
  収集元のページを${STALE_DAYS}日以上取得できていません。表示している値は取得できた最後の時点のものです。
  各社の公式サイトで最新の条件をご確認ください。
</aside>
`;
}

// ── 変化のページ ─────────────────────────────────────────────────

function renderChanges(data) {
  const body = html`
<h1>料金の変化</h1>
<p class="lead">
  実質月額が動いたものだけを載せています。<strong>「キャッシュバックが5,000円増えた」ではなく「実質月額が139円下がった」</strong>に
  翻訳しないと、読者にとっての意味が分からないためです。
</p>
${raw(data.events.length
  ? `<ul class="changes">${data.events.map(changeItem).join('')}</ul>`
  : '<p>まだ変化を検知していません。</p>')}
`;
  return {
    title: `料金の変化｜${SITE_NAME}`,
    description: '光回線各社の実質月額が動いた履歴です。いつ・何が・いくら変わったかを、実質月額への影響として記録しています。',
    canonical: `${SITE_URL}/changes/`,
    body,
    updatedAt: data.updatedAt,
  };
}

function changeItem(c) {
  if (c.type !== 'effective-monthly-changed') {
    return html`<li><time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time>
      <strong>${c.providerName}</strong> ${planName(c)} — ${c.type === 'plan-added' ? 'プランが追加されました' : 'プランが見当たらなくなりました'}</li>`;
  }
  const dir = c.effectiveMonthlyDelta < 0 ? 'down' : 'up';
  const cause = (c.cause ?? []).map((x) => `${x.label} ${yen(x.before)}→${yen(x.after)}`).join(' / ');
  return html`
<li class="${dir}">
  <time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time>
  <strong>${c.providerName}</strong> ${planName(c)}
  <span class="delta">実質月額 ${yen(c.before)} → ${yen(c.after)}（${yenSigned(c.effectiveMonthlyDelta)}）</span>
  ${raw(cause ? `<span class="cause">${e(cause)}</span>` : '')}
  ${raw(c.sourceUrl ? `<a class="src" href="${e(c.sourceUrl)}" rel="nofollow noopener">出典</a>` : '')}
</li>
`;
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
<div class="table-wrap">
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
</div>

<h2>数字を検算しています</h2>
<p>
  各社の料金ページには、内訳（月額基本料金・工事費・割引）と、その適用後の月額の<strong>両方</strong>が載っています。
  内訳から月額を計算し、<strong>ページが公開している月額と一致するかを毎回突き合わせています。</strong>
  一致しないものは掲載しません。<strong>読み方を間違えたまま「値上げしました」と発信しないためです。</strong>
</p>
<p>
  ただし検算の手段は事業者によって異なります。<strong>弱い検算しかできない事業者を、強い検算ができたかのように扱いません。</strong>
</p>
<div class="table-wrap">
<table>
  <thead><tr><th>事業者</th><th>検算の方法</th></tr></thead>
  <tbody>${raw(verificationRows(data))}</tbody>
</table>
</div>

<h2>壊れたときにどうなるか</h2>
<p>
  自動収集の最悪の失敗は「静かに壊れること」です。収集元が変わっても気づかず古い値を出し続けるのが一番まずい状態です。
</p>
<ul>
  <li>取得に失敗したとき、<strong>前回の値を書き戻すことはしません</strong></li>
  <li>設定されたページを1つでも取得できなかった事業者は、<strong>差分を取らず、記録も更新しません</strong>（「取得できなかった」を「無くなった」と誤解釈しないため）</li>
  <li>${STALE_DAYS}日以上更新できていない場合は、このサイトに<strong>「更新停止中」と明示します</strong></li>
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
  <li><code>data/notices/</code> — 各社公式のお知らせ（料金改定の正式な適用日）</li>
  <li><a href="/feed.xml">RSS フィード</a> — 変化の通知</li>
</ul>

<h2>出典の書き方</h2>
<blockquote>
  出典: 通信費インデックス（tsushinhi-index）${SITE_URL} — CC BY 4.0
</blockquote>

<h2>収録している事業者</h2>
<div class="table-wrap">
<table>
  <thead><tr><th>事業者</th><th>観測数</th><th>最終取得</th><th>出典</th></tr></thead>
  <tbody>${raw(data.effective.map((s) => html`
    <tr>
      <td>${s.providerName}</td>
      <td class="num">${s.offers.length}</td>
      <td><time datetime="${s.observedAt}">${jstDateTime(s.observedAt)}</time></td>
      <td class="src">${raw(s.sourceUrls.map((u) => `<a href="${e(u)}" rel="nofollow noopener">${e(host(u))}</a>`).join('<br>'))}</td>
    </tr>`).join(''))}
  </tbody>
</table>
</div>

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

function renderProvider(data, providerId) {
  const mine = data.publishable.filter((o) => o.providerId === providerId)
    .sort((a, b) => a.effectiveMonthly - b.effectiveMonthly);
  const first = mine[0];
  const op = data.operators[providerId];
  const evs = data.events.filter((c) => c.providerId === providerId);
  const sources = [...new Set(mine.map((o) => o.sourceUrl))];

  const staleHere = mine.filter((o) => o.stale);
  const body = html`
<h1>${first.providerName}の実質月額</h1>
${raw(staleHere.length ? html`
<p class="stale-note">
  <strong>この事業者は${staleHere[0].stale.days}日前から更新できていません</strong>（${mine.length}件中${staleHere.length}件）。
  ${jstDate(staleHere[0].stale.since)}以降、収集または算出に失敗し続けています。
  <strong>下の値は現在の条件とは違う可能性があります。</strong>
</p>` : '')}
<p class="lead">
  ${first.providerName}の料金ページを毎日1回自動で読み、
  <strong>${HORIZON}か月使ったときの実質月額</strong>に直しています。現在<strong>${mine.length}件</strong>を掲載中です。
  ${raw(op?.name ? html`運営会社は<strong>${op.name}</strong>。` : '')}
</p>

<h2>掲載中のプラン</h2>
<div class="table-wrap">
<table>
  <thead><tr><th>実質月額</th><th>プラン</th><th>内訳</th><th>取得</th></tr></thead>
  <tbody>${raw(mine.map((o) => html`
    <tr>
      <td class="num strong">${yen(o.effectiveMonthly)}</td>
      <td><a href="${o.path}">${planName(o)}</a></td>
      <td class="breakdown">${raw(o.breakdown
        ? `月額計 ${e(yen(o.breakdown.monthlyTotal))}<br>工事費実負担 ${e(yen(o.breakdown.constructionBorne))}<br>CB −${e(yen(o.breakdown.cashbackCounted))}`
        : '—')}</td>
      <td class="src"><time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time></td>
    </tr>`).join(''))}
  </tbody>
</table>
</div>

<h2>この事業者で検知した変化</h2>
${raw(evs.length ? html`
<ul class="events">${raw(evs.slice(0, 30).map((c) => html`
  <li>
    <time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time>
    <strong>${planName(c)}</strong>
    ${raw(c.type === 'effective-monthly-changed'
      ? html`実質月額 ${yen(c.before)} → <strong>${yen(c.after)}</strong>（${yenSigned(c.effectiveMonthlyDelta)}）`
      : html`${c.type}`)}
    ${raw((c.cause ?? []).map((x) => `<br><span class="tag">${e(x.label)}: ${e(yen(x.before))} → ${e(yen(x.after))}</span>`).join(''))}
  </li>`).join(''))}
</ul>` : html`
<p class="note">この事業者では、観測を始めてから実質月額の変化を検知していません。</p>`)}

<h2>出典</h2>
<ul>${raw(sources.map((u) => `<li><a href="${e(u)}" rel="nofollow noopener">${e(u)}</a></li>`).join(''))}</ul>
<p class="note">
  掲載しているのは<strong>各社が公開している事実の値だけ</strong>です。
  <a href="/method/">計算方法</a>は全社共通で、事業者ごとに変えていません。
</p>
`;
  return {
    title: `${first.providerName}の実質月額（${HORIZON}か月換算）｜${SITE_NAME}`,
    description: `${first.providerName}の料金を毎日自動収集し、${HORIZON}か月の実質月額に換算した${mine.length}件。工事費・割引・キャッシュバックを含めた内訳と、料金が動いた履歴つき。`,
    canonical: `${SITE_URL}/p/${providerId}/`,
    body,
    updatedAt: data.updatedAt,
  };
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
  const e24 = o.effective?.[24]?.effectiveMonthly ?? null;
  const rank = data.publishable
    .filter((x) => x.building === o.building)
    .sort((a, c) => a.effectiveMonthly - c.effectiveMonthly);
  const place = rank.findIndex((x) => x === o) + 1;

  const body = html`
<h1>${o.providerName} ${planName(o)}</h1>
${raw(o.stale ? html`
<p class="stale-note">
  <strong>この値は${o.stale.days}日前から更新できていません。</strong>
  ${jstDate(o.stale.since)}以降、収集または算出に失敗し続けています。
  <strong>表示しているのは${jstDate(o.observedAt)}時点の値で、現在の条件とは違う可能性があります。</strong>
  古い値を消さずに残しているのは、いつから止まっているかを隠さないためです。
</p>` : '')}
<p class="lead">
  ${HORIZON}か月使ったときの実質月額は <strong class="big">${yen(o.effectiveMonthly)}</strong>。
  ${raw(place > 0 ? html`同じ条件（${o.building}）の${rank.length}件中<strong>${place}番目</strong>に安い値です。` : '')}
  <br><small>${jstDateTime(o.observedAt)} 時点 ／ 出典 <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a></small>
</p>

<h2>実質月額の推移</h2>
${raw(svg ? html`
${raw(svg)}
<p class="note">
  料金は改定された日に飛ぶので、階段で描いています。<strong>点と点の間を直線で結んでいません</strong>
  （実際には存在しなかった中間の値をグラフ上に作らないためです）。
</p>` : series.ok && series.flat ? html`
<p class="note">
  <strong>観測を始めてから、この値は変わっていません。</strong>変化を検知した時点でここにグラフが出ます。
  いつから観測しているかは記録していないため、過去に線を伸ばすことはしていません。
</p>` : html`
<p class="note">推移を復元できませんでした（${series.why}）。値そのものは下の内訳のとおりです。</p>`)}

<h2>この金額の内訳（${HORIZON}か月）</h2>
${raw(b ? html`
<div class="table-wrap">
<table>
  <tbody>
    <tr><th>月額料金の合計</th><td class="num">${yen(b.monthlyTotal)}</td></tr>
    <tr><th>事務手数料</th><td class="num">${yen(b.adminFee)}</td></tr>
    <tr><th>工事費の実負担</th><td class="num">${yen(b.constructionBorne)}</td></tr>
    <tr><th>必須オプション</th><td class="num">${yen(b.optionTotal)}</td></tr>
    <tr><th>キャッシュバック</th><td class="num">−${yen(b.cashbackCounted)}</td></tr>
    <tr><th>その他の割引</th><td class="num">−${yen(b.otherDiscounts)}</td></tr>
    <tr class="total"><th>${HORIZON}か月の総額</th><td class="num strong">${yen(o.effective[HORIZON].total)}</td></tr>
    <tr class="total"><th>1か月あたり</th><td class="num strong">${yen(o.effectiveMonthly)}</td></tr>
  </tbody>
</table>
</div>` : '<p class="note">内訳を出せません。</p>')}
${raw(e24 != null ? html`
<p class="note">
  <strong>24か月で解約する場合は ${yen(e24)}</strong>／月です。工事費の分割が終わる前に解約すると残債が乗るため、
  期間によって順位は入れ替わります。
</p>` : '')}

<h2>月額料金の推移（契約からの月数）</h2>
<div class="table-wrap">
<table>
  <thead><tr><th>期間</th><th>月額</th></tr></thead>
  <tbody>${raw((o.publishedMonthly ?? []).map((s) => html`
    <tr><td>${s.fromMonth}〜${s.toMonth ?? ''}か月目</td><td class="num">${yen(s.amount)}</td></tr>`).join(''))}
  </tbody>
</table>
</div>

${raw((o.cashbacks ?? []).length ? html`
<h2>キャッシュバック</h2>
<ul>${raw(o.cashbacks.map((c) => `<li>${e(yen(c.amount))}（${e(c.receiveAtMonth)}か月目に受け取り）${c.note ? `<br><span class="tag">${e(c.note)}</span>` : ''}</li>`).join(''))}</ul>
<p class="note">受け取りが${HORIZON}か月より先になるキャッシュバックは計算に入れていません。</p>` : '')}

${raw(o.constructionFee ? html`
<h2>工事費</h2>
<p>
  定価 ${yen(o.constructionFee.list)}${raw(o.constructionFee.installmentMonths ? html`／${o.constructionFee.installmentMonths}回の分割` : '')}。
  ${raw(o.constructionFee.residualOnEarlyExit ? '<strong>途中解約すると残債が請求されます。</strong>' : '')}
</p>` : '')}

${raw(series.events.length ? html`
<h2>この値が動いた日</h2>
<ul class="events">${raw(series.events.slice().reverse().map((c) => html`
  <li>
    <time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time>
    ${yen(c.before)} → <strong>${yen(c.after)}</strong>（${yenSigned(c.effectiveMonthlyDelta)}）
    ${raw((c.cause ?? []).map((x) => `<br><span class="tag">${e(x.label)}: ${e(yen(x.before))} → ${e(yen(x.after))}</span>`).join(''))}
  </li>`).join(''))}
</ul>` : '')}

<p class="note">
  この値は<a href="/method/">全社共通の計算式</a>で出しています。
  <a href="/p/${o.providerId}/">${o.providerName}の他のプラン</a>／<a href="/">全社の一覧</a>
</p>
`;
  return {
    title: `${o.providerName} ${planName(o)}の実質月額 ${yen(o.effectiveMonthly)}｜${SITE_NAME}`,
    description: `${o.providerName} ${planName(o)}を${HORIZON}か月使ったときの実質月額は${yen(o.effectiveMonthly)}（${jstDate(o.observedAt)}時点）。月額・事務手数料・工事費・キャッシュバックの内訳と、料金が動いた履歴。`,
    canonical: `${SITE_URL}${o.path}`,
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
<div class="table-wrap">
<table>
  <tbody>
    <tr><th>運営者</th><td>${o.name ?? '—'}</td></tr>
    <tr><th>運営形態</th><td>${o.kind ?? '個人'}（法人ではありません）</td></tr>
    <tr><th>公開開始</th><td>${o.sinceMonth ?? '—'}</td></tr>
    <tr><th>連絡先</th><td><a href="/contact/">お問い合わせ</a></td></tr>
    <tr><th>掲載中の観測数</th><td class="num">${data.publishable.length}</td></tr>
  </tbody>
</table>
</div>

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

function renderPrivacy(data) {
  const o = data.owner;
  const body = html`
<h1>プライバシーポリシー</h1>
<p class="lead">
  このサイトは<strong>静的なHTMLだけ</strong>で公開しています。
  会員登録もログイン機能もなく、フォームも置いていません。
</p>

<h2>アクセス解析</h2>
${raw(o.analytics ? html`
<p>
  アクセス状況の把握のため <strong>${o.analytics}</strong> を利用しています。
  これはCookieなどを用いて閲覧の記録を収集しますが、<strong>個人を特定する情報は含みません。</strong>
  ブラウザの設定でCookieを無効にすると、収集を拒否できます。
</p>` : html`
<p>
  <strong>現時点でアクセス解析ツールを導入していません。</strong>
  このサイトのページは、閲覧者を識別するためのCookieを発行しません。
</p>`)}
<p class="note">
  ただし、サイトを置いているレンタルサーバーでは、一般的なWebサーバーと同様に
  アクセスログ（IPアドレス・日時・閲覧ページなど）が記録されます。
</p>

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
  const rows = data.publishable
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
  const top = data.publishable
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
掲載可の観測: ${data.publishable.length}件 ／ 掲載保留: ${data.needsReview.length}件

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
    '/', '/changes/', '/method/', '/data/', '/about/', '/privacy/', '/contact/',
    ...providerIds(data).map((id) => `/p/${id}/`),
    ...data.publishable.map((o) => o.path),
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
    <link>${SITE_URL}/changes/</link>
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

async function page(path, spec, disclosure = '') {
  await out(path, layout({ ...spec, siteUrl: SITE_URL, disclosure }));
}

async function out(path, content) {
  const full = join(DIST, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

// 折れ線＝時系列。このサイトが持っているものをそのまま記号にする
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#0b5fff"/>
<polyline points="5,22 12,15 18,19 27,8" fill="none" stroke="#fff" stroke-width="3"
  stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const STYLE = `:root{--fg:#1a1a1a;--muted:#666;--line:#e2e2e2;--bg:#fff;--accent:#0b5fff;--down:#0a7d3f;--up:#c2340a;--warn:#fff8e1}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;color:var(--fg);background:var(--bg);line-height:1.75}
main{max-width:1000px;margin:0 auto;padding:0 1rem 4rem}
.site-head{max-width:1000px;margin:0 auto;padding:1rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:baseline;border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:1.1rem;text-decoration:none;color:var(--fg)}
.site-head nav{display:flex;gap:1rem;flex-wrap:wrap}
.site-head a{color:var(--muted);text-decoration:none;font-size:.9rem}
.site-head nav a:hover{color:var(--accent)}
h1{font-size:1.6rem;line-height:1.4;margin:2rem 0 .5rem}
h2{font-size:1.2rem;margin:2.5rem 0 .75rem;padding-bottom:.3rem;border-bottom:2px solid var(--line)}
.lead{font-size:1.02rem}
.meta,.note{color:var(--muted);font-size:.85rem}
a{color:var(--accent)}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem;min-width:640px}
th,td{border-bottom:1px solid var(--line);padding:.6rem .5rem;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:600;white-space:nowrap}
.num{text-align:right;white-space:nowrap}
.strong{font-weight:700;font-size:1.05rem}
.breakdown{font-size:.78rem;color:var(--muted);white-space:nowrap}
.src{font-size:.75rem;color:var(--muted)}
.src a{color:var(--muted)}
.tag{display:inline-block;font-size:.72rem;color:var(--muted);background:#f2f2f2;padding:.05rem .4rem;border-radius:3px}
tr.stale{background:var(--warn)}
.banner{padding:.9rem 1rem;border-radius:6px;margin:1.5rem 0;font-size:.9rem}
.banner.warn{background:var(--warn);border:1px solid #f0d78a}
.changes{list-style:none;padding:0}
.changes li{padding:.7rem 0;border-bottom:1px solid var(--line);font-size:.92rem}
.changes time{color:var(--muted);font-size:.8rem;margin-right:.6rem}
.changes .delta{display:block;font-weight:600}
.changes li.down .delta{color:var(--down)}
.changes li.up .delta{color:var(--up)}
.changes .cause{display:block;font-size:.8rem;color:var(--muted)}
.ad-disclosure{max-width:1000px;margin:0 auto;padding:.6rem 1rem;font-size:.8rem;color:var(--muted);background:#f6f6f6;border-bottom:1px solid var(--line)}
.cta{white-space:nowrap}
.link-only{background:#f4f8ff;border:1px solid #cfe0ff;border-radius:6px;padding:1rem 1.2rem;margin:2rem 0}
.link-only ul{list-style:none;padding:0}
.link-only li{padding:.8rem 0;border-bottom:1px solid #dbe7ff;font-size:.92rem}
.link-only li:last-child{border-bottom:none}
.link-only .btn{margin-top:.4rem}
.ad-unit{display:inline-block}
.btn{display:inline-block;padding:.35rem .7rem;background:#0b5fff;color:#fff;border-radius:4px;text-decoration:none;font-size:.82rem;font-weight:600}
.btn:hover{background:#0847c4}
.faq dt{font-weight:600;margin-top:1.2rem}
.faq dd{margin:.4rem 0 0;padding-left:0;color:var(--muted)}
.review{background:#fafafa;padding:1rem;border-radius:6px;margin-top:3rem}
.review h2{border:0;margin-top:0}
.review-list{font-size:.85rem}
.formula{background:#f6f8fa;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.85rem;white-space:pre-wrap}
blockquote{margin:0;padding:.75rem 1rem;background:#f6f8fa;border-left:3px solid var(--accent);font-size:.9rem}
code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px;font-size:.85em}
.site-foot{max-width:1000px;margin:0 auto;padding:2rem 1rem 3rem;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}
.site-foot a{color:var(--muted)}
.foot-nav{display:flex;gap:1.2rem;flex-wrap:wrap;margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--line)}
.disclaimer{background:#fafafa;padding:.75rem;border-radius:4px}
.big{font-size:1.5rem}
.stale-note{background:var(--warn);border-left:4px solid var(--up);padding:.8rem 1rem;border-radius:4px;margin:1rem 0}
.events{list-style:none;padding:0}
.events li{padding:.6rem 0;border-bottom:1px solid var(--line)}
.events time{color:var(--muted);margin-right:.6rem;font-variant-numeric:tabular-nums}
tr.total th,tr.total td{border-top:2px solid var(--line)}
${CHART_CSS}
@media(max-width:600px){h1{font-size:1.35rem}main{padding:0 .75rem 3rem}}
`;

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
