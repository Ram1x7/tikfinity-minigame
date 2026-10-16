// URL の ?env= から、本番(prod)かテスト(test)かを決める。
// 事故防止のため、指定が無い場合はテストを使う。本番は ?env=prod と明示する。
import { isEnv } from '../shared/core.js';

export function getEnv() {
  const v = new URLSearchParams(location.search).get('env');
  return isEnv(v) ? v : 'test';
}

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
