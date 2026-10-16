// worker/src と shared/core.js を1ファイルにまとめ、worker/dist/worker.js を作る。
// Cloudflare のダッシュボード(ブラウザのエディタ)にそのまま貼り付けられる形にするため。
//
//   node scripts/build-worker.mjs          生成
//   node scripts/build-worker.mjs --check  生成物が最新か確認(CI用)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['shared/core.js', 'worker/src/firebase.js', 'worker/src/index.js'];
const outPath = join(root, 'worker/dist/worker.js');

function strip(code) {
  return code
    // import 文(複数行を含む)を削除
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    // export default 以外の export キーワードを外す
    .replace(/^export\s+(?!default)/gm, '');
}

const parts = sources.map((p) => `// ---- ${p} ----\n${strip(readFileSync(join(root, p), 'utf8')).trim()}\n`);
const output = [
  '// このファイルは scripts/build-worker.mjs が自動生成しています。直接編集しないでください。',
  '// Cloudflare ダッシュボードの Worker エディタに、このファイルの中身をすべて貼り付けて使います。',
  '',
  ...parts,
].join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(outPath, 'utf8'); } catch { /* 未生成 */ }
  if (current !== output) {
    console.error('worker/dist/worker.js が古くなっています。node scripts/build-worker.mjs を実行してください。');
    process.exit(1);
  }
  console.log('worker/dist/worker.js は最新です');
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log('生成しました: worker/dist/worker.js');
}
