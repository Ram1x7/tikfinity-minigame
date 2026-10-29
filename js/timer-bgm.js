// 縛りタイマーのBGM。YouTubeは公式の「見える」埋め込みプレーヤーを使用する。
// PRISM/iPadでは自動再生がOSに拒否される場合がある。
import { youtubeVideoId } from '../shared/core.js';

export function createTimerBgmController(stage) {
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'none';
  const container = document.getElementById('timer-youtube-player');
  const mount = document.getElementById('timer-youtube-mount');
  let player = null;
  let loading = null;
  let selectedId = '';
  let selectedUrl = '';
  let failed = false;
  let lastState = null;
  let loadedVideoId = '';
  let lastVolume = -1;

  function ensureYoutube() {
    if (player || loading) return loading || Promise.resolve(player);
    loading = new Promise((resolve, reject) => {
      const ready = () => {
        try {
          loadedVideoId = youtubeVideoId(selectedUrl);
          player = new window.YT.Player(mount, {
            width: '320', height: '200',
            videoId: loadedVideoId,
            playerVars: { playsinline: 1, controls: 1, rel: 0, origin: location.origin },
            events: {
              onReady: () => { resolve(player); lastVolume = -1; sync(lastState); },
              onStateChange: (event) => {
                if (event.data === window.YT.PlayerState.ENDED && selectedId && !lastState?.paused) {
                  player.seekTo(0, true);
                  player.playVideo();
                }
              },
              onError: (event) => {
                failed = true;
                console.warn('YouTube動画を再生できません（埋め込み禁止や動画制限の可能性）', event.data);
              },
            },
          });
        } catch (error) { reject(error); }
      };
      if (window.YT?.Player) return ready();
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); ready(); };
      if (!document.querySelector('script[data-timer-youtube-api]')) {
        const script = document.createElement('script');
        script.dataset.timerYoutubeApi = '1';
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => reject(new Error('YouTube APIを読み込めません'));
        document.head.append(script);
      }
    }).catch((error) => { failed = true; console.warn(error); return null; });
    return loading;
  }

  function sync(current) {
    lastState = current;
    const active = (current?.entries || []).filter((x) => x.status === 'active' && x.bgmUrl && x.remainingMs > 0);
    const ongoing = active.find((x) => x.id === selectedId && x.bgmUrl === selectedUrl);
    const selected = ongoing || active.sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))[0];
    const nextId = selected?.id || '';
    const nextUrl = selected?.bgmUrl || '';
    const changed = nextId !== selectedId || nextUrl !== selectedUrl;
    if (changed) {
      audio.pause();
      player?.pauseVideo?.();
      selectedId = nextId;
      selectedUrl = nextUrl;
      failed = false;
    }
    const volume = Math.max(0, Math.min(100, Number(selected?.bgmVolume ?? 50)));
    audio.volume = volume / 100;
    if (player && lastVolume !== volume) {
      player.setVolume(volume);
      lastVolume = volume;
    }
    const ytId = youtubeVideoId(selectedUrl);
    container.hidden = !ytId;
    if (!selectedId) {
      audio.removeAttribute('src');
      audio.load();
      player?.stopVideo?.();
      return;
    }
    if (ytId) {
      audio.pause();
      if (!player) { ensureYoutube(); return; }
      if (loadedVideoId !== ytId) {
        loadedVideoId = ytId;
        player.loadVideoById(ytId);
      }
      if (current.paused) player.pauseVideo();
      else if (!failed && [window.YT.PlayerState.UNSTARTED, window.YT.PlayerState.PAUSED, window.YT.PlayerState.CUED].includes(player.getPlayerState())) player.playVideo();
      return;
    }
    player?.pauseVideo?.();
    if (changed) audio.src = selectedUrl;
    if (current.paused) audio.pause();
    else if (audio.paused && !failed) {
      const attemptedUrl = selectedUrl;
      audio.play().catch((error) => {
        if (attemptedUrl !== selectedUrl) return;
        failed = true;
        console.warn('PRISM/iPadが音声の自動再生を拒否しました', error);
      });
    }
  }
  stage.addEventListener('pointerdown', () => { failed = false; sync(lastState); });
  return { sync };
}
