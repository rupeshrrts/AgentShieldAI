/**
 * Page-level backup for the website categories. Makes the same decision as the category rulesets
 * (rulesets/<id>.json, applied by the browser's network rules) for pages those rules never saw:
 * tabs that were already open when a category or website rule was switched on, and pages restored
 * from the back/forward cache. Used by the service worker; the matching itself is pure (tested).
 */

/** One category's ruleset, compiled for lookups. */
export interface CategoryList {
  /** requestDomains: the domain and all of its subdomains */
  domains: Set<string>;
  /** urlFilter "||name": a host (or subdomain) that starts with the name */
  names: string[];
  /** regexFilter "^https?://[^/?#]*word": a host that contains the word */
  keywords: string[];
}

const KEYWORD_REGEX = /^\^https\?:\/\/\[\^\/\?#\]\*([a-z0-9]+)$/;

/** Compiles the DNR rules of one ruleset file. Rules of any other shape are ignored. */
export function compileRules(rules: any[]): CategoryList {
  const list: CategoryList = { domains: new Set(), names: [], keywords: [] };
  for (const r of Array.isArray(rules) ? rules : []) {
    const c = r && r.condition;
    if (!c) continue;
    if (Array.isArray(c.requestDomains)) for (const d of c.requestDomains) list.domains.add(String(d).toLowerCase());
    if (typeof c.urlFilter === 'string' && c.urlFilter.startsWith('||')) list.names.push(c.urlFilter.slice(2).toLowerCase());
    if (typeof c.regexFilter === 'string') {
      const m = KEYWORD_REGEX.exec(c.regexFilter);
      if (m) list.keywords.push(m[1]);
    }
  }
  return list;
}

/** Does the host match the list the way Chrome's requestDomains / urlFilter / regexFilter rules do? */
export function listMatches(host: string, list: CategoryList): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  // The host itself or any parent domain
  let d = h;
  for (;;) {
    if (list.domains.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot < 0) break;
    d = d.slice(dot + 1);
  }
  if (list.names.some((n) => h.startsWith(n) || h.includes('.' + n))) return true;
  return list.keywords.some((k) => h.includes(k));
}
