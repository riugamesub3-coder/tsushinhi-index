// verify — 生成されたHTMLを読み直して、data/ の値と一致するか確認する。
//
// ★build.mjs の中で検証しても意味が薄い。同じ変数を見比べているだけになるため。
//   ここは**出力されたHTMLを他人のように読み**、data/ の JSON と突き合わせる。
//   受け入れ基準 A-007（画面の値が data/ と一致すること）の機械的な裏付けになる。
//
// 使い方:
//   node site/build.mjs && node site/verify.mjs              # 生成物を検証
//   node site/verify.mjs https://tsushinhi-index.com/        # **公開中の実物**を検証
//
// URLを渡す形を用意しているのは、配信でこけたり古いものが残っていても
// 生成物だけ見ていれば気づけないため。**公開されている物を確かめる。**

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(HERE, 'dist');
const HORIZON = 36;

const target = process.argv[2] ?? null;
const problems = [];
const notes = [];

/** 生成物からでも公開URLからでも同じように読む */
async function fetchText(rel) {
  if (!target) return readFile(join(DIST, rel), 'utf8');
  const url = new URL(rel.replace(/index\.html$/, ''), target).href;
  const res = await fetch(url, { headers: { 'user-agent': 'tsushinhi-index-verify/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

if (target) notes.push(`公開中の ${target} を検証`);

const html = await fetchText('index.html');

// ── data/ 側の正解表を作る ──────────────────────────────────────
const truth = new Map(); // "事業者名 / 表示名" -> { yen, sourceUrl, publishable }
// ★突き合わせの鍵は**画面に出ている名前**（planLabel）にする。
//   planKey は変化検知用の識別子で、画面に出す名前と別物のことがある
//   （例: planKey「1ギガ / 戸建 / …」＝表示「1ギガ M / 戸建 / …」）。
//   data/ 側も画面と同じ名前に直してから比べないと、正しい表示を「data に無い」と誤検出する。
for (const f of (await readdir(join(ROOT, 'data', 'effective'))).filter((f) => f.endsWith('.json'))) {
  const snap = JSON.parse(await readFile(join(ROOT, 'data', 'effective', f), 'utf8'));
  for (const o of snap.offers) {
    truth.set(`${snap.providerName}\u0000${o.planLabel ?? o.planKey}`, {
      yen: o.effective?.[HORIZON]?.effectiveMonthly ?? null,
      sourceUrl: o.sourceUrl,
      publishable: o.publishable === true && o.effective?.[HORIZON]?.effectiveMonthly != null,
      observedAt: o.observedAt ?? snap.observedAt,
    });
  }
}

// ── HTML側の表示値を読み取る ────────────────────────────────────
// <td class="num strong">3,655円</td><td class="prov">NURO光</td><td class="plan"><a ...>戸建て / 2ギガ / U29応援割</a>...
// ★2026-11-20 の刷新で、全条件の行を1つの表に入れ、条件に合わない行は hidden にした。
//   hidden の行も検証の対象（HTMLに載っている以上、AIや検索エンジンは読む）。
const rowRe = /<td class="num strong">([\s\S]*?)<\/td>\s*<td class="prov">([^<]+)<\/td>\s*<td class="plan">([\s\S]*?)<\/td>/g;
const shown = [];
let m;
while ((m = rowRe.exec(html)) !== null) {
  // ★タグを先に剥がす。金額セルには「円」を小さく見せる <small> が入る。
  //   属性の中に数字があるタグを入れたとたん、黙って値が変わるのを防ぐ。
  const yen = Number(m[1].replace(/<[^>]+>/g, '').replace(/[^\d]/g, ''));
  const provider = m[2].trim();
  // ★プラン名はプランページへのリンクになっている。タグを剥がさずに読むと空文字になり、
  // 全件が「data に無い」と誤検出される（2026-09-04 実際に踏んだ）。
  const linked = /^\s*<a [^>]*>([^<]*)<\/a>/.exec(m[3]);
  const planKey = (linked ? linked[1] : m[3].split('<')[0]).trim();
  shown.push({ yen, provider, planKey });
}

if (!shown.length) problems.push('トップページから表示値を1件も読み取れなかった（HTMLの構造が変わった疑い）');

// ── 記録を止めたサービスが順位表に混ざっていないか ────────────────
// ★古い値を今日の順位に混ぜない（2026-11-20 まで、止まった値がトップの答えに出ていた）
{
  const targets = JSON.parse(await readFile(join(ROOT, 'collect', 'targets.json'), 'utf8'));
  const stopped = targets.niches.filter((n) => n.status === 'excluded' && n.excludedAt);
  const names = new Map();
  for (const f of (await readdir(join(ROOT, 'data', 'effective'))).filter((f) => f.endsWith('.json'))) {
    const snap = JSON.parse(await readFile(join(ROOT, 'data', 'effective', f), 'utf8'));
    names.set(snap.providerId, snap.providerName);
  }
  for (const n of stopped) {
    const name = names.get(n.id);
    if (name && shown.some((r) => r.provider === name)) {
      problems.push(`記録を止めた ${name} が順位表に入っている（${n.excludedAt}〜対象外）`);
    }
  }
  if (stopped.length) notes.push(`記録を止めた ${stopped.length}サービスは順位表に入れていない`);
}

// ── 最上級表現が混ざっていないか ─────────────────────────────────
// ★比較広告ガイドライン上、「最安」「いちばん安い」は比較の母集団が欠けている状態では使えない
//   （記録が止まっているサービスがある）。docs/research/2026-11-20_サイト刷新の表示可否.md 判定3。
{
  const SUPER = /最安|いちばん安い|一番安い|最も安い|No\.?\s?1|ナンバーワン|業界最/;
  const visible = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const rel of ['index.html', 'changes/index.html', 'mobile/index.html']) {
    const text = visible(rel === 'index.html' ? html : await fetchText(rel));
    const m = SUPER.exec(text);
    if (m) problems.push(`${rel} に最上級表現「${m[0]}」がある: …${text.slice(Math.max(0, m.index - 30), m.index + 30)}…`);
  }
  // CSS の content でも文字は画面に出る（「1位」の札などをCSSで出している）
  const mc = SUPER.exec((await fetchText('style.css')).replace(/\/\*[\s\S]*?\*\//g, ''));
  if (mc) problems.push(`style.css に最上級表現「${mc[0]}」がある（content で画面に出る）`);
  notes.push('最上級表現（最安・いちばん安い 等）は無い');
}

// ── 突き合わせ ──────────────────────────────────────────────────
for (const s of shown) {
  const key = `${s.provider}\u0000${s.planKey}`;
  const t = truth.get(key);
  if (!t) {
    problems.push(`画面にあるが data/ に無い: ${s.provider} / ${s.planKey}`);
    continue;
  }
  if (t.yen !== s.yen) {
    problems.push(`値が不一致: ${s.provider} / ${s.planKey} — 画面 ${s.yen} ≠ data ${t.yen}`);
  }
  if (!t.publishable) {
    problems.push(`掲載してはいけない観測が画面に出ている: ${s.provider} / ${s.planKey}`);
  }
}

// ── スマホ料金ページ（/mobile/）: data/mobile/ と一致するか ──────────
// ★光回線とは別の data（data/mobile/effective/）が正解。光回線の値が混ざっていないかも見る。
{
  const mTruth = new Map(); // "providerId\0planKey" -> { yen, publishable }
  let dir = [];
  try { dir = (await readdir(join(ROOT, 'data', 'mobile', 'effective'))).filter((f) => f.endsWith('.json')); } catch { dir = []; }
  for (const f of dir) {
    const snap = JSON.parse(await readFile(join(ROOT, 'data', 'mobile', 'effective', f), 'utf8'));
    for (const o of snap.offers) {
      mTruth.set(`${snap.providerId}\u0000${o.planKey}`, {
        yen: o.effective?.[HORIZON]?.effectiveMonthly ?? null,
        publishable: o.publishable === true && o.effective?.[HORIZON]?.effectiveMonthly != null,
        feeSourceUrl: o.feeSourceUrl && o.feeSourceUrl !== o.sourceUrl ? o.feeSourceUrl : null,
        voice: o.plan?.voice ?? null,
      });
    }
  }
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const num = (s) => Number(s.replace(/<[^>]+>/g, '').replace(/[^\d]/g, ''));
  try {
    const mh = await fetchText('mobile/index.html');
    const items = [];
    // 全プランの表
    for (const r of mh.matchAll(/<tr class="m-row" data-pid="([^"]+)" data-key="([^"]+)">([\s\S]*?)<\/tr>/g)) {
      const v = /<td class="num m-v">([\s\S]*?)<\/td>/.exec(r[3]);
      items.push({ where: '全プラン', pid: r[1], key: unesc(r[2]), yen: v ? num(v[1]) : NaN, src: /<td class="src">[\s\S]*?<time datetime="/.test(r[3]), body: r[3] });
    }
    // ★全プランの表1枚に、音声つきとデータのみを混ぜない（条件の違うものを1つの並びにしない）
    for (const t of mh.split('<table class="mtable mall">').slice(1)) {
      const kinds = new Set([...t.split('</table>')[0].matchAll(/<tr class="m-row" data-pid="([^"]+)" data-key="([^"]+)">/g)]
        .map((r) => mTruth.get(`${r[1]}\u0000${unesc(r[2])}`)?.voice));
      if (kinds.size > 1) problems.push('スマホ料金ページの全プラン表1枚に、音声つきとデータのみが混ざっている');
    }
    // 使う量ごとの表のマス
    for (const c of mh.matchAll(/<td class="m-cell" data-pid="([^"]+)" data-key="([^"]+)" data-v="(\d+)">([\s\S]*?)<\/td>/g)) {
      const shownYen = /<b class="m-eff">([\s\S]*?)<\/b>/.exec(c[4]);
      items.push({ where: '量ごと', pid: c[1], key: unesc(c[2]), yen: shownYen ? num(shownYen[1]) : NaN, attr: Number(c[3]), src: /class="src"[\s\S]*?<time datetime="/.test(c[4]), body: c[4] });
    }
    if (dir.length && !items.length) problems.push('スマホ料金ページから表示値を1件も読み取れなかった（HTMLの構造が変わった疑い）');
    let bad = 0;
    for (const s of items) {
      const t = mTruth.get(`${s.pid}\u0000${s.key}`);
      if (!t) { problems.push(`スマホ料金ページ（${s.where}）にあるが data/mobile/ に無い: ${s.pid} / ${s.key}`); bad++; continue; }
      if (t.yen !== s.yen || (s.attr != null && s.attr !== s.yen)) { problems.push(`スマホ料金ページ（${s.where}）の値が不一致: ${s.pid} / ${s.key} — 画面 ${s.yen} ≠ data ${t.yen}`); bad++; }
      if (!t.publishable) { problems.push(`掲載してはいけないスマホの観測が出ている: ${s.pid} / ${s.key}`); bad++; }
      if (!s.src) { problems.push(`スマホ料金ページ（${s.where}）に出典か取得日時が無い: ${s.pid} / ${s.key}`); bad++; }
      // 初期費用を別ページから読んでいる観測は、そのページも出典に要る（実質月額は初期費用を含む）
      if (t.feeSourceUrl && !s.body.includes(`href="${t.feeSourceUrl}"`)) { problems.push(`スマホ料金ページ（${s.where}）に初期費用の出典が無い: ${s.pid} / ${s.key}`); bad++; }
    }
    // 光回線の行が混ざっていないか（data/effective/ の事業者名で見る）
    for (const k of truth.keys()) {
      const provider = k.split('\u0000')[0];
      if (mh.includes(`<td class="m-prov">${provider}</td>`)) { problems.push(`スマホ料金ページに光回線の ${provider} が入っている`); break; }
    }
    if (!bad) notes.push(`スマホ料金ページ ${items.length}か所の値は data/mobile/ と一致・全部に出典と取得日時`);
  } catch (err) {
    if (dir.length) problems.push(`スマホ料金ページを検証できない: ${err.message}`);
  }
}

// ── 出典と時点が全行にあるか（docs/03 の必須要件）──────────────
const rowCount = shown.length;
const srcCount = (html.match(/<td class="src">/g) ?? []).length;
const timeCount = (html.match(/<time datetime="/g) ?? []).length;
if (srcCount < rowCount) problems.push(`出典セルが足りない: ${srcCount} < 表示行 ${rowCount}`);
if (timeCount < rowCount) problems.push(`取得日時が足りない: ${timeCount} < 表示行 ${rowCount}`);

// ── 掲載保留のものが「保留」として出ているか ─────────────────────
const held = [...truth.entries()].filter(([, t]) => !t.publishable);
for (const [key] of held) {
  const [provider, planKey] = key.split('\u0000');
  if (shown.some((s) => s.provider === provider && s.planKey === planKey)) {
    problems.push(`保留すべき観測が比較表に出ている: ${provider} / ${planKey}`);
  }
}
notes.push(`掲載保留 ${held.length}件は比較表に出していない`);

// ── AIクローラーを遮断していないか（この事業の生命線）─────────────
const robots = await fetchText('robots.txt');
if (/Disallow:\s*\/\s*$/m.test(robots)) problems.push('robots.txt が全体を Disallow している');
for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'CCBot', 'Google-Extended']) {
  if (new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*/`, 'i').test(robots)) {
    problems.push(`robots.txt が ${bot} を遮断している。被引用を目的にしているので致命的`);
  }
}

// ── AI向け出力が揃っているか ────────────────────────────────────
for (const f of ['llms.txt', 'sitemap.xml', 'feed.xml', 'style.css', 'method/index.html', 'data/index.html', 'changes/index.html']) {
  try {
    const c = await fetchText(f);
    if (!c.trim()) problems.push(`${f} が空`);
  } catch (err) {
    problems.push(`${f} が取得できない: ${err.message}`);
  }
}

// JSON-LD が壊れていないか（構文エラーは検証ツールで弾かれる前に自分で気づく）
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
if (!ldBlocks.length) problems.push('トップページに JSON-LD が無い');
for (const [, json] of ldBlocks) {
  try {
    const o = JSON.parse(json.replace(/\\u003c/g, '<'));
    if (!o['@type']) problems.push('JSON-LD に @type が無い');

    // ★このサイトは売主ではない。ItemList の中身を Product に戻さないこと。
    //   Googleは「商品を購入できるページだけが販売者のリスティングの対象」と明記しており、
    //   Product + Offer で書くと販売者のリスティング扱いになって全件が無効になる。
    //   さらに image を足して"有効"にするのは、自分が売主だと偽ることになる。
    //   理由の全文は site/build.mjs の itemListLd の上にある。
    if (o['@type'] === 'ItemList') {
      for (const li of o.itemListElement ?? []) {
        const t = li.item?.['@type'];
        if (t !== 'Service') {
          problems.push(
            `ItemList の item が Service ではなく ${t}。` +
            'このサイトは売主ではないので Product にしてはいけない（build.mjs の itemListLd 参照）',
          );
          break;
        }
        const off = li.item.offers ?? {};
        if (off.availability) {
          problems.push('Offer に availability がある。提供可否は住所依存で未収集なので書けない');
          break;
        }
      }
    }
  } catch (err) {
    problems.push(`JSON-LD が JSON として壊れている: ${err.message}`);
  }
}

// ── 広告リンクと広告表記が食い違っていないか ────────────────────
//
// ★両方向を見る。
//   広告リンクがあるのに表記が無い → ステマ規制違反。
//   広告リンクが無いのに表記がある → **それも嘘**。「広告を利用しています」は事実でなくなる。
// 表記の要件（ファーストビュー・A8.net）は docs/03_法務コンプラ.md の 6-4。
{
  const DISCLOSURE = 'アフィリエイト広告を利用しています';
  const adUnits = [...html.matchAll(/<span class="ad-unit" data-ad="1">/g)];
  const shownDisclosure = html.includes(DISCLOSURE);

  if (adUnits.length && !shownDisclosure) {
    problems.push(`広告が${adUnits.length}本あるのに広告表記が無い（ステマ規制）`);
  }
  if (!adUnits.length && shownDisclosure) {
    problems.push('広告が1本も無いのに広告表記がある。それも事実と異なる');
  }
  notes.push(adUnits.length ? `広告 ${adUnits.length}本・広告表記あり` : '広告なし（広告表記も出していない）');
}

// ── 計算方法ページ: FAQの構造化データが本文と一致しているか ──────
//
// ★Googleは構造化データがページに見えている内容と一致することを求めている。
//   それ以前に「載っていないものを載っていると書く」のはこの部屋の禁止事項。
//   実際にやってしまった: JSON-LD には FAQ が4件あるのに、本文には1件も無い状態で
//   公開していた（2026-08-24 発見）。生成物を読み直さない限り気づけなかった。
try {
  const methodHtml = await fetchText('method/index.html');
  const text = methodHtml.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  const has = (s) => text.includes(s);
  let faqFound = 0;
  for (const [, json] of methodHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const o = JSON.parse(json.replace(/\\u003c/g, '<'));
    if (o['@type'] !== 'FAQPage') continue;
    for (const q of o.mainEntity ?? []) {
      faqFound++;
      if (!has(q.name)) problems.push(`FAQの質問がページ本文に無い: ${q.name}`);
      else if (!has(q.acceptedAnswer.text)) problems.push(`FAQの回答がページ本文に無い: ${q.name}`);
    }
  }
  if (faqFound) notes.push(`計算方法ページのFAQ ${faqFound}件は本文にも出ている`);
} catch (err) {
  problems.push(`計算方法ページを検証できない: ${err.message}`);
}

// ── パンくず: 構造化データが見える表示と一致しているか ──────────
//
// ★JSON-LD にだけ書いて画面に無いのは「ページに無いものを構造化データで主張する」こと。
//   Googleの規約違反であり、この部屋の禁止事項でもある。FAQで一度やっている。
//   パンくずは見える表示と JSON-LD を同じ関数から作っているが、
//   **同じ関数から作っていることは一致の保証にならない。**出力を突き合わせる。
try {
  // ★固定のパスにしない。サービスを対象外にするとページの扱いが変わる。トップの表から1つ拾う
  const firstPlan = /<a class="plan-name" href="\/(p\/[^"]+\/)"/.exec(html)?.[1];
  if (!firstPlan) throw new Error('トップからプランページへのリンクが見つからない');
  const crumbHtml = await fetchText(`${firstPlan}index.html`);
  const nav = /<nav class="crumbs"[\s\S]*?<\/nav>/.exec(crumbHtml);
  if (!nav) {
    problems.push('プランページにパンくずの表示が無い');
  } else {
    const visible = nav[0].replace(/<[^>]+>/g, ' ');
    let n = 0;
    for (const [, json] of crumbHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const o = JSON.parse(json.replace(/\u003c/g, '<'));
      if (o['@type'] !== 'BreadcrumbList') continue;
      for (const it of o.itemListElement ?? []) {
        n++;
        if (!visible.includes(it.name)) problems.push(`パンくずの構造化データが画面に無い: ${it.name}`);
      }
    }
    if (!n) problems.push('プランページに BreadcrumbList の構造化データが無い');
    else notes.push(`パンくず ${n}段は画面の表示と一致`);
  }
} catch (err) {
  problems.push(`パンくずを検証できない: ${err.message}`);
}

// ── 結果 ────────────────────────────────────────────────────────
console.log(`表示 ${shown.length}行 / data ${truth.size}観測 / JSON-LD ${ldBlocks.length}件`);
for (const n of notes) console.log(`  ・${n}`);

if (problems.length) {
  console.error('\n不一致:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✅ 画面の値は data/ と一致。出典・取得日時も全行にある。');
