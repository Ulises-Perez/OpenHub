// Sanity-checks the published catalog. Run after crawl.mjs: node verify.mjs
import { readFile } from "node:fs/promises";

const fail = [];
const warn = [];
const ok = (condition, message) => (condition ? null : fail.push(message));

const raw = JSON.parse(await readFile(new URL("./plugins.json", import.meta.url), "utf8"));
const plugins = Array.isArray(raw) ? raw : raw.plugins;
if (!Array.isArray(plugins)) throw new Error("no plugins array");

const seenSlug = new Map();
const seenName = new Map();
for (const p of plugins) {
  ok(typeof p.slug === "string" && p.slug.length > 0, `entry without slug: ${p.name}`);
  ok(typeof p.name === "string" && p.name.length > 0, `entry without name: ${JSON.stringify(p).slice(0, 80)}`);
  ok(typeof p.version === "string" && /^\d/.test(p.version), `bad version for ${p.name}: ${p.version}`);
  ok(Array.isArray(p.categories) && p.categories.length > 0, `no categories for ${p.name}`);
  if (seenSlug.has(p.slug)) warn.push(`slug collision: ${p.slug} (${seenSlug.get(p.slug)} vs ${p.name})`);
  else seenSlug.set(p.slug, p.name);
  if (seenName.has(p.name)) fail.push(`duplicate name: ${p.name}`);
  seenName.set(p.name, true);
}

const count = (fn) => plugins.reduce((acc, p) => acc.set(fn(p), (acc.get(fn(p)) ?? 0) + 1), new Map());
const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

const withStars = plugins.filter((p) => typeof p.stars === "number" && p.stars > 0).length;
const withDownloads = plugins.filter((p) => p.downloadsMonth > 0).length;
const deprecated = plugins.filter((p) => p.deprecated).length;

ok(plugins.length > 2500, `only ${plugins.length} plugins: discovery probably broke`);
ok(withDownloads / plugins.length > 0.5, `only ${withDownloads} have downloads`);
if (withStars / plugins.length < 0.4) warn.push(`only ${withStars} have stars: run with GITHUB_TOKEN`);
if (plugins.length < 2000) warn.push(`${plugins.length} plugins: menos plugins de los esperados`);

console.log(`plugins: ${plugins.length}`);
console.log(`with stars: ${withStars} (${((withStars / plugins.length) * 100).toFixed(0)}%)`);
console.log(`with downloads: ${withDownloads} (${((withDownloads / plugins.length) * 100).toFixed(0)}%)`);
console.log(`deprecated: ${deprecated}`);
console.log(`maintenance: ${top(count((p) => p.maintenance)).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`compat: ${top(count((p) => p.compat ?? "none")).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`categories: ${top(count((p) => p.categories[0])).map(([k, v]) => `${k}=${v}`).join(" ")}`);

for (const w of warn) console.warn(`warn: ${w}`);
for (const f of fail.slice(0, 10)) console.error(`FAIL: ${f}`);
if (fail.length > 10) console.error(`... ${fail.length - 10} more failures`);
process.exit(fail.length ? 1 : 0);
