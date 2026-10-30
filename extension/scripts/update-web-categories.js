#!/usr/bin/env node
/**
 * Builds the category web-filter rulesets: rulesets/<category>.json (Chrome declarativeNetRequest
 * static rules), rulesets/meta.json and rulesets/LICENSE-DATA.md.
 *
 *   node scripts/update-web-categories.js                    download the current lists and rebuild
 *   node scripts/update-web-categories.js --only a,b         download and rebuild only these categories
 *   node scripts/update-web-categories.js --additions-only   re-apply only AgentShield's own additions
 *
 * Categories and sources are defined in src/shared/web-categories.json; AgentShield's own extra domains
 * and site-name patterns in src/shared/web-category-additions.json (rule ids from 1000). Downloaded text is treated
 * as untrusted data: only lines that are valid hostnames are kept, and never-block domains (and their
 * subdomains) are removed so a list mistake cannot break Google, Microsoft, the AI sites, etc.
 * Run it before a release; the rulesets ship inside the extension and update with it.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'shared', 'web-categories.json'), 'utf8'));
const outDir = path.join(root, 'rulesets');

const CHUNK = 10000; // domains per rule (keeps each rule a manageable size)

/** A source is a HaGeZi file name (under source_base) or a full https:// address (UT1 lists). */
function sourceUrl(source) {
  return /^https:\/\//.test(source) ? source : config.source_base + source;
}
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function isProtected(host, protectedList) {
  return protectedList.some((p) => host === p || host.endsWith('.' + p));
}

/** Pure: list text -> sorted unique valid hostnames, minus protected ones. Exported for tests. */
function parseList(text, protectedList) {
  const kept = new Set();
  let removed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const host = line.replace(/^\*\./, '').replace(/\.$/, '');
    if (!HOST.test(host)) continue;
    if (isProtected(host, protectedList)) {
      removed++;
      continue;
    }
    kept.add(host);
  }
  return { domains: [...kept].sort(), removed };
}

/** Pure: domains -> DNR rules that send matching pages to the extension's block page. */
function buildRules(category, domains) {
  const rules = [];
  for (let i = 0; i < domains.length; i += CHUNK) {
    rules.push({
      id: rules.length + 1,
      priority: 1, // explicit dashboard ALLOW (2), activation lock (3) and BLOCK (4) rules win
      action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?reason=category&category=${category}` } },
      condition: { requestDomains: domains.slice(i, i + CHUNK), resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  return rules;
}

// AgentShield's own additions (src/shared/web-category-additions.json) get rule ids from here up,
// so they can be replaced without touching (or re-downloading) the HaGeZi rules below them.
const ADDITION_ID_BASE = 1000;
const PATTERN = /^[a-z0-9]{5,40}$/;

/**
 * Pure: the DNR urlFilter for a site name. "||name" matches a host (or any of its subdomains) that
 * starts with the name: pagalworld.com.se, www.pagalworld.pw, filmyzilla13.org. It is a plain
 * domain anchor, not a regexFilter: Chrome silently skips regexes above its 2 KB size limit.
 */
function nameFilter(name) {
  return `||${name}`;
}

/** Pure: does a hostname match a name pattern the way Chrome's "||name" urlFilter does? */
function hostMatchesName(host, name) {
  host = host.toLowerCase();
  return host.startsWith(name) || host.includes('.' + name);
}

const KEYWORD = /^[a-z0-9]{3,30}$/;

/**
 * Pure: the regexFilter for an address keyword: the word anywhere in the host name (not in the path
 * or query, so a Google search for "mp3" is not blocked). One short keyword per rule keeps each regex
 * far below Chrome's 2 KB limit (larger ones are skipped silently).
 */
function keywordRegex(keyword) {
  return `^https?://[^/?#]*${keyword}`;
}

/** Pure: does a hostname contain an address keyword (what keywordRegex matches)? */
function hostHasKeyword(host, keyword) {
  return host.toLowerCase().includes(keyword);
}

/** Pure: validated additions for one category -> DNR rules. Throws on any invalid or protected entry. */
function buildAdditionRules(category, additions, protectedList) {
  if (!additions) return [];
  const domains = [...new Set((additions.domains || []).map((d) => String(d).trim().toLowerCase()))].sort();
  const names = [...new Set((additions.name_patterns || []).map((n) => String(n).trim().toLowerCase()))].sort();
  for (const d of domains) {
    if (!HOST.test(d)) throw new Error(`${category} addition: invalid domain ${d}`);
    if (isProtected(d, protectedList)) throw new Error(`${category} addition: ${d} is on the never-block list`);
  }
  for (const n of names) {
    if (!PATTERN.test(n)) throw new Error(`${category} addition: name pattern "${n}" must be 5-40 letters/digits`);
    const hit = protectedList.find((p) => hostMatchesName(p, n) || hostMatchesName('www.' + p, n));
    if (hit) throw new Error(`${category} addition: name pattern "${n}" would block never-block ${hit}`);
  }
  const keywords = [...new Set((additions.host_keywords || []).map((k) => String(k).trim().toLowerCase()))].sort();
  for (const k of keywords) {
    if (!KEYWORD.test(k)) throw new Error(`${category} addition: keyword "${k}" must be 3-30 letters/digits`);
    const hit = protectedList.find((p) => hostHasKeyword(p, k));
    if (hit) throw new Error(`${category} addition: keyword "${k}" would block never-block ${hit}`);
  }
  const redirect = { type: 'redirect', redirect: { extensionPath: `/blocked.html?reason=category&category=${category}` } };
  const resourceTypes = ['main_frame', 'sub_frame'];
  const rules = [];
  let id = ADDITION_ID_BASE;
  if (domains.length) rules.push({ id: id++, priority: 1, action: redirect, condition: { requestDomains: domains, resourceTypes } });
  for (const name of names) {
    rules.push({
      id: id++, priority: 1, action: redirect,
      condition: { urlFilter: nameFilter(name), isUrlFilterCaseSensitive: false, resourceTypes },
    });
  }
  for (const k of keywords) {
    rules.push({
      id: id++, priority: 1, action: redirect,
      condition: { regexFilter: keywordRegex(k), isUrlFilterCaseSensitive: false, resourceTypes },
    });
  }
  return rules;
}

function loadAdditions() {
  return JSON.parse(fs.readFileSync(path.join(root, 'src', 'shared', 'web-category-additions.json'), 'utf8'));
}

/** Pure: validated exclude_domains for one category (sites the downloaded list must not block there). */
function exclusionsFor(category, additions) {
  const list = [...new Set(((additions && additions.exclude_domains) || []).map((d) => String(d).trim().toLowerCase()))];
  for (const d of list) {
    if (!HOST.test(d)) throw new Error(`${category} exclusion: invalid domain ${d}`);
  }
  return list;
}

/** Pure: removes excluded domains (and their subdomains) from list rules; drops rules left empty. */
function applyExclusions(rules, exclude) {
  if (!exclude.length) return rules;
  return rules
    .map((r) => (r.condition.requestDomains
      ? { ...r, condition: { ...r.condition, requestDomains: r.condition.requestDomains.filter((d) => !isProtected(d, exclude)) } }
      : r))
    .filter((r) => !r.condition.requestDomains || r.condition.requestDomains.length > 0);
}

/** Replaces only the addition rules of every generated ruleset (no download). */
function applyAdditionsOnly() {
  const additions = loadAdditions();
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  for (const cat of config.categories) {
    const file = path.join(outDir, `${cat.id}.json`);
    // A category made only of AgentShield's own list (no downloaded sources) may not exist yet
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const base = applyExclusions(existing.filter((r) => r.id < ADDITION_ID_BASE), exclusionsFor(cat.id, additions[cat.id]));
    const extra = buildAdditionRules(cat.id, additions[cat.id], config.never_block);
    if (base.length + extra.length === 0) throw new Error(`${cat.id}: no rules (refusing to write an empty list)`);
    fs.writeFileSync(file, JSON.stringify([...base, ...extra]));
    if (!meta.categories[cat.id]) {
      meta.categories[cat.id] = { domains: 0, removed_protected: 0, sources: cat.sources.map(sourceUrl) };
    }
    setAdditionMeta(meta, cat.id, additions[cat.id]);
    console.log(`> ${cat.id}: ${extra.length} addition rule(s)`);
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'LICENSE-DATA.md'), licenseText(meta));
}

function setAdditionMeta(meta, id, additions) {
  if (!meta.categories[id]) return;
  if (additions) {
    meta.categories[id].agentshield_additions = {
      domains: (additions.domains || []).length, name_patterns: (additions.name_patterns || []).length,
      host_keywords: additions.host_keywords || [],
      exclude_domains: additions.exclude_domains || [],
    };
  } else {
    delete meta.categories[id].agentshield_additions;
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 60 * 1024 * 1024) throw new Error(`${url}: unexpectedly large`);
  return text;
}

async function main(only) {
  fs.mkdirSync(outDir, { recursive: true });
  // With --only, the other categories' rulesets and meta entries are kept exactly as they are
  const previous = only && fs.existsSync(path.join(outDir, 'meta.json'))
    ? JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'))
    : null;
  const meta = {
    generated_at: new Date().toISOString(),
    source: 'HaGeZi DNS blocklists; UT1 blacklists (Université Toulouse Capitole)',
    license: 'GPL-3.0 (HaGeZi data); CC BY-SA 4.0 (UT1 data)',
    categories: {},
  };
  const additions = loadAdditions();
  if (only) {
    const unknown = only.filter((id) => !config.categories.some((c) => c.id === id));
    if (unknown.length) throw new Error(`unknown categories: ${unknown.join(', ')}`);
  }
  for (const cat of config.categories) {
    if (only && !only.includes(cat.id)) {
      if (previous && previous.categories[cat.id]) meta.categories[cat.id] = previous.categories[cat.id];
      continue;
    }
    const all = new Set();
    let removed = 0;
    for (const file of cat.sources) {
      const url = sourceUrl(file);
      process.stdout.write(`> ${cat.id}: ${file.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, '')} ... `);
      const parsed = parseList(await download(url), config.never_block);
      parsed.domains.forEach((d) => all.add(d));
      removed += parsed.removed;
      console.log(`${parsed.domains.length} domains`);
    }
    const domains = [...all].sort();
    if (cat.sources.length && domains.length === 0) throw new Error(`${cat.id}: no domains (refusing to write an empty list)`);
    const exclude = exclusionsFor(cat.id, additions[cat.id]);
    const kept = domains.filter((d) => !isProtected(d, exclude));
    const rules = [...buildRules(cat.id, kept), ...buildAdditionRules(cat.id, additions[cat.id], config.never_block)];
    if (rules.length === 0) throw new Error(`${cat.id}: no rules (refusing to write an empty list)`);
    fs.writeFileSync(path.join(outDir, `${cat.id}.json`), JSON.stringify(rules));
    meta.categories[cat.id] = { domains: domains.length, removed_protected: removed, sources: cat.sources.map(sourceUrl) };
    setAdditionMeta(meta, cat.id, additions[cat.id]);
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'LICENSE-DATA.md'), licenseText(meta));
  console.log('Done. Rulesets written to', outDir);
}

function licenseText(meta) {
  const lines = Object.entries(meta.categories).map(([id, m]) => {
    const a = m.agentshield_additions;
    let extra = '';
    if (a && (a.domains || a.name_patterns)) extra += `; plus AgentShield additions: ${a.domains} domains, ${a.name_patterns} site-name patterns`;
    if (a && a.host_keywords && a.host_keywords.length) extra += `; any address containing: ${a.host_keywords.join(', ')}`;
    if (a && a.exclude_domains && a.exclude_domains.length) extra += `; not blocked here: ${a.exclude_domains.join(', ')}`;
    const from = m.sources.length ? `${m.domains.toLocaleString('en-US')} domains): ${m.sources.join(', ')}` : 'no downloaded list)';
    return `- **${id}** (${from}${extra}`;
  });
  return `# Website category data

The files in this folder (\`<category>.json\`) are generated by \`scripts/update-web-categories.js\` from:

* the **HaGeZi DNS blocklists** (https://github.com/hagezi/dns-blocklists), © HaGeZi and contributors,
  licensed under the **GNU General Public License v3.0** (https://www.gnu.org/licenses/gpl-3.0.html), for the
  categories whose sources below are under \`hagezi/dns-blocklists\`;
* the **UT1 blacklists** of Université Toulouse Capitole (https://dsi.ut-capitole.fr/blacklists/, mirrored at
  https://github.com/olbat/ut1-blacklists), © Fabrice Prigent and contributors, licensed under **Creative Commons
  Attribution-ShareAlike 4.0** (https://creativecommons.org/licenses/by-sa/4.0/), for the categories whose sources
  below are under \`ut1-blacklists\`. These rulesets are adapted from that data (converted to Chrome rules, invalid
  and never-block entries removed) and are shared under the same licence.

They are data files distributed alongside AgentShield, converted to Chrome declarativeNetRequest rules,
with invalid entries and a small never-block list (\`src/shared/web-categories.json\`) removed.
Rules with id 1000 and above are **AgentShield's own additions** (\`src/shared/web-category-additions.json\`),
not HaGeZi data.

Generated: ${meta.generated_at}

${lines.join('\n')}

> Before publishing the extension in a store, have the licence terms for distributing this data reviewed.
`;
}

if (require.main === module) {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex > -1 ? String(process.argv[onlyIndex + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const run = process.argv.includes('--additions-only') ? async () => applyAdditionsOnly() : () => main(only);
  run().catch((err) => {
    console.error('update-web-categories failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseList, buildRules, buildAdditionRules, applyExclusions, exclusionsFor, hostMatchesName, hostHasKeyword, keywordRegex,
  isProtected, ADDITION_ID_BASE,
};
