// stale — 「その観測が更新停止中かどうか」の判定。
//
// ★2026-09-04 に build.mjs から出した。理由は、ここが**静かに間違っていた**から。
//   テストできない場所に置いてあるかぎり、間違いは次も気づかれない。

import { daysSince } from './format.mjs';

/**
 * 失敗は3段階で別々に記録される:
 *   prices:<url>         … 料金ページを取得できたか
 *   health:<url>         … 収集元が生きているか
 *   effective:<事業者ID>  … **取得したページから実質月額を算出できたか**
 *
 * ★以前は url で終わるキーしか見ていなかった。
 *   ページは取れているのにアダプタが値を作れない、という壊れ方をすると
 *   3つ目にだけ記録が付く。そこを見ていなかったため、
 *   **NURO光の算出が 2026-08-31 から4日間失敗しているのに、8/30の値が
 *   「更新停止中」の表示なしで、他社の最新値と並んで出ていた。**
 *
 * 複数の記録が該当するときは**いちばん古い（＝いちばん長く止まっている）ほう**を返す。
 * 新しいほうを返すと、止まっている期間を実際より短く見せてしまう。
 */
export function staleInfo(failures, url, providerId) {
  const src = failures?.sources ?? {};
  const cands = Object.entries(src)
    .filter(([k]) => (url && k.endsWith(url)) || (providerId && k === `effective:${providerId}`))
    .map(([, v]) => v)
    .filter((v) => v && v.staleSince);
  if (!cands.length) return null;
  const worst = cands.sort((a, b) => new Date(a.staleSince) - new Date(b.staleSince))[0];
  return { since: worst.staleSince, days: daysSince(worst.staleSince), consecutive: worst.consecutive };
}
