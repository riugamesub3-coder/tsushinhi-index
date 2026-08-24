// html — HTMLの組み立て。テンプレートエンジンは使わない（依存を増やさない方針）。
//
// ★エスケープを1か所に閉じ込める。
//   料金データは自分で作った値だが、事業者名やプラン名は収集元の文字列が混ざる。
//   タグとして解釈されうる文字が来たときに壊れないよう、通す口を一本化する。

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** テキストとして埋め込む。必ずこれを通す */
export const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** 属性値として埋め込む */
export const attr = (s) => e(s);

/** タグ付きテンプレート。${} は自動でエスケープされる。生HTMLを入れたいときは raw() で包む */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v && v.__raw ? v.value : Array.isArray(v) ? v.map(toStr).join('') : e(v)) + strings[i + 1];
  }
  return out;
}

const toStr = (v) => (v && v.__raw ? v.value : e(v));

/** すでにHTMLになっているものを、そのまま入れる */
export const raw = (value) => ({ __raw: true, value });

/** JSON-LD を安全に埋め込む。</script> で閉じられるのを防ぐ */
export function jsonLd(obj) {
  const json = JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
  return raw(`<script type="application/ld+json">\n${json}\n</script>`);
}

/**
 * ページの外枠。
 * CSSは1枚を全ページで共有する（外部依存なし・キャッシュが効く）。
 */
export function layout({ title, description, canonical, siteUrl, bodyClass = '', head = '', body, updatedAt }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${attr(description)}">
<link rel="canonical" href="${attr(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/rss+xml" title="料金の変化" href="/feed.xml">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(description)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="通信費インデックス">
<meta name="twitter:card" content="summary">
${head}
</head>
<body class="${attr(bodyClass)}">
<header class="site-head">
  <a class="brand" href="/">通信費インデックス</a>
  <nav>
    <a href="/">実質月額</a>
    <a href="/changes/">料金の変化</a>
    <a href="/method/">計算方法</a>
    <a href="/data/">データを使う</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site-foot">
  <p>最終更新: <time datetime="${attr(updatedAt ?? '')}">${e(updatedAtLabel(updatedAt))}</time></p>
  <p>
    データは <a href="https://creativecommons.org/licenses/by/4.0/deed.ja" rel="license">CC BY 4.0</a>。
    出典を表示すれば自由にお使いいただけます。
    収集の仕組みは <a href="https://github.com/riugamesub3-coder/tsushinhi-index">GitHub で公開</a>しています。
  </p>
  <p class="disclaimer">
    自動収集のため誤りが含まれる可能性があります。<strong>契約前には必ず各社の公式サイトで最新の条件をご確認ください。</strong>
    掲載している値には出典URLと取得日時を併記しています。
  </p>
</footer>
</body>
</html>
`;
}

function updatedAtLabel(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}
