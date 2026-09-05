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
  <div class="hero-grid">
    <div>
      <h1>光回線の実質月額インデックス</h1>
      <p class="lead">
        各社が公表している料金・工事費・割引・キャッシュバックを毎日自動で収集し、
        <strong>全社を同一の計算式に通した「実質月額」</strong>として${HORIZON}か月で均した値です。
        おすすめ順ではありません。<a href="/method/">計算式</a>も<a href="/data/">元データ</a>も全部出しています。
      </p>
      <div class="rail">
        <div class="rail-item"><b>${data.publishable.length}</b><span>掲載中の観測</span></div>
        <div class="rail-item"><b>${data.serviceCount}</b><span>サービス（運営${data.operatorCount}社）</span></div>
        <div class="rail-item"><b>${data.events.length}</b><span>検知した料金の変化</span></div>
        ${raw(railDays(data))}
      </div>
    </div>
    ${raw(distributionPanel(data))}
  </div>
  ${raw(operatorNote(data))}
</section>

${raw(staleBanner(data))}

${raw(legend())}

${raw(buildings.map((b, i) => rankingSection(data, b, i + 1)).join(''))}

${raw(linkOnlyOffers(data))}

<p class="kicker"><b>03</b> 事業者</p>
<section>
  <h2>事業者ごとに見る</h2>
  <p class="note">
    上の表は<strong>新規申込・${HORIZON}か月換算</strong>に絞っています。
    下のカードの金額は<strong>条件を絞らない全観測の最安</strong>（転用やマンションを含む）なので、
    上の表の1位と一致しないことがあります。各社の全プランと料金が動いた履歴は事業者ページにあります。
  </p>
  <div class="pcards">${raw(providerIds(data).map((id) => {
    const mine = data.publishable.filter((o) => o.providerId === id);
    const evAll = data.events.filter((c) => c.providerId === id);
    const lastAt = evAll.map((c) => c.detectedAt).sort().pop() ?? null;
    const cheapest = mine.reduce((a, b) => (a.effectiveMonthly <= b.effectiveMonthly ? a : b));
    return html`
    <a class="pcard" href="/p/${id}/">
      <span class="pname">${mine[0].providerName}${raw(mine.some((o) => o.stale) ? ' <span class="tag">更新停止中</span>' : '')}</span>
      <span class="pmin"><b>${yenMark(cheapest.effectiveMonthly)}</b><small>全条件の最安</small></span>
      <span class="pmeta">
        <span>${mine.length}プラン ／ 記録した変化 ${evAll.length}件</span>
        <span>${raw(lastAt ? html`最後に料金が動いた日 ${jstDate(lastAt)}` : 'まだ料金は動いていません')}</span>
      </span>
    </a>`;
  }).join(''))}
  </div>
</section>

<p class="kicker"><b>04</b> 変化</p>
<section>
  <h2>最近の変化</h2>
  <p class="note">
    <strong>このサイトの中心は一覧表ではなく、ここです。</strong>
    毎日の値を突き合わせて、変わった瞬間だけを記録しています。
  </p>
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
 * その日の分布。**目盛り1本＝観測1件**で、掲載中の実質月額をそのまま並べる。
 *
 * ★平均も中央値も出さない。3サービスしか無い段階の代表値は誤解を招く。
 *   出すのは「一番安い値」と「幅」だけ。どちらも数えるだけで作れる事実。
 * ★横位置は最安〜最高を100%に伸ばした相対位置。絶対値ではないので、
 *   両端に必ず金額を書く。
 */
/**
 * 表を読むための言葉の説明。
 *
 * ★「実質月額」も「事務手数料」も、知っている人にしか通じない。
 *   比較表の直前に置いて、読む前に言葉が揃うようにする。
 *   略語は使わない（「CB」と書いていて意味が通じなかった）。
 */
function legend() {
  const money = [
    ['実質月額',
     `${HORIZON}か月（3年）使い続けたとき、ならすと毎月いくら払ったことになるかの金額です。`
     + '毎月の料金だけでなく、工事費もキャッシュバックも全部ふくめて計算しています。'],
    ['月額の合計', `毎月はらう料金を、${HORIZON}か月ぶん全部たした金額です。`],
    ['事務手数料', '申し込むときに1回だけかかるお金です。毎月はかかりません。'],
    ['工事費', '回線を家に引く工事の代金です。割引が出る会社もあるので、引いたあとの自己負担だけを数えています。'],
    ['キャッシュバック', 'あとから受け取れるお金です。受け取れる分だけを総額から引いています。'],
    ['推移', 'その料金がこれまでどう動いたかの形です。赤は上がった、緑は下がったことを表します。'],
  ];
  // ★プラン名は各社の公式表記をそのまま出している（勝手に言い換えない）。
  //   そのぶん、意味はここで説明する。
  const words = [
    ['戸建て / マンション', '一戸建て向けか、集合住宅向けかの違いです。同じ会社でも料金が変わります。'],
    ['1ギガ / 10ギガ', '通信速度の上限です。数字が大きいほど速く、そのぶん高くなるのがふつうです。'],
    ['新規 / 転用', '新規は、はじめて回線を引く申し込みです。転用は、いま使っている回線をそのまま使って会社だけ変えることです。'
      + 'この表に並べているのは新規だけです。'],
    ['派遣工事', '工事の人が家に来る工事のことです。来ない場合（派遣工事なし）より費用がかかります。'],
    ['2年割 / U29応援割', '会社がつけている割引の名前です。その割引を使った状態で計算しています。'],
    ['セット特典は不算入', 'スマホとのセット割引などは計算に入れていません。'
      + '契約している携帯会社によって割引額が変わり、同じ条件で比べられなくなるためです。'],
  ];
  const grid = (items) => html`<dl>${raw(items.map(([t, d]) =>
    html`<div><dt>${t}</dt><dd>${d}</dd></div>`).join(''))}</dl>`;
  return html`
<section class="legend">
  <p class="kicker"><b>00</b> この表の見かた</p>
  <h3 class="legend-h">お金の言葉</h3>
  ${raw(grid(money))}
  <h3 class="legend-h">プラン名に出てくる言葉</h3>
  ${raw(grid(words))}
</section>`;
}

function railDays(data) {
  const since = observedSince(data);
  if (!since) {
    return html`<div class="rail-item"><b>毎日</b><span><span class="live"></span>自動収集</span></div>`;
  }
  return html`
        <div class="rail-item"><b>${daysSince(since) + 1}<small class="cur">日目</small></b>
          <span><span class="live"></span>${jstDate(since)}から記録</span></div>`;
}

function distributionPanel(data) {
  const vals = data.publishable.map((o) => o.effectiveMonthly).filter((v) => typeof v === 'number');
  if (vals.length < 2) return '';

  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (!(hi > lo)) return '';
  const best = data.publishable.reduce((a, b) => (a.effectiveMonthly <= b.effectiveMonthly ? a : b));

  const ticks = vals.map((v) => {
    const pct = ((v - lo) / (hi - lo)) * 100;
    const edge = v === lo ? ' lo' : v === hi ? ' hi' : '';
    return `<span class="dist-tick${edge}" style="left:${pct.toFixed(2)}%"></span>`;
  }).join('');

  return html`
<div class="dist">
  <p class="kicker">本日の最安（${HORIZON}か月換算）</p>
  <p class="dist-lead"><b>${yenMark(best.effectiveMonthly)}</b><span>／ 月</span></p>
  <p class="dist-plan">
    <a href="${best.path}">${best.providerName} ${planName(best)}</a><br>
    ${jstDateTime(best.observedAt)} 時点
  </p>
  <div class="dist-bar">${raw(ticks)}</div>
  <p class="dist-axis"><span>${yen(lo)}</span><span>${yen(hi)}</span></p>
  <p class="dist-note">
    縦線1本が観測1件（掲載中${vals.length}件）。最安から最高までを幅いっぱいに伸ばした相対位置です。
    平均や中央値は出していません — ${data.serviceCount}サービスの代表値として意味を持たないためです。
  </p>
</div>`;
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

function rankingSection(data, building, no = 1) {
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
<p class="kicker"><b>0${no}</b> ${building}</p>
<section>
  <h2>${building}：実質月額の安い順（新規申込・${HORIZON}か月換算）</h2>
  <div class="card"><div class="table-wrap">
  <table class="ranking">
    <thead>
      <tr><th class="rank">順位</th><th>実質月額</th><th>事業者</th><th>プラン</th><th>推移</th><th>内訳</th><th>出典・取得日時</th>${raw(ads ? '<th>申込</th>' : '')}</tr>
    </thead>
    <tbody>
      ${raw(rows.map((o, i) => rankRow(o, data, i + 1)).join(''))}
    </tbody>
  </table>
  </div></div>
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

function rankRow(o, data, rank) {
  const ad = data.ads.same.get(o.providerId);
  const b = o.breakdown;
  const notes = [];
  if (o.setBenefits?.length) notes.push('セット特典は不算入');
  if (o.plan?.work) notes.push(o.plan.work);
  if (o.stale) notes.push(`更新停止中（${o.stale.days}日）`);

  return html`
<tr class="${raw([rank <= 3 ? 'top' : '', o.stale ? 'stale' : ''].filter(Boolean).join(' '))}">
  <td class="rank">${rank}</td>
  <td class="num strong">${yenMark(o.effectiveMonthly)}</td>
  <td>${o.providerName}</td>
  <td><a class="plan-name" href="${o.path}">${planName(o)}</a>${raw(notes.length ? `<br><span class="tag">${notes.map(e).join(' / ')}</span>` : '')}</td>
  <td>${raw(rowSpark(data, o))}</td>
  <td class="breakdown">
    ${raw(b ? `<i>月額の合計</i>${e(yen(b.monthlyTotal))}<br><i>事務手数料</i>${e(yen(b.adminFee))}<br><i>工事費</i>${e(yen(b.constructionBorne))}<br><i>キャッシュバック</i>−${e(yen(b.cashbackCounted))}` : '—')}
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
  <span class="delta">実質月額 ${yen(c.before)} → ${yen(c.after)}
    <em class="pill">${raw(c.effectiveMonthlyDelta < 0 ? '▼' : '▲')} ${yenSigned(c.effectiveMonthlyDelta)}</em></span>
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
<div class="card"><div class="table-wrap">
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

function renderProvider(data, providerId) {
  const mine = data.publishable.filter((o) => o.providerId === providerId)
    .sort((a, b) => a.effectiveMonthly - b.effectiveMonthly);
  const first = mine[0];
  const op = data.operators[providerId];
  const evs = data.events.filter((c) => c.providerId === providerId);
  const sources = [...new Set(mine.map((o) => o.sourceUrl))];

  const staleHere = mine.filter((o) => o.stale);
  const crumb = breadcrumb([
    { name: '実質月額', path: '/' },
    { name: first.providerName },
  ]);
  const body = html`
${raw(crumb.visible)}
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
<div class="card"><div class="table-wrap">
<table>
  <thead><tr><th>実質月額</th><th>プラン</th><th>内訳</th><th>取得</th></tr></thead>
  <tbody>${raw(mine.map((o) => html`
    <tr>
      <td class="num strong">${yenMark(o.effectiveMonthly)}</td>
      <td><a href="${o.path}">${planName(o)}</a></td>
      <td class="breakdown">${raw(o.breakdown
        ? `月額計 ${e(yen(o.breakdown.monthlyTotal))}<br>工事費実負担 ${e(yen(o.breakdown.constructionBorne))}<br>CB −${e(yen(o.breakdown.cashbackCounted))}`
        : '—')}</td>
      <td class="src"><time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time></td>
    </tr>`).join(''))}
  </tbody>
</table>
</div></div>

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
    head: crumb.ld,
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

  const crumb = breadcrumb([
    { name: '実質月額', path: '/' },
    { name: o.providerName, path: `/p/${o.providerId}/` },
    { name: planName(o) },
  ]);
  const body = html`
${raw(crumb.visible)}
<h1>${o.providerName} ${planName(o)}</h1>
${raw(o.stale ? html`
<p class="stale-note">
  <strong>この値は${o.stale.days}日前から更新できていません。</strong>
  ${jstDate(o.stale.since)}以降、収集または算出に失敗し続けています。
  <strong>表示しているのは${jstDate(o.observedAt)}時点の値で、現在の条件とは違う可能性があります。</strong>
  古い値を消さずに残しているのは、いつから止まっているかを隠さないためです。
</p>` : '')}
<p class="lead">
  ${HORIZON}か月使ったときの実質月額は <strong class="big">${yenMark(o.effectiveMonthly)}</strong>。
  ${raw(place > 0 ? html`同じ条件（${o.building}）の${rank.length}件中<strong>${place}番目</strong>に安い値です。` : '')}
  <br><small>${jstDateTime(o.observedAt)} 時点 ／ 出典 <a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a></small>
</p>

<h2>実質月額の推移</h2>
${raw(svg ? html`
<div class="chart-card">${raw(svg)}</div>
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
<div class="card"><div class="table-wrap">
<table>
  <tbody>
    <tr><th>月額料金の合計</th><td class="num">${yen(b.monthlyTotal)}</td></tr>
    <tr><th>事務手数料</th><td class="num">${yen(b.adminFee)}</td></tr>
    <tr><th>工事費（割引を引いた自己負担）</th><td class="num">${yen(b.constructionBorne)}</td></tr>
    <tr><th>必須オプション</th><td class="num">${yen(b.optionTotal)}</td></tr>
    <tr><th>キャッシュバック</th><td class="num">−${yen(b.cashbackCounted)}</td></tr>
    <tr><th>その他の割引</th><td class="num">−${yen(b.otherDiscounts)}</td></tr>
    <tr class="total"><th>${HORIZON}か月の総額</th><td class="num strong">${yen(o.effective[HORIZON].total)}</td></tr>
    <tr class="total"><th>1か月あたり</th><td class="num strong">${yen(o.effectiveMonthly)}</td></tr>
  </tbody>
</table>
</div></div>` : '<p class="note">内訳を出せません。</p>')}
${raw(e24 != null ? html`
<p class="note">
  <strong>24か月で解約する場合は ${yen(e24)}</strong>／月です。工事費の分割が終わる前に解約すると残債が乗るため、
  期間によって順位は入れ替わります。
</p>` : '')}

<h2>月額料金の推移（契約からの月数）</h2>
<div class="card"><div class="table-wrap">
<table>
  <thead><tr><th>期間</th><th>月額</th></tr></thead>
  <tbody>${raw((o.publishedMonthly ?? []).map((s) => html`
    <tr><td>${s.fromMonth}〜${s.toMonth ?? ''}か月目</td><td class="num">${yen(s.amount)}</td></tr>`).join(''))}
  </tbody>
</table>
</div></div>

${raw((o.cashbacks ?? []).length ? html`
<h2>キャッシュバック</h2>
<ul>${raw(o.cashbacks.map((c) => `<li>${e(yen(c.amount))}（${e(c.receiveAtMonth)}か月目に受け取り）${c.note ? `<br><span class="tag">${e(c.note)}</span>` : ''}</li>`).join(''))}</ul>
<p class="note">受け取りが${HORIZON}か月より先になるキャッシュバックは計算に入れていません。</p>` : '')}

${raw(o.constructionFee ? html`
<h2>工事費</h2>
<p>
  ${raw(typeof o.constructionFee.list === 'number'
    // ★定価が読めていないときに「定価 —。」とは書かない。
    //   分からないことを、分かったような書式で出さない。
    ? html`定価 ${yen(o.constructionFee.list)}${raw(o.constructionFee.installmentMonths ? html`／${o.constructionFee.installmentMonths}回の分割` : '')}。`
    : html`<strong>工事費の定価を出典ページから読み取れていません。</strong>実質月額には、出典に書かれている割引後の実負担額（${yen(b?.constructionBorne ?? 0)}）を入れています。`)}
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

async function page(path, spec, disclosure = '', siteHead = '') {
  await out(path, layout({ ...spec, head: (spec.head ?? '') + siteHead, siteUrl: SITE_URL, disclosure, cssVer }));
}

async function out(path, content) {
  const full = join(DIST, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

// 折れ線＝時系列。このサイトが持っているものをそのまま記号にする
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#1c3f6e"/>
<path d="M4 24 h6.5 v-5.5 h6.5 v-5.5 h6.5 v-4.5 h4.5" fill="none" stroke="#fff"
  stroke-width="2.6" stroke-linecap="square" stroke-linejoin="miter"/>
</svg>
`;

const STYLE = `/* ── 色と文字 ─────────────────────────────────────────────────
   ★参照しているのは比較サイトではなく、経済紙・調査機関の紙面。
     このサイトが売っているのは「毎日測り続けている事実」であって、
     おすすめ順の主観ではない。見た目もそちら側に寄せる。
   ★外部フォント・外部CSSは1つも読み込まない。/privacy/ に
     「閲覧の情報を外部の事業者へ送っていない」と書いている以上、破れない。
     そのぶん、明朝と角ゴシックの対比・罫線・余白だけで作る。 */
:root{
  --paper:#faf8f4;          /* 地。純白にしない（白すぎる画面は素っ気ない） */
  --card:#fff;
  --ink:#15191e;            /* 本文。真っ黒にしない */
  --ink-2:#4d5560;
  --ink-3:#8a929c;
  --rule:#e0dcd3;           /* 罫線。紙に寄せて少し温かい灰 */
  --rule-2:#cdc7bb;
  --indigo:#1c3f6e;         /* 構造色。リンクと図表 */
  --indigo-deep:#122a4a;
  --indigo-soft:#eaeff6;
  --up:#b23a2b;             /* 値上げ＝朱 */
  --down:#0c6a4f;           /* 値下げ＝緑青 */
  --warn-bg:#fdf6e3; --warn-line:#d8b563; --warn-ink:#7a5a12;
  --sans:system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Yu Gothic",
    "Noto Sans JP","Meiryo",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --wrap:1120px;
}
@media(prefers-color-scheme:dark){:root{
  --paper:#12151a; --card:#181c22;
  --ink:#e9e6e0; --ink-2:#a8b0ba; --ink-3:#79818c;
  --rule:#2b3139; --rule-2:#3b434d;
  --indigo:#8fb6e6; --indigo-deep:#0d1620; --indigo-soft:#1b2634;
  --up:#e8836c; --down:#5cc79c;
  --warn-bg:#2a2416; --warn-line:#6b5a2a; --warn-ink:#e0c98a;
}}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--sans);font-size:16px;line-height:1.85;
  font-feature-settings:"palt";text-rendering:optimizeLegibility}
main{max-width:var(--wrap);margin:0 auto;padding:0 1.5rem 5rem}
a{color:var(--indigo);text-underline-offset:.18em;text-decoration-thickness:1px}
a:focus-visible,.pcard:focus-visible{outline:2px solid var(--indigo);outline-offset:2px}
/* 「円」は数字より一段小さく、色も落とす。桁の並びが主役になる */
.cur{font-size:.62em;font-weight:600;color:var(--ink-2);letter-spacing:0;margin-left:.1em}
img,svg{max-width:100%}
::selection{background:var(--indigo-soft)}

/* ── 題字まわり ────────────────────────────────────────────
   ナビゲーションバーではなく「題字」として組む。
   上の細い帯には、この事業の約束（毎日・出典つき）を常に置く。 */
.topbar{background:var(--indigo-deep);color:#cddaea}
.topbar div{max-width:var(--wrap);margin:0 auto;padding:.4rem 1.5rem;
  font-size:.72rem;letter-spacing:.08em;display:flex;gap:1.4rem;flex-wrap:wrap}
.topbar b{color:#fff;font-weight:600}

.site-head{background:var(--paper);border-bottom:1px solid var(--rule-2)}
.head-in{max-width:var(--wrap);margin:0 auto;padding:1.15rem 1.5rem .9rem;
  display:flex;align-items:flex-end;gap:1.5rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.6rem;text-decoration:none;color:var(--ink)}
.brand svg{display:block;flex:none}
.brand strong{display:block;font-weight:800;font-size:1.32rem;
  letter-spacing:.01em;line-height:1.25}
.brand small{display:block;font-size:.7rem;color:var(--ink-2);letter-spacing:.05em;
  font-weight:400;margin-top:.15rem}
.plate-meta{margin-left:auto;text-align:right;font-size:.73rem;color:var(--ink-2);
  letter-spacing:.04em;line-height:1.7}
.plate-meta b{font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.plate-sub{display:block}

.site-nav{position:sticky;top:0;z-index:30;background:var(--paper);
  border-bottom:1px solid var(--rule)}
.site-nav div{max-width:var(--wrap);margin:0 auto;padding:0 1.5rem;
  display:flex;gap:1.9rem;flex-wrap:wrap;overflow-x:auto;
  scrollbar-width:none;-ms-overflow-style:none}
.site-nav div::-webkit-scrollbar{display:none}
.site-nav a{color:var(--ink-2);text-decoration:none;font-size:.83rem;font-weight:600;
  line-height:1.6;letter-spacing:.06em;padding:.72rem 0;
  border-bottom:2px solid transparent;white-space:nowrap}
.site-nav a:hover{color:var(--indigo);border-bottom-color:var(--indigo)}

/* ── 見出し ────────────────────────────────────────────────
   見出しは明朝、本文と数字は角ゴシック。この対比だけで「紙面」になる。 */
h1{font-weight:800;font-size:clamp(1.5rem,1.15rem + 1.35vw,2.1rem);line-height:1.42;
  letter-spacing:-.02em;margin:1.6rem 0 .8rem}
/* 冒頭の見出しだけは大きく取る。ここが紙面の第一印象になる */
.hero h1{font-size:clamp(1.8rem,1.15rem + 2.3vw,2.7rem);line-height:1.3;letter-spacing:-.035em}
h2{font-weight:800;font-size:clamp(1.25rem,1.05rem + .85vw,1.6rem);line-height:1.45;
  letter-spacing:-.02em;margin:2.9rem 0 1.1rem}
/* 節番号を置いた直後だけは、見出しを詰める */
.kicker + section > h2:first-child,.kicker + h2{margin-top:.2rem}
h3{font-weight:700;font-size:1.08rem;letter-spacing:-.01em;margin:2rem 0 .5rem}

/* 節の通し番号。紙面の「見出し前の小見出し」 */
.kicker{font-size:.72rem;letter-spacing:.2em;color:var(--ink-3);font-weight:700;
  margin:3.4rem 0 .6rem;display:flex;align-items:baseline;gap:.75rem}
.kicker::after{content:"";flex:1;height:1px;background:var(--rule);
  transform:translateY(-.28em)}
.kicker b{color:var(--indigo);font-weight:800;font-size:.95rem;letter-spacing:.04em;
  font-variant-numeric:tabular-nums;border-bottom:2px solid var(--indigo);
  padding-bottom:.18rem}

.lead{font-size:1.06rem;line-height:1.95;max-width:44em;color:var(--ink-2)}
.lead strong{color:var(--ink)}
.note,.meta{color:var(--ink-2);font-size:.85rem;line-height:1.8;max-width:52em}
.note strong{color:var(--ink)}

/* ── 冒頭 ──────────────────────────────────────────────────
   統計を4つ並べるだけの箱をやめ、**その日の分布そのもの**を出す。
   これはテンプレートには無い図で、かつ持っているデータからしか描けない。 */
.hero{border-bottom:1px solid var(--rule-2);padding-bottom:2.2rem;margin-bottom:.5rem}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);
  gap:2.6rem;align-items:start}
.hero h1{margin-top:1.8rem}

.rail{display:flex;flex-wrap:wrap;gap:0;margin-top:1.6rem;
  border-top:1px solid var(--rule)}
.rail-item{padding:.85rem 1.5rem .2rem 0;margin-right:1.5rem;
  border-right:1px solid var(--rule);flex:0 0 auto}
.rail-item:last-child{border-right:0;margin-right:0}
.rail-item b{display:block;font-size:1.6rem;font-weight:700;line-height:1.15;
  letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.rail-item span{display:block;font-size:.72rem;color:var(--ink-2);letter-spacing:.06em}
.live{display:inline-block;width:.45rem;height:.45rem;border-radius:50%;
  background:var(--down);margin-right:.35rem;vertical-align:middle}

/* その日の分布。目盛りは1本＝1観測 */
.dist{background:var(--card);border:1px solid var(--rule);padding:1.3rem 1.4rem 1.1rem}
.dist .kicker{margin:0 0 1rem}
.dist-lead{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.1rem}
.dist-lead b{font-size:2.5rem;font-weight:700;letter-spacing:-.03em;line-height:1;
  font-variant-numeric:tabular-nums}
.dist-lead span{font-size:.75rem;color:var(--ink-2);letter-spacing:.06em}
.dist-plan{font-size:.8rem;color:var(--ink-2);margin:.35rem 0 1.3rem;line-height:1.6}
.dist-plan a{color:var(--ink-2)}
.dist-bar{position:relative;height:44px;border-left:1px solid var(--rule-2);
  border-right:1px solid var(--rule-2)}
.dist-bar::before{content:"";position:absolute;left:0;right:0;top:50%;
  height:1px;background:var(--rule-2)}
.dist-tick{position:absolute;top:9px;width:1px;height:26px;background:var(--indigo);
  opacity:.5}
.dist-tick.lo,.dist-tick.hi{opacity:1;height:38px;top:3px;width:2px}
.dist-axis{display:flex;justify-content:space-between;font-size:.72rem;
  color:var(--ink-2);margin-top:.35rem;font-variant-numeric:tabular-nums}
.dist-note{font-size:.72rem;color:var(--ink-3);margin:.9rem 0 0;line-height:1.6}

/* 表を読むための言葉。ここを読めば表が読める、という位置に置く */
.legend{margin-top:2.6rem}
.legend-h{font-size:.76rem;letter-spacing:.14em;color:var(--ink-3);font-weight:700;
  margin:2rem 0 .6rem}
.legend-h:first-of-type{margin-top:.4rem}
.legend dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));
  gap:0;margin:0;border-top:1px solid var(--rule-2);border-left:1px solid var(--rule)}
.legend div{padding:1rem 1.2rem 1.1rem;border-right:1px solid var(--rule);
  border-bottom:1px solid var(--rule);background:var(--card)}
.legend dt{font-weight:800;font-size:.92rem;letter-spacing:-.01em;color:var(--indigo);
  margin-bottom:.25rem}
.legend dd{margin:0;font-size:.82rem;line-height:1.85;color:var(--ink-2)}

/* ── 表 ────────────────────────────────────────────────────
   影も角丸も使わない。**罫線だけ**で組むほうが情報が濃く見える。 */
.card{background:var(--card);border:1px solid var(--rule)}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem;min-width:880px}
thead th{background:var(--card);
  font-size:.68rem;font-weight:700;letter-spacing:.12em;color:var(--ink-3);
  text-align:left;white-space:nowrap;padding:.85rem .8rem .5rem;
  border-bottom:1px solid var(--rule-2)}
td{padding:1.05rem .8rem;border-bottom:1px solid var(--rule);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--indigo-soft)}
th[scope=row],tbody th{text-align:left;font-weight:600;padding:1.05rem .8rem;
  border-bottom:1px solid var(--rule)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 実質月額。この数字がこのサイトの主役なので、他と桁違いに強くする */
.strong{font-weight:700;font-size:1.35rem;letter-spacing:-.03em;line-height:1.3}
th.rank{width:3.2rem}
td.rank{width:3.2rem;text-align:left;font-size:1rem;color:var(--ink-3);font-weight:700;
  padding-top:1.25rem;font-variant-numeric:tabular-nums}
tr.top td.rank{color:var(--indigo)}
tr.top{box-shadow:inset 3px 0 0 var(--indigo)}
.plan-name{font-weight:600;font-size:.95rem;line-height:1.55;text-decoration:none;
  display:inline-block}
.plan-name:hover{text-decoration:underline}
/* 比較表の列幅。プラン名だけが伸び、数字の列は動かないようにする */
.ranking{table-layout:fixed}
.ranking th:nth-child(2){width:7.2rem}
.ranking th:nth-child(3){width:6.4rem}
.ranking th:nth-child(5){width:6.9rem}
.ranking th:nth-child(6){width:12.4rem}
.ranking th:nth-child(7){width:9.6rem}
.ranking th:nth-child(8){width:6rem}
.ranking tbody td:nth-child(3){white-space:nowrap}
/* ★左4列＝値そのもの、右3列＝その裏づけ。境目に細い縦罫を1本だけ入れる */
.ranking th:nth-child(5),.ranking tbody td:nth-child(5){
  border-left:1px solid var(--rule);padding-left:1.15rem}
.breakdown{font-size:.76rem;color:var(--ink-2);white-space:nowrap;line-height:1.75;
  font-variant-numeric:tabular-nums}
.breakdown i{font-style:normal;color:var(--ink-3);display:inline-block;min-width:7.2em}
.src{font-size:.73rem;color:var(--ink-3);line-height:1.7}
.src a{color:var(--ink-2)}
.tag{display:inline-block;font-size:.68rem;color:var(--ink-2);border:1px solid var(--rule-2);
  padding:.02rem .42rem;letter-spacing:.03em;line-height:1.7;margin-top:.3rem}
tr.stale{background:var(--warn-bg)}
tr.stale .tag{border-color:var(--warn-line);color:var(--warn-ink)}
tr.total th,tr.total td{border-top:1px solid var(--rule-2);background:var(--paper)}

/* ── 事業者 ────────────────────────────────────────────────*/
.pcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));
  gap:0;border-top:1px solid var(--rule-2);border-left:1px solid var(--rule)}
.pcard{display:block;padding:1.4rem 1.5rem 1.5rem;text-decoration:none;color:var(--ink);
  border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);
  background:var(--card)}
.pcard:hover{background:var(--indigo-soft)}
.pname{display:block;font-size:1.12rem;font-weight:800;
  letter-spacing:-.01em;margin-bottom:.9rem}
.pmin{display:flex;align-items:baseline;gap:.5rem}
.pmin b{font-size:1.85rem;font-weight:700;letter-spacing:-.03em;line-height:1;
  font-variant-numeric:tabular-nums;color:var(--indigo)}
.pmin small{font-size:.7rem;color:var(--ink-2);letter-spacing:.04em}
.pmeta{display:block;font-size:.75rem;color:var(--ink-2);margin-top:.75rem;
  padding-top:.7rem;border-top:1px solid var(--rule);letter-spacing:.03em}
.pmeta span{display:block}
.pmeta span + span{color:var(--ink-3);margin-top:.15rem}

/* ── 変化 ──────────────────────────────────────────────────
   年表として組む。左の縦罫が「毎日続いている」ことの表現になる。 */
.changes,.events{list-style:none;padding:0 0 0 1.5rem;margin:1rem 0 0;
  border-left:1px solid var(--rule-2)}
.changes li,.events li{position:relative;padding:1.1rem 0;
  border-bottom:1px solid var(--rule)}
.changes li:last-child,.events li:last-child{border-bottom:0}
.changes li::before,.events li::before{content:"";position:absolute;
  left:-1.5rem;top:1.75rem;width:7px;height:7px;border-radius:50%;
  background:var(--paper);border:1.5px solid var(--rule-2);
  transform:translateX(-4px)}
.changes li.up::before{border-color:var(--up);background:var(--up)}
.changes li.down::before{border-color:var(--down);background:var(--down)}
.changes time,.events time{color:var(--ink-3);font-size:.74rem;letter-spacing:.06em;
  margin-right:.7rem;font-variant-numeric:tabular-nums}
.changes .delta{display:block;font-weight:700;font-size:1.02rem;margin-top:.15rem;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.changes li.up .delta{color:var(--up)}
.changes li.down .delta{color:var(--down)}
.changes .cause{display:block;font-size:.78rem;color:var(--ink-2);margin-top:.2rem;
  font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.02em;
  padding:.05rem .5rem;margin-left:.5rem;vertical-align:.08em;
  border:1px solid currentColor;font-variant-numeric:tabular-nums}

/* ── 部品 ──────────────────────────────────────────────────*/
.crumbs{font-size:.76rem;color:var(--ink-3);margin:1.6rem 0 .2rem;letter-spacing:.04em}
.crumbs a{color:var(--ink-2);text-decoration:none}
.crumbs a:hover{color:var(--indigo);text-decoration:underline}
.crumbs .sep{margin:0 .45rem;color:var(--rule-2)}
.big{font-size:2.1rem;font-weight:700;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums;color:var(--ink)}
.banner{padding:1rem 1.2rem;margin:1.6rem 0;font-size:.88rem}
.banner.warn,.stale-note{background:var(--warn-bg);border:1px solid var(--warn-line);
  border-left-width:3px;color:var(--warn-ink);padding:1rem 1.2rem;margin:1.4rem 0;
  font-size:.88rem;line-height:1.8}
.stale-note strong{color:var(--warn-ink)}
.ad-disclosure{background:var(--indigo-soft);border-bottom:1px solid var(--rule)}
.ad-disclosure p{max-width:var(--wrap);margin:0 auto;padding:.6rem 1.5rem;
  font-size:.78rem;color:var(--ink-2);letter-spacing:.03em}
.cta{white-space:nowrap}
.link-only{background:var(--card);border:1px solid var(--rule);
  border-top:3px solid var(--indigo);padding:1.3rem 1.5rem;margin:2.2rem 0}
.link-only ul{list-style:none;padding:0;margin:0}
.link-only li{padding:1rem 0;border-bottom:1px solid var(--rule);font-size:.9rem}
.link-only li:last-child{border-bottom:none}
.link-only .btn{margin-top:.6rem}
.ad-unit{display:inline-block}
.btn{display:inline-block;padding:.5rem 1.15rem;background:var(--indigo);color:#fff;
  text-decoration:none;font-size:.82rem;font-weight:700;letter-spacing:.04em}
.btn:hover{background:var(--indigo-deep)}
.faq dt{font-weight:800;font-size:1.02rem;margin-top:1.8rem;letter-spacing:-.01em}
.faq dd{margin:.4rem 0 0;color:var(--ink-2)}
.review{background:var(--card);border:1px solid var(--rule);padding:1.4rem 1.6rem;
  margin-top:3.5rem}
.review h2{margin-top:0}
.review-list{font-size:.85rem}
.formula{background:var(--card);border:1px solid var(--rule);padding:1.1rem 1.2rem;
  overflow-x:auto;font-size:.83rem;white-space:pre-wrap;font-family:var(--mono);
  line-height:1.9}
blockquote{margin:1.2rem 0;padding:.9rem 1.3rem;background:var(--card);
  border-left:2px solid var(--indigo);font-size:.9rem;color:var(--ink-2)}
code{background:var(--indigo-soft);padding:.08rem .35rem;font-size:.87em;
  font-family:var(--mono)}

/* ── 奥付 ──────────────────────────────────────────────────
   最後まで紙面らしく閉じる。ここが白いままだと下端が締まらない。 */
.site-foot{background:var(--indigo-deep);color:#b9c6d6;margin-top:0;
  border-top:3px solid var(--indigo)}
.foot-in{max-width:var(--wrap);margin:0 auto;padding:2.8rem 1.5rem 3.5rem;
  font-size:.82rem;line-height:1.9}
.site-foot a{color:#dbe6f2}
.foot-in>p:first-child{font-weight:800;font-size:.95rem;letter-spacing:.02em;
  color:#fff;margin:0 0 1.2rem;padding-bottom:1.2rem;
  border-bottom:1px solid rgba(255,255,255,.16)}
.disclaimer{border:1px solid rgba(255,255,255,.18);padding:1rem 1.2rem;
  background:rgba(255,255,255,.04)}
.disclaimer strong{color:#fff}
.foot-nav{display:flex;gap:1.8rem;flex-wrap:wrap;margin-top:1.6rem;padding-top:1.3rem;
  border-top:1px solid rgba(255,255,255,.16)}
.foot-nav a{font-weight:600;letter-spacing:.05em;text-decoration:none}
.foot-nav a:hover{text-decoration:underline}

/* ── 画面が狭いとき ────────────────────────────────────────*/
@media(max-width:860px){
  .hero-grid{grid-template-columns:1fr;gap:2rem}
}
@media(max-width:640px){
  body{font-size:15px}
  main{padding:0 1.1rem 4rem}
  .head-in{padding:.85rem 1.1rem .7rem;gap:.5rem}
  .brand strong{font-size:1.25rem}
  .brand small{font-size:.66rem}
  /* 題字の下に情報を積むと本文が画面から押し出される。最終更新だけ残す */
  .plate-meta{margin-left:0;text-align:left;width:100%;font-size:.7rem}
  .plate-sub{display:none}
  .topbar div{padding:.4rem 1.1rem;gap:.9rem;font-size:.68rem}
  /* 折り返さず横スクロールさせる。2段になると題字がさらに伸びる */
  .site-nav div{padding:0 1.1rem;gap:1.35rem;flex-wrap:nowrap}
  .rail{display:grid;grid-template-columns:1fr 1fr;border-left:0}
  .rail-item{padding:.75rem 0 .55rem;margin:0;border-right:0;
    border-bottom:1px solid var(--rule)}
  .rail-item:nth-child(odd){border-right:1px solid var(--rule);padding-right:1rem}
  .rail-item:nth-child(even){padding-left:1rem}
  .rail-item b{font-size:1.35rem}
  .dist{padding:1.1rem 1.1rem 1rem}
  .dist-lead b{font-size:2.1rem}
  .kicker{margin-top:2.6rem}
}
@media(prefers-reduced-motion:no-preference){
  tbody tr,.pcard{transition:background .13s ease}
  .site-nav a{transition:color .13s ease,border-color .13s ease}
}
@media print{
  .site-nav,.topbar{display:none}
  body{background:#fff}
}
${CHART_CSS}
`;

// CSS本文のハッシュ。中身が変わったときだけ変わる＝変わらない限りキャッシュは効いたまま。
// ★STYLE の定義より後に置くこと（const は巻き上げても初期化前は参照できない）。
export const cssVer = createHash('sha1').update(STYLE).digest('hex').slice(0, 8);

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
