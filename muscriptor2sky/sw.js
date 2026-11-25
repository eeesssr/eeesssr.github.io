/* muscriptor2sky service worker
 * 作用：缓存 index.html / sky-core.js / manifest.webmanifest，让页面离线可用。
 * 注意：file:// 下 service worker 根本不会注册成功，注册代码在 index.html 里用 try/catch 静默失败。
 */
'use strict';

/* 改这个版本号即可让浏览器安装新 SW 并清掉旧缓存 */
var CACHE_VERSION = '1.5.0_web';
var CACHE_PREFIX = 'muscriptor2sky-cache-';
var CACHE_NAME = CACHE_PREFIX + 'v' + CACHE_VERSION;

/* 只缓存这三个静态资源，全部是相对路径，部署到任意子目录都能用 */
var PRECACHE = [
  './index.html',
  './sky-core.js',
  './manifest.webmanifest'
];

/* 离线时的兜底页面 */
var FALLBACK_URL = './index.html';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      /* 逐个 add，任何一个 404（例如 sky-core.js 还没写）都不能让整个安装失败 */
      return Promise.all(PRECACHE.map(function (url) {
        var req = new Request(url, { cache: 'reload' });
        return cache.add(req).then(function () {
          return null;
        }).catch(function () {
          return null;
        });
      }));
    }).then(function () {
      /* 新版本立即接管，不用等所有标签页关闭 */
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      /* 清理所有旧版本缓存，避免更新后还拿到旧文件 */
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME && key.indexOf(CACHE_PREFIX) === 0) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isSameOrigin(url) {
  try {
    return new URL(url, self.location.href).origin === self.location.origin;
  } catch (e) {
    return false;
  }
}

function putInCache(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return response;
  var copy = response.clone();
  caches.open(CACHE_NAME).then(function (cache) {
    cache.put(request, copy).catch(function () {});
  }).catch(function () {});
  return response;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (!isSameOrigin(request.url)) return;

  /* 页面导航：网络优先，离线时回退到缓存的 index.html */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        return putInCache(request, response);
      }).catch(function () {
        return caches.match(FALLBACK_URL).then(function (cached) {
          return cached || caches.match('./') || new Response(
            '<!DOCTYPE html><meta charset="utf-8"><title>离线</title><p>当前处于离线状态，且没有可用缓存。请联网后刷新一次。</p>',
            { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  /* 静态资源：缓存优先，命中不了再走网络并顺手缓存 */
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        return putInCache(request, response);
      }).catch(function () {
        return caches.match(FALLBACK_URL);
      });
    })
  );
});

/* 支持页面主动要求新 SW 立刻接管（可选，页面没用到也不影响） */
self.addEventListener('message', function (event) {
  var data = event.data;
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
