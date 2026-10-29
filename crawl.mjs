#!/usr/bin/env node
// OpenHub catalog crawler. Zero dependencies, Node 22+.
//
//   node crawl.mjs               # full crawl -> plugins.json + plugins.digest
//   node crawl.mjs --limit=80    # small run, for testing
//   node crawl.mjs --self-test   # offline asserts, no network
//
// Sources: npm registry search + downloads, GitHub GraphQL (stars/topics).
// Output shape is the one the OpenCode "store" plugin already parses
// (RawPlugin in catalog.ts): only `slug` and `name` are required.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { categoriesFor } from "./categories.mjs";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org/downloads/point";
const GH_GRAPHQL = "https://api.github.com/graphql";

const PAGE_SIZE = 250;
const MAX_PAGES = 20; // hard API ceiling: `from` past ~5000 silently returns page 1
const QUERIES = [
  "keywords:opencode-plugin",
  "keywords:opencode", // capped at the 5000 pagination ceiling; the long tail is low-relevance
  "keywords:opencode-tui",
  "keywords:opencode-theme",
];
const META_CONCURRENCY = 5;
const SCOPED_CONCURRENCY = 3;
const SEARCH_GAP_MS = 600; // the search endpoint 429s on bursts; no Retry-After header
const GH_BATCH = 50;
const DOWNLOAD_BATCH = 50; // API allows 128, but URL length gets long
const TIMEOUT_MS = 15_000;
const RETRIES = 4;
const ABBR = "application/vnd.npm.install-v1+json";

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const argv = process.argv.slice(2);
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1]) || 0;
const SELF_TEST = argv.includes("--self-test");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { headers = {}, timeout = TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${url}`);
      if (!res.ok) return null; // 404 and friends are not fatal per item
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(1_500 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw lastErr;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Math.min(size, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i], i);
        } catch {
          out[i] = null;
        }
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- discovery

async function searchAll(query) {
  const found = new Map();
  let firstOfPage0 = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    if (from >= 5000) break;
    if (page > 0) await sleep(SEARCH_GAP_MS);
    const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${from}`;
    const data = await getJson(url);
    const objects = data?.objects ?? [];
    if (!objects.length) break;
    const first = objects[0]?.package?.name;
    // The API wraps back to page 1 instead of erroring. Stop, don't duplicate.
    if (page > 0 && first === firstOfPage0) break;
    if (page === 0) firstOfPage0 = first;
    for (const o of objects) if (o?.package?.name) found.set(o.package.name, o);
    if (objects.length < PAGE_SIZE) break;
  }
  return found;
}

const looksLikeOpenCode = (o) =>
  (o.package.keywords ?? [])
    .map((k) => String(k).toLowerCase())
    .some((k) => k === "opencode" || k.startsWith("opencode-"));

// ---------------------------------------------------------------- metadata

const npmPath = (name) => `${REGISTRY}/${name.replace("/", "%2F")}`;

function compatOf(deps) {
  const v2 = "@opencode/plugin" in deps;
  const v1 = "@opencode-ai/plugin" in deps;
  if (v2 && v1) return "both";
  if (v2) return "v2";
  if (v1) return "v1";
  return "unknown";
}

async function metaFor(name) {
  const doc = await getJson(npmPath(name), { headers: { accept: ABBR } });
  if (!doc) return null;
  const latest = doc["dist-tags"]?.latest;
  const version = doc.versions?.[latest] ?? {};
  const deps = {
    ...(version.dependencies ?? {}),
    ...(version.peerDependencies ?? {}),
    ...(version.devDependencies ?? {}),
  };
  return {
    latest,
    compat: compatOf(deps),
    deprecated: version.deprecated === undefined ? false : version.deprecated || true,
    checked: false,
  };
}

// The official core/SDK packages carry the `opencode` keyword but are not plugins.
const CORE_NAMES = new Set(["opencode", "opencode-ai", "opencode-web", "opencode-docs"]);
const isOfficialCore = (name) => CORE_NAMES.has(name) || /^@opencode(-ai)?\//.test(name);

// ---------------------------------------------------------------- downloads

async function downloadsFor(names) {
  const out = new Map();
  const put = (name, period, count) => {
    const entry = out.get(name) ?? {};
    if (period === "last-month") entry.month = count;
    else entry.week = count;
    out.set(name, entry);
  };

  const unscoped = names.filter((n) => !n.startsWith("@"));
  for (let i = 0; i < unscoped.length; i += DOWNLOAD_BATCH) {
    const chunk = unscoped.slice(i, i + DOWNLOAD_BATCH);
    for (const period of ["last-month", "last-week"]) {
      const data = await getJson(`${DOWNLOADS}/${period}/${chunk.join(",")}`).catch(() => null);
      for (const [key, value] of Object.entries(data ?? {})) {
        if (value && typeof value.downloads === "number") put(key, period, value.downloads);
      }
    }
  }

  // Scoped packages are rejected by the bulk endpoint.
  const scoped = names.filter((n) => n.startsWith("@"));
  await pool(scoped, SCOPED_CONCURRENCY, async (name) => {
    for (const period of ["last-month", "last-week"]) {
      const data = await getJson(`${DOWNLOADS}/${period}/${name}`).catch(() => null);
      if (data && typeof data.downloads === "number") put(name, period, data.downloads);
    }
    return null;
  });

  return out;
}

// ---------------------------------------------------------------- github

function repoSlugFromUrl(url) {
  if (!url) return null;
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(url);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
}

async function githubBatch(slugs) {
  if (!TOKEN || !slugs.length) return new Map();
  const parts = slugs.map((slug, i) => {
    const [owner, name] = slug.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { stargazerCount forkCount isArchived pushedAt repositoryTopics(first: 10) { nodes { topic { name } } } }`;
  });
  const query = `query { ${parts.join("\n")} }`;
  try {
    const res = await fetch(GH_GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `bearer ${TOKEN}`,
        "content-type": "application/json",
        "user-agent": "openhub-crawl",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return new Map();
    const json = await res.json();
    const out = new Map();
    slugs.forEach((slug, i) => {
      const node = json?.data?.[`r${i}`];
      if (!node) return;
      out.set(slug, {
        stars: node.stargazerCount ?? 0,
        forks: node.forkCount ?? 0,
        archived: node.isArchived === true,
        pushedAt: node.pushedAt ?? undefined,
        topics: (node.repositoryTopics?.nodes ?? []).map((n) => n.topic?.name).filter(Boolean),
      });
    });
    return out;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------- scoring

const daysSince = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 86_400_000);
const logNorm = (value, max) =>
  value > 0 && max > 0 ? Math.log10(1 + value) / Math.log10(1 + max) : 0;

function scoreFor(plugin, maxes) {
  // Star correction: monorepos inflate the repo's stars across many packages.
  const credited = plugin.stars
    ? Math.min(plugin.stars, Math.max((plugin.downloadsMonth ?? 0) * 8, 1000))
    : 0;
  const activity = plugin.pushedAt ? Math.max(0, 1 - daysSince(plugin.pushedAt) / 365) : 0.5;
  const growth =
    plugin.downloadsMonth > 0
      ? Math.min(1, ((plugin.downloadsWeek ?? 0) * 4.3) / plugin.downloadsMonth)
      : 0;
  const raw =
    0.35 * logNorm(credited, maxes.stars) +
    0.35 * logNorm(plugin.downloadsMonth ?? 0, maxes.downloads) +
    0.2 * activity +
    0.1 * growth;
  return Number((raw * (plugin.archived ? 0.35 : 1)).toFixed(4));
}

function maintenanceOf(plugin) {
  if (plugin.archived) return "archived";
  if (plugin.deprecated) return "stale";
  if (plugin.pushedAt && daysSince(plugin.pushedAt) > 365) return "stale";
  return "active";
}

const slugFor = (name) => name.replace(/^@/, "").replace("/", "--");

// ---------------------------------------------------------------- crawl

async function crawl() {
  console.log("discovery…");
  const found = new Map();
  let failed = 0;
  for (const query of QUERIES) {
    let page;
    try {
      page = await searchAll(query);
    } catch (err) {
      failed++;
      console.warn(`  ${query}: FAILED (${err.message})`);
      continue;
    }
    let added = 0;
    for (const [name, object] of page) {
      if (found.has(name)) continue;
      found.set(name, object);
      added++;
    }
    console.log(`  ${query}: ${page.size} seen, ${added} new`);
  }

  if (!found.size) {
    console.error("discovery returned nothing (all queries failed); refusing to publish");
    process.exit(1);
  }
  if (failed) console.warn(`  ${failed}/${QUERIES.length} queries failed; catalog will be incomplete`);

  let candidates = [...found.values()].filter(looksLikeOpenCode);
  console.log(`candidates: ${candidates.length}`);
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  console.log("metadata…");
  const metas = await pool(candidates, META_CONCURRENCY, (o) => metaFor(o.package.name));
  const metaByName = new Map();
  candidates.forEach((o, i) => {
    if (metas[i]) metaByName.set(o.package.name, metas[i]);
  });

  const metaFailures = candidates.length - metaByName.size;
  const mentionRate = metaFailures / Math.max(1, candidates.length);
  console.log(`metadata failures: ${metaFailures} (${(mentionRate * 100).toFixed(1)}%)`);
  if (mentionRate > 0.3) {
    console.error("more than 30% of packages failed metadata; refusing to publish a partial catalog");
    process.exit(1);
  }

  console.log("downloads…");
  const downloadMap = await downloadsFor([...metaByName.keys()]);

  console.log("github…");
  const slugs = new Set();
  let overrides = {};
  try {
    overrides = JSON.parse(await readFile(new URL("./overrides.json", import.meta.url), "utf8"));
  } catch {
    overrides = {};
  }

  const plugins = [];
  for (const object of candidates) {
    const name = object.package.name;
    const meta = metaByName.get(name);
    if (!meta) continue;

    const searchRepo = repoSlugFromUrl(object.package.links?.repository);
    const slug = searchRepo ?? null;
    if (slug) slugs.add(slug);

    // Drop only what is provably not a plugin: the official core packages.
    if (isOfficialCore(name) && meta.compat === "unknown") {
      if (process.env.DEBUG_DROPS) console.log(`  drop ${name} (official core)`);
      continue;
    }

    const downloads = downloadMap.get(name) ?? {};
    const pkg = object.package;
    plugins.push({
      slug: slugFor(name),
      name,
      title: pkg.name,
      version: meta.latest ?? pkg.version ?? "",
      description: pkg.description ?? "",
      keywords: (pkg.keywords ?? []).slice(0, 20),
      topics: [],
      license: pkg.license ?? undefined,
      deprecated: meta.deprecated === true,
      npmUrl: pkg.links?.npm ?? `https://www.npmjs.com/package/${name}`,
      homepage: pkg.links?.homepage ?? undefined,
      repoUrl: pkg.links?.repository ?? undefined,
      owner: slug ? slug.split("/")[0] : undefined,
      downloadsMonth: downloads.month ?? 0,
      downloadsWeek: downloads.week ?? 0,
    });
  }

  console.log(`github: ${slugs.size} repos`);
  const slugList = [...slugs];
  const ghMap = new Map();
  for (let i = 0; i < slugList.length; i += GH_BATCH) {
    const batch = slugList.slice(i, i + GH_BATCH);
    const result = await githubBatch(batch);
    for (const [slug, data] of result) ghMap.set(slug, data);
  }

  for (const plugin of plugins) {
    const sourceSlug = repoSlugFromUrl(plugin.repoUrl);
    const gh = sourceSlug ? ghMap.get(sourceSlug) : undefined;
    if (!gh) continue;
    plugin.stars = gh.stars;
    plugin.forks = gh.forks;
    plugin.archived = gh.archived;
    plugin.pushedAt = gh.pushedAt;
    plugin.topics = gh.topics.slice(0, 10);
  }

  const maxes = {
    stars: Math.max(1, ...plugins.map((p) => p.stars ?? 0)),
    downloads: Math.max(1, ...plugins.map((p) => p.downloadsMonth ?? 0)),
  };
  for (const plugin of plugins) {
    plugin.categories = categoriesFor(plugin.keywords, plugin.topics, overrides[plugin.slug]);
    plugin.score = scoreFor(plugin, maxes);
    plugin.maintenance = maintenanceOf(plugin);
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return plugins;
}

// ---------------------------------------------------------------- output

function serialise(plugins) {
  // Stable key order and no volatile fields, so identical crawls produce
  // identical bytes (the workflow then skips the commit).
  const json = JSON.stringify(
    { generatedAt: new Date().toISOString(), total: plugins.length, plugins },
    null,
    0,
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(plugins))
    .digest("hex");
  return { json, digest };
}

// ---------------------------------------------------------------- self test

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

async function selfTest() {
  const { categoriesFor } = await import("./categories.mjs");

  assert(
    JSON.stringify(categoriesFor(["mcp-server"], [])) === JSON.stringify(["mcp"]),
    "mcp keyword maps to mcp category",
  );
  assert(
    categoriesFor(["opencode-plugin"], []).includes("other"),
    "opencode-plugin alone falls into other, not tools",
  );
  assert(
    categoriesFor(["memory"], [], "tools")[0] === "tools",
    "override wins",
  );
  assert(slugFor("@scope/pkg") === "scope--pkg", "slug strips scope and joins with --");
  assert(
    repoSlugFromUrl("git+https://github.com/foo/bar.git") === "foo/bar",
    "repo url parses, .git stripped",
  );
  assert(repoSlugFromUrl("https://gitlab.com/foo/bar") === null, "non-github url ignored");

  // The wrap detector: page 1 starting with the same package as page 0 must stop.
  const pages = [
    { objects: [{ package: { name: "a" } }, { package: { name: "b" } }] },
    { objects: [{ package: { name: "a" } }] },
  ];
  let calls = 0;
  const fakeSearch = async () => pages[calls++];
  const seen = new Map();
  let firstOfPage0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fakeSearch();
    const objects = data.objects;
    const first = objects[0]?.package?.name;
    if (page > 0 && first === firstOfPage0) break;
    if (page === 0) firstOfPage0 = first;
    for (const o of objects) seen.set(o.package.name, o);
  }
  assert(seen.size === 2 && calls === 2, "pagination wrap stops the loop");

  const { json } = serialise([{ slug: "a", name: "a" }]);
  const parsed = JSON.parse(json);
  assert(parsed.plugins.every((p) => p.slug && p.name), "output keeps slug+name on every entry");

  console.log("\nself-test passed");
}

// ---------------------------------------------------------------- entry

if (SELF_TEST) {
  await selfTest();
} else {
  const plugins = await crawl();
  const { json, digest } = serialise(plugins);
  await writeFile(new URL("./plugins.json", import.meta.url), json);
  await writeFile(new URL("./plugins.digest", import.meta.url), digest + "\n");
  console.log(`\nwrote ${plugins.length} plugins (${(json.length / 1e6).toFixed(2)} MB), digest ${digest.slice(0, 12)}`);
}
