// chart — 実質月額の推移を素のSVGで描く。ライブラリは使わない（依存を増やさない方針）。
//
// ★折れ線ではなく**階段（step）**で描く。
//   料金は「連続的に少しずつ動く」ものではなく、改定された日に飛ぶ。
//   直線で結ぶと、実際には存在しなかった中間の値がグラフ上に生まれる。
//   それは「データに嘘を作らない」に反する。
//
// ★点が1つしかないとき（＝まだ変化を検知していないとき）は線を描かない。
//   横一直線を引くと「その期間ずっとこの値だった」という、確かめていないことを主張してしまう。

const W = 720, H = 220;
const PAD = { top: 16, right: 16, bottom: 30, left: 56 };

/**
 * @param points [{ at: ISO文字列, value: 数値 }...] 階段の角だけ
 * @returns SVG文字列。描けないときは null
 */
export function stepChart(points, { label = '実質月額' } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (!(x1 > x0)) return null;

  // 縦軸は0起点にしない。数百円の動きが潰れて見えなくなる。
  // そのかわり**軸の数字を必ず書く**ので、誤読しようがない。
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = Math.max(hi - lo, 100);
  const yLo = lo - span * 0.25, yHi = hi + span * 0.25;

  const px = (t) => PAD.left + ((t - x0) / (x1 - x0)) * (W - PAD.left - PAD.right);
  const py = (v) => PAD.top + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

  // 階段: 次の点まで同じ高さで進み、そこで垂直に上下する
  let d = `M ${px(xs[0]).toFixed(1)} ${py(ys[0]).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${px(xs[i]).toFixed(1)} ${py(ys[i - 1]).toFixed(1)}`;
    d += ` L ${px(xs[i]).toFixed(1)} ${py(ys[i]).toFixed(1)}`;
  }

  const gridY = [hi, lo].map((v) => `
    <line x1="${PAD.left}" y1="${py(v).toFixed(1)}" x2="${W - PAD.right}" y2="${py(v).toFixed(1)}" class="c-grid"/>
    <text x="${PAD.left - 8}" y="${(py(v) + 4).toFixed(1)}" class="c-ylab">${yen(v)}</text>`).join('');

  // 変化した点だけ丸を打つ（最初と最後は観測の端なので打たない）
  const dots = points.slice(1, -1).map((p) =>
    `<circle cx="${px(new Date(p.at).getTime()).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="3.5" class="c-dot"/>`).join('');

  const xlab = [
    `<text x="${PAD.left}" y="${H - 8}" class="c-xlab">${date(points[0].at)}</text>`,
    `<text x="${W - PAD.right}" y="${H - 8}" class="c-xlab" text-anchor="end">${date(points[points.length - 1].at)}</text>`,
  ].join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}の推移（${yen(lo)}〜${yen(hi)}）" preserveAspectRatio="xMidYMid meet">
  ${gridY}
  <path d="${d}" class="c-line"/>
  ${dots}
  ${xlab}
</svg>`;
}

const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const date = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(iso));

export const CHART_CSS = `
.chart{width:100%;height:auto;max-width:720px;margin:.5rem 0 1rem;overflow:visible}
.c-grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 3}
.c-line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round}
.c-dot{fill:var(--accent)}
.c-ylab{fill:var(--muted);font-size:11px;text-anchor:end}
.c-xlab{fill:var(--muted);font-size:11px}
`;
