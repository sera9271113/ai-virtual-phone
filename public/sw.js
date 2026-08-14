// public/sw.js
//
// CACHE_VERSION 不再手写死值。占位符 __CACHE_VERSION__ 会在构建时被
// scripts/inject-sw-version.mjs 自动替换成本次 Netlify 部署的唯一标识
// （COMMIT_REF / DEPLOY_ID，兜底用构建时间戳）。
//
// 这样每次部署版本号都会变化，activate 阶段会清掉上一个版本残留的
// RUNTIME_CACHE，不会再出现"浏览器里缓存的旧 chunk 和这次部署的新
// chunk 混在一起加载"导致的 ReferenceError（例如 onMenu is not defined）。
//
// 注意：如果你看到这个文件里 CACHE_VERSION 还是 "__CACHE_VERSION__"
// 字面量，说明构建时没有执行注入脚本，请检查 package.json 的 build 命令。
const CACHE_VERSION = "ai-phone-pwa-__CACHE_VERSION__";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          // 关键修复点：CACHE_VERSION 现在每次部署都不同，
          // 所以这里会把上一个版本的 STATIC_CACHE 和 RUNTIME_CACHE
          // 都清掉，而不是像之前那样让 RUNTIME_CACHE 跨部署一直存活。
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      ))
      // 刷新预缓存的 "/" 快照：它是离线导航的最终兜底，若停留在旧部署版本，
      // 引用的旧 hash CSS/JS 已 404，会渲染出无样式页面（文字堆在左上角）。
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.add(new Request("/", { cache: "reload" })).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    throw error;
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，每次部署 CACHE_VERSION 都会自动变化，
// 旧缓存会在 activate 时自动清空，不需要再手动改版本号。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
