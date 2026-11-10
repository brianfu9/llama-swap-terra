import { defineConfig, type Plugin } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { compression } from "vite-plugin-compression2";
import path from "node:path";
import fs from "node:fs";

// KaTeX's CSS lists woff2/woff/ttf fallbacks per font-face, but browsers only
// ever fetch the first format they support (woff2, universally today) - the
// other two formats are never downloaded, they just bloat the build output
// (and the Go binary it's embedded into). Strip them at build time.
function stripKatexFontFallbacks(): Plugin {
  return {
    name: "strip-katex-font-fallbacks",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("katex.min.css")) return null;
      return code.replace(
        /url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
        'url($1) format("woff2")',
      );
    },
  };
}

// Already-compressed formats: re-compressing them wastes build time and only
// bloats the embedded assets with .gz/.br copies nobody benefits from.
// Already-compressed formats gain nothing from gzip/brotli, they just add dead
// weight to the Go binary these assets are embedded into.
const compressionExclude = [/\.(br|gz)$/, /\.(png|jpe?g|gif|webp|avif|ico)$/, /\.(woff2?)$/];

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    stripKatexFontFallbacks(),
    // The option is `algorithms` (plural) - the plugin ignores unknown keys and
    // silently runs both gzip and brotli, whose second pass also compresses
    // files the exclude filter already rejected.
    compression({
      algorithms: ["brotliCompress"],
      exclude: compressionExclude,
      threshold: 1024,
    }),
  ],
  // Relative base so the build works behind reverse proxies that serve
  // llama-swap under a path prefix (see lib/apiPath.ts); the server mounts
  // the UI at <prefix>/ui/ and the app uses hash routing, so the document
  // path is stable and relative asset URLs resolve correctly everywhere.
  base: "./",
  resolve: {
    alias: [
      { find: "$lib", replacement: path.resolve(__dirname, "./src/lib") },
      // The bare `svelte` specifier's exports map hands Node (and vitest) the
      // server entry, where mount() does not exist. The component tests mount
      // real UI, which needs the client entry, so pin the bare specifier there.
      // The regex is exact: a prefix alias would also rewrite `svelte/internal`.
      { find: /^svelte$/, replacement: path.resolve(__dirname, "node_modules/svelte/src/index-client.js") },
    ],
  },
  build: {
    outDir: "../internal/server/ui_dist",
    assetsDir: "assets",
    // The playground chunk (markdown/KaTeX/highlight.js) is deferred and
    // loaded only after initial mount, so its size doesn't affect first paint.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "happy-dom",
  },
  server: {
    // yes very insecure but who's running this thing
    // on the public internet for dev?! haha.
    host: "0.0.0.0",
    allowedHosts: true,
    // Browsers only allow the microphone (Playground > Realtime) on localhost
    // or https. To use it from another machine, point these at a cert/key.
    https:
      process.env.UI_DEV_TLS_CERT && process.env.UI_DEV_TLS_KEY
        ? { cert: fs.readFileSync(process.env.UI_DEV_TLS_CERT), key: fs.readFileSync(process.env.UI_DEV_TLS_KEY) }
        : undefined,
    proxy: Object.fromEntries(
      ["/api", "/logs", "/upstream", "/unload", "/v1", "/sdapi"].map((path) => [
        path,
        // ws: forwards websocket upgrades too, for /v1/realtime
        { target: process.env.LLAMA_SWAP_URL ?? "http://localhost:8080", ws: true },
      ]),
    ),
  },
});
