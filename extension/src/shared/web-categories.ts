/**
 * Category web filtering: which built-in rulesets (rulesets/<id>.json, declared in manifest.json)
 * are switched on, and the Safe Search rules. The switches come only from the server's policy sync
 * (settings.web_categories / settings.safe_search); anything missing or malformed falls back to the
 * safe defaults, never to "everything off".
 */
import config from './web-categories.json';

export type WebCategorySettings = Record<string, boolean>;

export const WEB_CATEGORY_IDS: string[] = config.categories.map((c) => c.id);

export const WEB_CATEGORY_DEFAULTS: WebCategorySettings = Object.fromEntries(
  config.categories.map((c) => [c.id, c.default])
);

/** Static ruleset id in manifest.json for a category. */
export const rulesetId = (category: string) => `cat_${category}`;

/** Defaults overridden by the server's boolean switches; unknown keys and non-booleans are ignored. */
export function effectiveCategories(fromServer: unknown): WebCategorySettings {
  const result: WebCategorySettings = { ...WEB_CATEGORY_DEFAULTS };
  if (fromServer && typeof fromServer === 'object') {
    for (const [key, value] of Object.entries(fromServer as Record<string, unknown>)) {
      if (key in result && typeof value === 'boolean') result[key] = value;
    }
  }
  return result;
}

/** Rulesets to enable and disable so the browser matches the settings. */
export function rulesetsFor(fromServer: unknown): { enable: string[]; disable: string[] } {
  const settings = effectiveCategories(fromServer);
  const enable = WEB_CATEGORY_IDS.filter((id) => settings[id]).map(rulesetId);
  const disable = WEB_CATEGORY_IDS.filter((id) => !settings[id]).map(rulesetId);
  return { enable, disable };
}

/** Safe Search follows Adult blocking unless the server says otherwise. */
export function safeSearchOn(safeSearch: unknown, fromServer: unknown): boolean {
  return typeof safeSearch === 'boolean' ? safeSearch : effectiveCategories(fromServer).adult === true;
}

/** Dynamic rule ids 40001+ are reserved for Safe Search. */
export const SAFE_SEARCH_RULE_BASE = 40001;

type ResourceType = chrome.declarativeNetRequest.ResourceType;
const PAGES = ['main_frame', 'sub_frame'] as ResourceType[];
const PAGES_AND_XHR = ['main_frame', 'sub_frame', 'xmlhttprequest'] as ResourceType[];

/** Search providers: a search URL gets the provider's strict parameter unless it already has it. */
const SAFE_SEARCH_PROVIDERS = [
  { search: '^https://(www\\.)?google\\.[a-z.]+/search\\?', key: 'safe', value: 'active' },
  { search: '^https://(www\\.)?bing\\.com/search\\?', key: 'adlt', value: 'strict' },
  { search: '^https://(html\\.|www\\.)?duckduckgo\\.com/(html/?)?\\?', key: 'kp', value: '1' },
];

/**
 * Strict results on Google, Bing and DuckDuckGo and YouTube Restricted Mode (YouTube-Restrict
 * request header). DNR regexes are RE2 (no lookahead), so each provider has a redirect rule plus a
 * higher-priority "allow" rule for URLs that already carry the strict value, which prevents loops.
 */
export function safeSearchRules(): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let n = SAFE_SEARCH_RULE_BASE;
  for (const p of SAFE_SEARCH_PROVIDERS) {
    rules.push({
      id: n++,
      priority: 1,
      action: {
        type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
        redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: p.key, value: p.value }] } } },
      },
      condition: { regexFilter: p.search, resourceTypes: PAGES },
    });
    rules.push({
      id: n++,
      priority: 2,
      action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
      condition: { regexFilter: `${p.search}(.*&)?${p.key}=${p.value}(&|$)`, resourceTypes: PAGES },
    });
  }
  rules.push({
    id: n++,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{
        header: 'YouTube-Restrict',
        operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
        value: 'Strict',
      }],
    },
    condition: {
      requestDomains: ['youtube.com', 'youtube-nocookie.com', 'youtubei.googleapis.com'],
      resourceTypes: PAGES_AND_XHR,
    },
  });
  return rules;
}

/** Readable labels for the block page and the extension popup. */
export const CATEGORY_LABELS: Record<string, { title: string; text: string }> = {
  malware: { title: 'Dangerous site blocked', text: 'This site is known for malware, phishing or scams.' },
  adult: { title: 'Adult content blocked', text: 'This site contains sexually explicit content.' },
  piracy: { title: 'Piracy site blocked', text: 'This site offers illegal copies of films, music or software.' },
  gambling: { title: 'Gambling site blocked', text: 'Betting, casino and lottery sites are blocked.' },
  social: { title: 'Social network blocked', text: 'Social networks are blocked on this browser.' },
  bypass: { title: 'Filter bypass blocked', text: 'VPN, proxy and similar services that get around blocking are not allowed.' },
  streaming: { title: 'Movies & music site blocked', text: 'Film, video and music streaming or download sites are blocked.' },
};
