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
let chartSeq = 0;

export function stepChart(points, { label = '実質月額' } = {}) {
  const gid = `cg${++chartSeq}`;
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

  // 線の下を薄く塗る。階段の形をそのまま閉じるので、塗りが線と食い違わない
  const base = (H - PAD.bottom).toFixed(1);
  const area = `${d} L ${px(xs[xs.length - 1]).toFixed(1)} ${base} L ${px(xs[0]).toFixed(1)} ${base} Z`;

  // 変化した点だけ丸を打つ（最初と最後は観測の端なので打たない）
  const dots = points.slice(1, -1).map((p) =>
    `<circle cx="${px(new Date(p.at).getTime()).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="3.5" class="c-dot"/>`).join('');

  const xlab = [
    `<text x="${PAD.left}" y="${H - 8}" class="c-xlab">${date(points[0].at)}</text>`,
    `<text x="${W - PAD.right}" y="${H - 8}" class="c-xlab" text-anchor="end">${date(points[points.length - 1].at)}</text>`,
  ].join('');

  // 最後の点を強調する。いまいくらかが、線のどこかではなく一目で分かるように
  const lastX = px(xs[xs.length - 1]), lastY = py(ys[ys.length - 1]);
  const up = ys[ys.length - 1] > ys[0];

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}の推移（${yen(lo)}〜${yen(hi)}）" preserveAspectRatio="xMidYMid meet">
  <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" class="c-g0"/><stop offset="100%" class="c-g1"/>
  </linearGradient></defs>
  ${gridY}
  <path d="${area}" class="c-area" fill="url(#${gid})"/>
  <path d="${d}" class="c-line"/>
  <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5" class="c-now"/>
  <text x="${(lastX - 8).toFixed(1)}" y="${(lastY - 12).toFixed(1)}" class="c-nowlab ${up ? 'up' : 'down'}">${yen(ys[ys.length - 1])}</text>
  ${dots}
  ${xlab}
</svg>`;
}

const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
const date = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(iso));

export const CHART_CSS = `
.chart-card{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);
  box-shadow:var(--shadow);padding:1rem 1.1rem .6rem;margin:1rem 0}
.chart{width:100%;height:auto;display:block;overflow:visible}
.c-grid{stroke:var(--line);stroke-width:1;stroke-dasharray:3 3}
.c-line{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.c-area{stroke:none}
.c-g0{stop-color:var(--accent);stop-opacity:.20}
.c-g1{stop-color:var(--accent);stop-opacity:.05}
.c-dot{fill:var(--bg);stroke:var(--accent);stroke-width:2}
.c-now{fill:var(--accent);stroke:var(--bg);stroke-width:2}
.c-nowlab{font-size:12px;font-weight:700;text-anchor:end;fill:var(--fg)}
.c-ylab{fill:var(--muted);font-size:11px;text-anchor:end}
.c-xlab{fill:var(--muted);font-size:11px}
`;
