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
import { yen, yenSigned, jstDateTime, jstDate, isoDate, daysSince, host } from './lib/format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(HERE, 'dist');

export const SITE_URL = 'https://tsushinhi-index.com';
const SITE_NAME = '通信費インデックス';

// 全社を横並びにできる唯一の軸。collect 側の PRIMARY と必ず一致させること
const HORIZON = 36;

// これ日数を超えて更新できていない収集元は「更新停止中」と明示する
const STALE_DAYS = 3;

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

  await page('index.html', renderIndex(data));
  await page('changes/index.html', renderChanges(data));
  await page('method/index.html', renderMethod(data));
  await page('data/index.html', renderData(data));

  await out('style.css', STYLE);
  await out('favicon.svg', FAVICON);
  await out('llms.txt', renderLlmsTxt(data));
  await out('sitemap.xml', renderSitemap(data));
  await out('feed.xml', renderFeed(data));
  await out('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  console.log(`生成: site/dist/`);
}

// ── データ読み込み ───────────────────────────────────────────────

async function loadAll() {
  const effective = await readDir(join(ROOT, 'data', 'effective'));
  const changes = await readDir(join(ROOT, 'data', 'effective-changes'));
  const failures = (await readJson(join(ROOT, 'data', 'failures.json'))) ?? { sources: {} };
  const health = await readJson(join(ROOT, 'data', 'health.json'));

  const offers = [];
  for (const snap of effective) {
    for (const o of snap.offers) {
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
        stale: staleInfo(failures, o.sourceUrl),
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

  return { effective, offers, publishable, needsReview, events, failures, health, updatedAt };
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

function staleInfo(failures, url) {
  const rec = Object.entries(failures.sources ?? {}).find(([k]) => k.endsWith(url));
  if (!rec) return null;
  const [, v] = rec;
  if (!v.staleSince) return null;
  const days = daysSince(v.staleSince);
  return { since: v.staleSince, days, consecutive: v.consecutive };
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
  if (providers.size < 2) problems.push(`掲載可の事業者が${providers.size}社。横並び比較が成立しない`);
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
    ${data.publishable.length}件の観測 ／ ${new Set(data.publishable.map((o) => o.providerId)).size}社 ／
    最終取得 ${jstDateTime(data.updatedAt)}
  </p>
</section>

${raw(staleBanner(data))}

${raw(buildings.map((b) => rankingSection(data, b)).join(''))}

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
    description: `光回線${new Set(data.publishable.map((o) => o.providerId)).size}社の料金・工事費・割引・キャッシュバックを毎日自動収集し、同一の計算式で${HORIZON}か月の実質月額に換算して比較しています。計算式と出典を全公開。`,
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

  return html`
<section>
  <h2>${building}：実質月額の安い順（新規申込・${HORIZON}か月換算）</h2>
  <div class="table-wrap">
  <table>
    <thead>
      <tr><th>実質月額</th><th>事業者</th><th>プラン</th><th>内訳</th><th>出典・取得日時</th></tr>
    </thead>
    <tbody>
      ${raw(rows.map(rankRow).join(''))}
    </tbody>
  </table>
  </div>
  <p class="note">
    ${HORIZON}か月換算です。契約期間は各社ばらばら（NURO光は縛りなし）なので、揃えないと比較になりません。
    数え方の統一規則は<a href="/method/">計算方法</a>に書いています。
  </p>
</section>
`;
}

function rankRow(o) {
  const b = o.breakdown;
  const notes = [];
  if (o.setBenefits?.length) notes.push('セット特典は不算入');
  if (o.plan?.work) notes.push(o.plan.work);
  if (o.stale) notes.push(`更新停止中（${o.stale.days}日）`);

  return html`
<tr${raw(o.stale ? ' class="stale"' : '')}>
  <td class="num strong">${yen(o.effectiveMonthly)}</td>
  <td>${o.providerName}</td>
  <td>${o.planKey}${raw(notes.length ? `<br><span class="tag">${notes.map(e).join(' / ')}</span>` : '')}</td>
  <td class="breakdown">
    ${raw(b ? `月額計 ${e(yen(b.monthlyTotal))}<br>事務手数料 ${e(yen(b.adminFee))}<br>工事費実負担 ${e(yen(b.constructionBorne))}<br>CB −${e(yen(b.cashbackCounted))}` : '—')}
  </td>
  <td class="src">
    <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a><br>
    <time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time>
  </td>
</tr>
`;
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
        <strong>${o.providerName}</strong> ${o.planKey}
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
      <strong>${c.providerName}</strong> ${c.planKey} — ${c.type === 'plan-added' ? 'プランが追加されました' : 'プランが見当たらなくなりました'}</li>`;
  }
  const dir = c.effectiveMonthlyDelta < 0 ? 'down' : 'up';
  const cause = (c.cause ?? []).map((x) => `${x.label} ${yen(x.before)}→${yen(x.after)}`).join(' / ');
  return html`
<li class="${dir}">
  <time datetime="${c.detectedAt}">${jstDate(c.detectedAt)}</time>
  <strong>${c.providerName}</strong> ${c.planKey}
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
      name: `${o.providerName} ${o.planKey}`,
      item: {
        '@type': 'Service',
        name: `${o.providerName} ${o.planKey}`,
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
    .map((o) => `- ${o.providerName} ${o.planKey}: ${o.effectiveMonthly.toLocaleString('ja-JP')}円/月（${HORIZON}か月換算、${isoDate(o.observedAt)}時点、出典 ${o.sourceUrl}）`)
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
- ${SITE_URL}/feed.xml : 変化のRSS

## 注意

自動収集のため誤りが含まれる可能性があります。契約前には各社の公式サイトで最新の条件を確認してください。
全レコードに出典URLと取得日時を記録しています。
`;
}

function renderSitemap(data) {
  const urls = ['/', '/changes/', '/method/', '/data/'];
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
      ? `${c.providerName} ${c.planKey} 実質月額 ${yenSigned(c.effectiveMonthlyDelta)}（${yen(c.before)}→${yen(c.after)}）`
      : `${c.providerName} ${c.planKey} ${c.type}`;
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

async function page(path, spec) {
  await out(path, layout({ ...spec, siteUrl: SITE_URL }));
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
.disclaimer{background:#fafafa;padding:.75rem;border-radius:4px}
@media(max-width:600px){h1{font-size:1.35rem}main{padding:0 .75rem 3rem}}
`;

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
