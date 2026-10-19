// URL の ?env= から、本番(prod)かテスト(test)かを決める。
// 事故防止のため、指定が無い場合はテストを使う。本番は ?env=prod と明示する。
// プレビューサイト(本番以外の場所)では、?env=prod でも常にテストにする。
import { isEnv } from '../shared/core.js';
import { IS_PREVIEW_SITE } from './config.js';

export function getEnv() {
  if (IS_PREVIEW_SITE) return 'test';
  const v = new URLSearchParams(location.search).get('env');
  return isEnv(v) ? v : 'test';
}

/** 画面上部の環境の切り替えに出す環境(プレビューサイトではテストだけ) */
export const SELECTABLE_ENVS = IS_PREVIEW_SITE ? ['test'] : ['test', 'prod'];
export { IS_PREVIEW_SITE };

export function envLabel(env) {
  return env === 'prod' ? '本番' : 'テスト';
}

/** 現在のURLの env だけを差し替えたURL */
export function urlWithEnv(env, page = location.pathname) {
  const params = new URLSearchParams(location.search);
  params.set('env', env);
  return `${page}?${params.toString()}`;
}

/** 同じフォルダにある別ページの完全なURL */
export function pageUrl(file, params = {}) {
  const u = new URL(file, location.href);
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}
