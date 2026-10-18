/// <reference types="chrome" />
/**
 * AgentShield Real-Time Domain Blocker (backup layer)
 *
 * Blocked websites are normally stopped by network rules in the service worker before
 * the page loads. This script runs at 'document_start' as a second layer, in case a
 * page was opened before the rules were installed. It uses the same decision logic
 * (src/shared/domains.ts) as the service worker.
 */
import { DomainLists, decideHost } from '../shared/domains';

(function () {
  const host = window.location.hostname.toLowerCase();
  if (!host || !/^https?:$/.test(window.location.protocol)) return;

  // Fallback if the service worker has not written its lists yet: high-risk domains,
  // and AI sites locked until the browser is activated (fail closed)
  const DEFAULT_LISTS: DomainLists = {
    locked: true,
    blocked: [
      'ilovepdf.com',
      'smallpdf.com',
      'pdf2go.com',
      'freepdfconvert.com',
      'sodapdf.com',
      'sejda.com',
      'pastebin.com',
      'wetransfer.com',
      'pdfescape.com',
      'combinepdf.com',
      'docupub.com',
    ],
    allowed: [],
    aiDomains: [],
    blockUnapprovedAi: false,
  };

  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;

  chrome.storage.local.get(['domain_lists', 'syncState'], (res) => {
    const lists: DomainLists = res?.domain_lists && Array.isArray(res.domain_lists.blocked) ? res.domain_lists : DEFAULT_LISTS;
    const reason = decideHost(host, lists);
    if (!reason) return;
    const org = res?.syncState?.organization_name || 'AgentShield';

    if (reason === 'activation_required') {
      // The stored lists can be stale (e.g. the browser was activated a moment ago): confirm with the service worker
      try {
        chrome.runtime.sendMessage({ type: 'GET_DOMAIN_LISTS' }, (live: DomainLists) => {
          const liveReason = chrome.runtime.lastError || !live ? reason : decideHost(host, live);
          if (liveReason) block(liveReason, org);
        });
      } catch {
        block(reason, org);
      }
      return;
    }
    block(reason, org);
  });

  function block(reason: string, org: string) {
    try {
      window.stop();
    } catch {
      // Ignore if window already stopped
    }
    try {
      chrome.runtime.sendMessage({ type: 'DOMAIN_BLOCKED', domain: host }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Ignore messaging errors in isolated context
    }
    try {
      window.location.replace(
        chrome.runtime.getURL(
          `blocked.html?domain=${encodeURIComponent(host)}&org=${encodeURIComponent(org)}&reason=${reason}`
        )
      );
    } catch {
      window.location.href = 'about:blank';
    }
  }
})();
