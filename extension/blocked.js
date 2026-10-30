document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const domain = params.get('domain') || '';
  const org = params.get('org') || 'AgentShield';
  const rawReason = params.get('reason');
  const reason = ['unapproved_ai', 'activation_required', 'category'].includes(rawReason) ? rawReason : 'policy';
  // Website categories (keep in sync with CATEGORY_LABELS in src/shared/web-categories.ts)
  const CATEGORIES = {
    malware: ['Dangerous site blocked', 'This site is known for malware, phishing or scams. Opening it could infect your computer or steal your passwords or payment details.'],
    adult: ['Adult content blocked', 'This site contains sexually explicit content.'],
    piracy: ['Piracy site blocked', 'This site offers illegal copies of films, music or software. Such sites often carry malware and break copyright law.'],
    gambling: ['Gambling site blocked', 'Betting, casino and lottery sites are blocked on this browser.'],
    social: ['Social network blocked', 'Social networks are blocked on this browser.'],
    bypass: ['Filter bypass blocked', 'VPN, proxy and similar services that get around website blocking are not allowed on this browser.'],
    streaming: ['Movies & music site blocked', 'Film, video and music streaming or download sites are blocked on this browser.'],
    cryptomining: ['Cryptomining site blocked', 'This site uses computers to mine cryptocurrency in the background, which slows them down and can hide malware.'],
    spyware: ['Spyware site blocked', 'This site belongs to phone or computer spying software (stalkerware).'],
    hacking: ['Hacking site blocked', 'Hacking tools, password cracks and stolen-account sites are blocked on this browser.'],
    remote_access: ['Remote-access site blocked', 'Remote desktop and remote support sites are blocked. Scammers use them to take over computers.'],
    dyndns: ['Dynamic DNS site blocked', 'Free dynamic-DNS addresses are blocked because malware and phishing often use them.'],
    shortener: ['Short link blocked', 'Short-link services hide where a link really goes, so they are blocked on this browser.'],
    filesharing: ['File-sharing site blocked', 'Public file-sharing and online-storage sites are blocked so company files do not leave the organization.'],
    webmail: ['Personal webmail blocked', 'Personal and throw-away email sites are blocked so company data is not sent outside.'],
    mature: ['Mature content blocked', 'Suggestive and mature sites are blocked on this browser.'],
    dating: ['Dating site blocked', 'Dating and matchmaking sites are blocked on this browser.'],
    drugs: ['Drug site blocked', 'Sites that sell or promote illegal drugs are blocked on this browser.'],
    hate: ['Hate & violence site blocked', 'Hate speech, extremist and violent sites are blocked on this browser.'],
    weapons: ['Weapons site blocked', 'Weapon shops and sites about making dangerous materials are blocked on this browser.'],
    chat: ['Chat room blocked', 'Open and anonymous chat rooms, where children can meet strangers, are blocked on this browser.'],
    games: ['Game site blocked', 'Online games are blocked on this browser.'],
    shopping: ['Shopping site blocked', 'Online shops are blocked on this browser.'],
    jobsearch: ['Job site blocked', 'Job boards and recruitment sites are blocked on this browser.'],
  };
  const category = Object.prototype.hasOwnProperty.call(CATEGORIES, params.get('category')) ? params.get('category') : '';

  const domainEl = document.getElementById('target-domain');
  if (domainEl) domainEl.innerText = domain;
  // Category rules block before any page runs, so the address is not known here: hide the row
  const domainRow = document.getElementById('row-domain');
  if (domainRow && !domain) domainRow.style.display = 'none';

  const orgEl = document.getElementById('org-name');
  if (orgEl) orgEl.innerText = org;

  const categoryEl = document.getElementById('policy-category');
  const ruleEl = document.getElementById('rule-triggered');
  const whyEl = document.getElementById('why-blocked');
  if (reason === 'activation_required') {
    document.body.classList.add('reason-activation');
    const titleEl = document.querySelector('h1');
    if (titleEl) titleEl.innerText = 'Activate AgentShield to use AI tools';
    const subtitleEl = document.querySelector('p.subtitle');
    if (subtitleEl) subtitleEl.innerText = 'AI tools stay blocked in this browser until it is connected to your AgentShield account.';
    const badgeEl = document.querySelector('.badge');
    if (badgeEl) badgeEl.innerText = 'Activation required';
    if (categoryEl) categoryEl.innerText = 'This browser is not activated';
    if (ruleEl) ruleEl.innerText = 'access.activation_required';
    if (whyEl) {
      whyEl.innerText =
        'AI tools are blocked until AgentShield is activated in this browser. Sign in to your AgentShield dashboard, ' +
        'generate an activation code, then click the AgentShield icon in the toolbar and paste it. ' +
        'If the server cannot be reached or your activation was revoked, AI tools stay blocked.';
    }
  } else if (reason === 'category') {
    const [title, why] = CATEGORIES[category] || ['Website blocked', 'This website is in a blocked category.'];
    const titleEl = document.querySelector('h1');
    if (titleEl) titleEl.innerText = title;
    const subtitleEl = document.querySelector('p.subtitle');
    if (subtitleEl) subtitleEl.innerText = 'AgentShield blocked this page before it loaded, to keep this browser safe.';
    const badgeEl = document.querySelector('.badge');
    if (badgeEl) badgeEl.innerText = 'Website category blocked';
    const pageTitle = title + ' - AgentShield';
    document.title = pageTitle;
    if (categoryEl) categoryEl.innerText = title.replace(/ blocked$/, '');
    if (ruleEl) ruleEl.innerText = 'dlp.category.' + (category || 'unknown');
    if (whyEl) {
      whyEl.innerText = why + ' If this site was blocked by mistake, the account owner can allow it in the AgentShield dashboard under Website controls.';
    }
  } else if (reason === 'unapproved_ai') {
    const titleEl = document.querySelector('h1');
    if (titleEl) titleEl.innerText = 'AI tool not approved';
    if (categoryEl) categoryEl.innerText = 'AI tool not approved by your organization';
    if (ruleEl) ruleEl.innerText = 'dlp.unapproved_ai';
    if (whyEl) {
      whyEl.innerText =
        'Your organization only allows approved AI tools, so company data stays under its data-protection agreements. ' +
        'Use one of the approved AI tools, or ask IT to review this one.';
    }
  } else {
    if (categoryEl) categoryEl.innerText = "Restricted by your organization's website policy";
    if (ruleEl) ruleEl.innerText = 'dlp.blocked_domain';
    if (whyEl) {
      whyEl.innerText =
        'Sites such as public file converters and paste sites copy what you upload to outside servers, which can leak confidential data. ' +
        'Please use a company-approved tool. If you need this site for work, ask IT to review it.';
    }
  }

  // Where this block is switched Off or On (every block except the activation lock is a dashboard switch)
  const CATEGORY_SWITCHES = {
    malware: 'Malware, phishing & scams', adult: 'Adult content', piracy: 'Piracy', gambling: 'Gambling',
    social: 'Social networks', bypass: 'Filter bypass', streaming: 'Movies, music & streaming',
    cryptomining: 'Cryptomining', spyware: 'Spyware & stalkerware', hacking: 'Hacking & password cracking',
    remote_access: 'Remote-access tools', dyndns: 'Dynamic DNS', shortener: 'URL shorteners',
    filesharing: 'File sharing & online storage', webmail: 'Personal webmail', mature: 'Mature & suggestive',
    dating: 'Dating', drugs: 'Drugs', hate: 'Hate & violence', weapons: 'Weapons', chat: 'Chat rooms',
    games: 'Online games', shopping: 'Shopping', jobsearch: 'Job search',
  };
  const APPLY = ' Changes reach this browser within about a minute (or at once with "Sync policies" in the AgentShield popup).';
  const controlEl = document.getElementById('control-where');
  if (controlEl) {
    if (reason === 'activation_required') {
      document.querySelector('#control-box .why-title').innerText = 'How to unblock';
      controlEl.innerText = 'This is not a dashboard rule: AI tools open as soon as this browser is connected with an activation code.';
    } else if (reason === 'category') {
      controlEl.innerText = 'Yes. An administrator can switch the "' + (CATEGORY_SWITCHES[category] || 'website category') +
        '" category Off or On in the AgentShield portal: Website controls > Category blocking. To open only this site, add it there as ALLOW.' + APPLY;
    } else if (reason === 'unapproved_ai') {
      controlEl.innerText = 'Yes. An administrator can switch "Block unapproved AI tools" Off or On in the AgentShield portal (Website controls), ' +
        'or add ' + (domain || 'this site') + ' to the Allowed list there.' + APPLY;
    } else {
      controlEl.innerText = 'Yes. This is a website rule. An administrator can switch it in the AgentShield portal: Website controls > Blocked Traffic > ' +
        (domain || 'this site') + ' > Enabled / Disabled (or delete the rule).' + APPLY;
    }
  }

  // Local time of the block (the old random "incident reference" matched no record, so it was removed)
  const atEl = document.getElementById('blocked-at');
  if (atEl) {
    atEl.innerText = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Network-level blocks never run a script on the blocked site, so log the attempt from here.
  // The service worker only records blocks that are really in force, and de-duplicates reports.
  const report = reason === 'category' ? (category ? { type: 'CATEGORY_BLOCKED', category } : null)
    : (domain ? { type: 'DOMAIN_BLOCKED', domain } : null);
  if (report && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage(report, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // ignore
    }
  }

  const backBtn = document.getElementById('btn-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.close();
      }
    });
  }

  // Employees do not use the admin dashboard; the button is not shown on the block page
  const dashBtn = document.getElementById('btn-dashboard');
  if (dashBtn) dashBtn.style.display = 'none';
});
