// ============================================================
// js/text.js  日本語を文節に近い単位で折り返すための小物(画像テーマ用)
// ------------------------------------------------------------
// CSS の word-break: auto-phrase は Chrome だけの機能で、iPad の PRISM LIVE(WebKit)では
// 1文字ずつ折り返してしまう(「リクエス/ト」など)。そこで、ブラウザに入っている
// Intl.Segmenter で単語に分け、助詞・送り仮名・句読点・1文字の語を前の語につなげて
// 文節に近いまとまりを作り、まとまりの間にだけ <wbr>(折り返してよい位置)を入れる。
// CSS 側は word-break: keep-all にして、<wbr> と空白以外では折り返さないようにする。
// Intl.Segmenter が無い古いブラウザでは、何もしない(従来どおりの折り返し)。
// ============================================================

const HIRAGANA = /^[ぁ-ゟー]+$/;      // ひらがな(と長音)だけの語: 助詞・送り仮名など
const OPENING = /^[「『（(【〈《［\[｛{〔"'“‘]+$/; // 開き括弧: 次の語にくっつける
const DIGITS = /^[0-9０-９]+$/;

let segmenter;
function getSegmenter() {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/**
 * 文字列を、折り返してよい位置で区切ったまとまりの配列にする。
 * つなげると元の文字列に戻る。Intl.Segmenter が無ければ null。
 */
export function phrases(text) {
  const seg = getSegmenter();
  const s = String(text ?? '');
  if (!seg || !s) return null;
  const out = [];
  let glueNext = false; // 開き括弧の後は次の語とつなげる
  let prevDigits = false;
  for (const { segment, isWordLike } of seg.segment(s)) {
    const last = out.length - 1;
    if (!isWordLike) {
      if (OPENING.test(segment)) {
        // 開き括弧は新しいまとまりの頭にする
        if (last >= 0 && !glueNext) out.push(segment);
        else if (last >= 0) out[last] += segment;
        else out.push(segment);
        glueNext = true;
      } else if (last >= 0) {
        out[last] += segment; // 句読点・閉じ括弧・空白は前につなげる(空白の後では折り返せる)
        glueNext = false;
      } else {
        out.push(segment);
      }
      prevDigits = false;
      continue;
    }
    const isDigits = DIGITS.test(segment);
    const prevChar = last >= 0 ? out[last].slice(-1) : '';
    const join = last >= 0 && (
      glueNext
      // 助詞・送り仮名(の・を・したら・する…)。ただし助詞の後に続く長いひらがなの語(あいさつ等)は新しいまとまり
      || (HIRAGANA.test(segment) && ([...segment].length <= 3 || !HIRAGANA.test(prevChar)))
      || (!isDigits && [...segment].length === 1) // 1文字の語(者・分・匹・つ…)。数字は前につなげない
      || (prevDigits && !isDigits)               // 数字の後の単位
      || (isDigits && /[×x＋+#＃]$/.test(prevChar)) // 「×2」「#3」は離さない
    ) && !/\s$/.test(out[last]);
    if (join) out[last] += segment;
    else out.push(segment);
    glueNext = false;
    prevDigits = isDigits;
  }
  return out;
}

/**
 * 要素の中身を、まとまりの間に <wbr> を入れた文字にする。
 * 分けられない環境では textContent をそのまま入れる(class も付けない)。
 */
export function setPhrased(el, text) {
  const list = phrases(text);
  el.classList.toggle('phrased', Boolean(list));
  if (!list) {
    el.textContent = String(text ?? '');
    return;
  }
  const nodes = [];
  list.forEach((p, i) => {
    if (i > 0) nodes.push(document.createElement('wbr'));
    nodes.push(document.createTextNode(p));
  });
  el.replaceChildren(...nodes);
}
