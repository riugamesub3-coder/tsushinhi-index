// mobile — スマホ料金のページ（/mobile/）。光回線のページとはデータも見せ方も分ける。
//
// ★光回線の順位（data/effective/）に混ぜない。データは data/mobile/effective/ だけを読む。
//
// 見せ方の決め事（docs/03 の表示ルール・docs/04「スマホ料金」）:
//   - 行＝毎月使うデータ量、列＝会社。各マスは「その量を使える、その会社のプランのうち実質月額が低いもの」。
//     会社どうしに順位は付けない（記録しているのが少数で、「安い順」と言える母集団ではない）。
//   - 音声通話あり と データ通信のみ は別の表にする（条件の違うものを同じ表で比べない。TCA 事例7-3 の考え方）。
//   - 範囲（何社・何プランだけを記録しているか）をページ冒頭に書く。最上級表現は使わない（verify.mjs が検査）。
//   - すべての金額に出典と取得日時を付ける。記録が止まった値は表に入れない。

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { html, raw, e } from './lib/html.mjs';
import { yen, jstDateTime, host } from './lib/format.mjs';
import { staleInfo } from './lib/stale.mjs';

const HORIZON = 36;

/** 表の行（データ量）。gb は「この量を使う人」。該当判定は dataFromGb < gb ≤ dataToGb（null=上限なし） */
export const USAGE = [
  { gb: 3, label: '3GB' },
  { gb: 7, label: '7GB' },
  { gb: 15, label: '15GB' },
  { gb: 20, label: '20GB' },
  { gb: 30, label: '30GB' },
  { gb: 50, label: '50GB' },
  { gb: 51, label: '50GBより多い' },
];

export const covers = (o, gb) => (o.plan?.dataFromGb ?? 0) < gb && (o.plan?.dataToGb == null || gb <= o.plan.dataToGb);

export async function loadMobile(root, failures, staleDays) {
  const dir = join(root, 'data', 'mobile', 'effective');
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { names = []; }
  const snaps = [];
  for (const f of names) snaps.push(JSON.parse(await readFile(join(dir, f), 'utf8')));

  const offers = [];
  for (const snap of snaps) {
    for (const o of snap.offers) {
      const stale = staleInfo(failures, o.sourceUrl, snap.providerId);
      offers.push({
        ...o,
        providerId: snap.providerId,
        providerName: snap.providerName,
        observedAt: o.observedAt ?? snap.observedAt,
        effectiveMonthly: o.effective?.[HORIZON]?.effectiveMonthly ?? null,
        total: o.effective?.[HORIZON]?.total ?? null,
        stale,
        paused: Boolean(stale && stale.days >= staleDays),
      });
    }
  }
  const publishable = offers.filter((o) => o.publishable === true && o.effectiveMonthly != null);
  const live = publishable.filter((o) => !o.paused);
  const updatedAt = snaps.map((s) => s.observedAt).sort().pop() ?? null;
  return { snaps, offers, publishable, live, paused: publishable.filter((o) => o.paused), updatedAt };
}

/** 会社ごと・データ量ごとに、該当するプランのうち実質月額が低いもの（同額なら eSIM より SIMカード を先にしない＝名前順） */
export function pickFor(rows, providerId, gb) {
  const c = rows.filter((o) => o.providerId === providerId && covers(o, gb));
  c.sort((a, b) => a.effectiveMonthly - b.effectiveMonthly || String(a.planKey).localeCompare(String(b.planKey)));
  return c[0] ?? null;
}

const providerOrder = (rows) => [...new Map(rows.map((o) => [o.providerId, o.providerName])).entries()];

/**
 * 出典。★初期費用を別ページから読んでいる事業者（楽天モバイル: /guide/commission/）は、そのページも併記する。
 *   実質月額は初期費用を含むので、月額の出典だけでは値の根拠が半分しか示せない（2026-11-21 critic の指摘）。
 */
function sources(o) {
  const fee = o.feeSourceUrl && o.feeSourceUrl !== o.sourceUrl ? o.feeSourceUrl : null;
  return html`<span class="src"><a href="${o.sourceUrl}" rel="nofollow noopener">${host(o.sourceUrl)}</a>${raw(fee ? '（料金）' : '')}${raw(fee ? html` <a href="${fee}" rel="nofollow noopener" data-fee-src="1">${host(fee)}</a>（手数料）` : '')}<time datetime="${o.observedAt}">${jstDateTime(o.observedAt)}</time></span>`;
}

function cell(o) {
  if (!o) return html`<td class="m-cell m-none">この量に合うプランは記録していません</td>`;
  const chips = [];
  if (o.plan?.simForm === 'eSIM') chips.push('eSIM');
  return html`<td class="m-cell" data-pid="${o.providerId}" data-key="${o.planKey}" data-v="${o.effectiveMonthly}">
  <b class="m-eff">${yen(o.effectiveMonthly)}</b><span class="m-per">／月</span>
  <span class="m-plan">${o.planLabel ?? o.planKey}</span>
  ${raw(chips.length ? `<span class="chips">${chips.map((c) => `<span class="chip">${e(c)}</span>`).join('')}</span>` : '')}
  ${raw(sources(o))}
</td>`;
}

function matrix(rows, caption) {
  const provs = providerOrder(rows);
  if (!provs.length) return '';
  return html`
<div class="card"><div class="table-wrap">
<table class="mtable">
  <caption class="m-cap">${caption}</caption>
  <thead><tr><th>毎月使う量</th>${raw(provs.map(([, name]) => html`<th>${name}</th>`).join(''))}</tr></thead>
  <tbody>${raw(USAGE.map((u) => html`
    <tr><th scope="row">${u.label}</th>${raw(provs.map(([id]) => cell(pickFor(rows, id, u.gb))).join(''))}</tr>`).join(''))}
  </tbody>
</table>
</div></div>`;
}

function dataRange(o) {
  const from = o.plan?.dataFromGb ?? 0;
  const to = o.plan?.dataToGb;
  if (to == null) return from ? `${from}GB超（上限なし）` : '上限なし';
  return from ? `${from}GB超〜${to}GB` : `${to}GBまで`;
}

/** 全プランの表。★音声つきとデータのみは別の表にする（条件の違うものを1つの並びに混ぜない。critic の指摘） */
function allPlans(rows, caption) {
  if (!rows.length) return '';
  const sorted = [...rows].sort((a, b) => a.providerName.localeCompare(b.providerName, 'ja') || a.effectiveMonthly - b.effectiveMonthly);
  return html`
<div class="card"><div class="table-wrap">
<table class="mtable mall">
  <caption class="m-cap">${caption}</caption>
  <thead><tr><th>会社</th><th>プラン</th><th>通話</th><th>データ量</th><th>毎月の料金</th><th>初期費用</th><th>実質月額</th><th>出典・取得日時</th></tr></thead>
  <tbody>${raw(sorted.map((o) => html`
    <tr class="m-row" data-pid="${o.providerId}" data-key="${o.planKey}">
      <td class="m-prov">${o.providerName}</td>
      <td class="m-plan">${o.planLabel ?? o.planKey}</td>
      <td>${o.plan?.voice ? 'あり' : 'なし（データのみ）'}</td>
      <td>${dataRange(o)}</td>
      <td class="num">${yen(o.monthlySchedule?.[0]?.amount ?? null)}</td>
      <td class="num">${yen(o.adminFee)}</td>
      <td class="num m-v">${yen(o.effectiveMonthly)}</td>
      <td class="src">${raw(sources(o))}</td>
    </tr>`).join(''))}
  </tbody>
</table>
</div></div>`;
}

export function renderMobile(m, { siteName, siteUrl, breadcrumb }) {
  const voice = m.live.filter((o) => o.plan?.voice === true);
  const dataOnly = m.live.filter((o) => o.plan?.voice === false);
  const names = providerOrder(m.live).map(([, n]) => n);
  const dataOnlyNames = providerOrder(dataOnly).map(([, n]) => n);
  const pausedNames = providerOrder(m.paused).map(([, n]) => n);

  const crumb = breadcrumb([{ name: '実質月額', path: '/' }, { name: 'スマホ料金' }]);
  const body = html`
${raw(crumb.visible)}
<section class="hero">
  <p class="eyebrow">毎日自動で記録 ／ 最終更新 ${m.updatedAt ? jstDateTime(m.updatedAt) : '—'}</p>
  <h1>スマホ料金、毎月いくら？</h1>
  <p class="lead">公式サイトの料金と初期費用を毎日集め、<strong>3年（${HORIZON}か月）使ったときの1か月あたり</strong>に直しています。毎月使うデータ量ごとに、各社で当てはまるプランを並べました。</p>
</section>

<section class="block">
  <p class="scope">当サイトが記録しているのは <b>${names.length}社（${names.join('・')}）・${m.live.length}プラン</b>だけです。<strong>格安SIM全体の比較ではありません。</strong>${raw(pausedNames.length ? html`記録が止まっている${pausedNames.join('・')}の値は表に入れていません。` : '')}（${m.updatedAt ? jstDateTime(m.updatedAt) : '—'}時点）</p>
  <h2>音声通話つき：毎月使う量ごと</h2>
  <p class="note">各マスは、その量を使える<strong>その会社のプランのうち実質月額が低いもの</strong>です。会社どうしの順位は付けていません。</p>
  ${raw(matrix(voice, '音声通話つきプラン：毎月使う量ごとの実質月額'))}
</section>

${raw(dataOnly.length ? html`
<section class="block">
  <h2>データ通信のみ（電話番号なし）：毎月使う量ごと</h2>
  <p class="note">記録しているのは${dataOnlyNames.join('・')}だけです。</p>
  ${raw(matrix(dataOnly, 'データ通信のみのプラン：毎月使う量ごとの実質月額'))}
</section>` : '')}

<section class="block">
  <h2>記録している全プラン <span class="count">${m.live.length}件</span></h2>
  ${raw(allPlans(voice, `音声通話つき ${voice.length}件`))}
  ${raw(allPlans(dataOnly, `データ通信のみ ${dataOnly.length}件`))}
</section>

<section class="block">
  <h2>この数字の読み方</h2>
  <ul class="promises">
    <li><strong>実質月額</strong> = （毎月の料金 × ${HORIZON}か月 ＋ 初期費用）÷ ${HORIZON}。初期費用は契約事務手数料とSIMの発行料です。光回線と同じ<a href="/method/">計算式</a>で、工事費は0円です</li>
    <li><strong>キャンペーン・家族割・セット割は入れていません。</strong>乗り換えやエントリー、家族の契約などの条件があり、誰でも同じ額を受けられるとは限らないためです</li>
    <li>楽天モバイルは<strong>使った量で料金が決まる</strong>プラン、mineoは<strong>毎月の容量を選んで契約する</strong>プランです。表では「その量を使う月の料金」としてそろえています</li>
    <li><strong>通話料は金額に入れていません。</strong>かかり方（無料になる条件・かけ放題オプションなど）は会社ごとに違うので、電話をよく使う人は各社の料金ページで確かめてください。通信速度・つながる場所（回線）も比べていません</li>
    <li>取れなかった日を前日の値で埋めません。止まったら表から外し、止まったと書きます</li>
  </ul>
</section>
`;

  return {
    title: `スマホ料金を毎月使う量ごとに比較（${names.join('・')}）｜${siteName}`,
    description: `${names.join('・')}の公式サイトから料金と初期費用を毎日自動で集め、3年使ったときの1か月あたりの金額（実質月額）に換算。毎月使うデータ量ごとに当てはまるプランを並べています。出典と取得日時つき。`,
    canonical: `${siteUrl}/mobile/`,
    head: crumb.ld,
    body,
    updatedAt: m.updatedAt,
  };
}

/** llms.txt に足す節 */
export function mobileLlms(m) {
  if (!m.live.length) return '';
  const lines = [...m.live]
    .sort((a, b) => a.providerName.localeCompare(b.providerName, 'ja') || a.effectiveMonthly - b.effectiveMonthly)
    .map((o) => `- ${o.providerName} ${o.planLabel ?? o.planKey}: 実質月額 ${o.effectiveMonthly.toLocaleString('ja-JP')}円（毎月 ${o.monthlySchedule[0].amount.toLocaleString('ja-JP')}円・初期費用 ${o.adminFee.toLocaleString('ja-JP')}円、${HORIZON}か月換算、${o.observedAt.slice(0, 10)}時点、出典 ${o.sourceUrl}）`);
  return `\n## スマホ料金（/mobile/）\n\n記録しているのは ${providerOrder(m.live).map(([, n]) => n).join('・')} だけで、格安SIM全体の比較ではありません。キャンペーン・家族割は算入していません。\n\n${lines.join('\n')}\n`;
}
