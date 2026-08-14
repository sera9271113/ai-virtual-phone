// scripts/inject-sw-version.mjs
//
// 在 `next build` 之前运行：把 public/sw.js 里的占位符
// "__CACHE_VERSION__" 替换成本次构建的唯一标识。
//
// Netlify 在构建环境里会自动注入以下变量（不需要你手动配置）：
//   - COMMIT_REF   当前部署对应的 git commit SHA
//   - DEPLOY_ID    本次部署的唯一 ID
// 本地开发 / 其他平台没有这些变量时，回退用当前时间戳，
// 保证任何情况下都不会漏替换。
//
// 用法（已写进 package.json 的 build 脚本，不需要手动执行）：
//   node scripts/inject-sw-version.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.join(__dirname, "..", "public", "sw.js");

if (!existsSync(swPath)) {
  console.error(`[inject-sw-version] 找不到 ${swPath}，跳过。`);
  process.exit(0);
}

const version =
  process.env.COMMIT_REF?.slice(0, 12) ||
  process.env.DEPLOY_ID ||
  String(Date.now());

const original = readFileSync(swPath, "utf8");

if (!original.includes("__CACHE_VERSION__")) {
  console.warn(
    "[inject-sw-version] public/sw.js 里没有找到占位符 __CACHE_VERSION__，" +
      "可能已经被替换过一次，或者文件被改动过，请检查。"
  );
  process.exit(0);
}

const patched = original.replaceAll("__CACHE_VERSION__", version);
writeFileSync(swPath, patched, "utf8");

console.log(`[inject-sw-version] sw.js CACHE_VERSION 已设置为: ${version}`);
