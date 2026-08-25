// format — 表示のための変換だけを持つ。ここで値を作らない。
//
// ★原則: **表示は data/ の値をそのまま出す。** 丸めも補完もここではしない。
//   実質月額の丸め（四捨五入）は collect/lib/effective.mjs で済んでいる。
//   表示側で二重に加工すると、サイトの数字とデータの数字が食い違う。

export const yen = (n) => (n == null ? '—' : `${n.toLocaleString('ja-JP')}円`);

/**
 * 読者に見せるプラン名。
 *
 * ★`planKey` は**識別子**で、変化検知が前回と突き合わせる鍵。これを変えると
 *   「プランが廃止されて別のプランが登場した」という誤報になるので、いったん決めたら変えない。
 *   一方、収集を進めるうちに「実はこれは So-net 光 M だった」のように
 *   **正しい呼び名が後から分かる**ことがある。そのとき直すのは表示だけ。
 *   → 識別（planKey）と表示（planLabel）を分ける。planLabel が無ければ planKey をそのまま出す。
 */
export const planName = (o) => o.planLabel ?? o.planKey;

export const yenSigned = (n) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('ja-JP')}円`;

/** ISO文字列を「2026年8月24日 11:55」にする。時点の明示は必須なので時刻まで出す */
export function jstDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
  return p;
}

/** ISO文字列を「2026-08-24」にする（machine readable 用） */
export function isoDate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

export function jstDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date(iso));
}

/** いま何日前か。「更新停止中◯日」の表示に使う */
export function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  return Math.floor((now - new Date(iso)) / 86400000);
}

/** URLからホスト名だけ取り出す（出典表示を短くするため。リンク先はフルURLのまま） */
export function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
