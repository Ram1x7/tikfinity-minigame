// 日本語の折り返し位置(js/text.js)。iPad の WebKit でも文節に近いまとまりで折り返すため
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phrases } from '../js/text.js';

test('phrases: 助詞・送り仮名・1文字の語・数字と単位を前後につなげる', () => {
  assert.deepEqual(phrases('視聴者のリクエストを1つ実行'), ['視聴者の', 'リクエストを', '1つ', '実行']);
  assert.deepEqual(phrases('魚を3匹釣るまで他の行動禁止'), ['魚を', '3匹', '釣るまで', '他の', '行動', '禁止']);
  assert.deepEqual(phrases('料理を1品作って住民にプレゼント'), ['料理を', '1品作って', '住民に', 'プレゼント']);
  const long = phrases('次の15分はコメントで指示された場所へ移動し、到着したら住民全員にあいさつする');
  assert.ok(long.includes('15分は') && long.includes('指示された') && long.includes('移動し、') && long.includes('あいさつする'), long.join('/'));
});

test('phrases: 括弧・記号・英語', () => {
  assert.deepEqual(phrases('「おまかせ」で選ぶ'), ['「おまかせ」で', '選ぶ']);
  assert.equal(phrases('Finger Heart ×2').at(-1), 'Heart ×2', '「×2」は離さない');
  assert.deepEqual(phrases('ガーデニング'), ['ガーデニング']);
});

test('phrases: つなげると元の文字列に戻る', () => {
  for (const t of ['視聴者のリクエストを1つ実行', '「A」と B、C。', 'とても長いお名前のテストユーザーさま', '😀絵文字も👍OK']) {
    assert.equal(phrases(t).join(''), t);
  }
  assert.equal(phrases(''), null);
});
