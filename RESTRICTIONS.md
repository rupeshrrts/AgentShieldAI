# AgentShield — What is blocked and what is allowed

One page for administrators: every kind of restriction AgentShield applies, what each one blocks, what it lets
through, and where it is switched. Version: server 2.6.0, extension 1.9.0.

**The basic rule:** a restriction applies only while it is **On** in the portal. Switch it **Off** and it does nothing.
Changes reach connected browsers within about a minute (or at once with **Sync policies** in the extension popup).

There are **6 kinds of restriction**:

| # | Kind | Where it is set | What it acts on |
| :--- | :--- | :--- | :--- |
| 1 | Protection rules (data in prompts and files) | Portal → **Protection rules** | Text typed or pasted into an AI site, and files uploaded there |
| 2 | Website categories (24, in 4 groups) + Safe Search + quick settings (Kids / Workplace / Security / All off) | Portal → **Website controls** → Category blocking | Whole kinds of websites, on every site |
| 3 | Unapproved AI tools | Portal → **Website controls** → "Block unapproved AI tools" | Known AI websites that are not on your Allowed list |
| 4 | Your own website rules (Block / Allow) | Portal → **Website controls** → domain list | Any domain you add |
| 5 | Activation lock | Automatic (not a switch) | AI websites in a browser that is not connected |
| 6 | Employee status (company workspaces) | Portal → **Users & Devices** / employee profile | One employee's AI use |

---

## 1. Protection rules (what may be sent to an AI site)

Checked **inside the browser** before anything is sent, only on these AI sites: chatgpt.com, openai.com, claude.ai,
gemini.google.com, aistudio.google.com, copilot.microsoft.com, perplexity.ai, deepseek.com, chat.mistral.ai, poe.com,
meta.ai, grok.com. On every other website prompts are not checked.

| Rule | What it detects | Default action |
| :--- | :--- | :--- |
| API keys, tokens, passwords & private keys | OpenAI/Anthropic/AWS/GitHub/Google/Slack/Stripe keys, JWTs, PEM private keys, `password: …` | **Block** |
| Email addresses | Any email address | Warn |
| Phone numbers | 10+ digit numbers (Indian and North American) | Warn |
| Payment card numbers | 13–19 digits that pass the Luhn check | **Block** |
| Indian PAN numbers | ABCDE1234F format | Warn |
| Aadhaar numbers | 12 digits that pass the Verhoeff check | **Block** |
| Confidential keywords | Your list (Deployment & Settings → Confidential keywords), whole word, any case | Redact |
| File uploads to AI sites | Any file attached, dropped or pasted on an AI site | Warn |
| Crypto wallet private keys | Bitcoin WIF keys, `xprv` extended keys, 64-hex keys written next to "private key"/"seed" | **Block** |
| Connection strings with passwords | `postgres://user:password@host` and similar (placeholders like `<password>` ignored) | **Block** |
| IBAN bank account numbers | International account numbers passing the IBAN mod-97 check | **Block** |
| Indian bank account details | IFSC codes; 9–18 digit numbers written after "account" / "a/c" / "acct" | Warn |
| UPI IDs | `name@okaxis`, `98xxxxxxxx@ybl`, `name@paytm`… (known UPI handles only, so @mentions don't count) | Warn |
| Indian passport numbers | Letter + 7 digits, only when "passport" is written shortly before | **Block** |
| Voter ID (EPIC) numbers | 3 letters + 7 digits, only with "voter" / "EPIC" / "election" shortly before | Warn |
| GSTIN numbers | 15-character GST IDs passing the GSTIN check character (business IDs: recorded only) | Monitor |
| Internal IP addresses | 10.x, 172.16–31.x, 192.168.x (reveals the company network: recorded only) | Monitor |

The newer rules follow the way enterprise DLP dictionaries work: a format **plus** a checksum (IBAN, GSTIN, card,
Aadhaar) or a nearby keyword (passport, voter ID, account number), so ordinary numbers and codes don't trigger them.

**When text is checked:** when the prompt is sent (Enter, send button, form), and also **the moment text is pasted or
dropped into the prompt box**: if an enabled rule set to **Block** matches, the paste is stopped and the text never
reaches the box. Warn, Redact and Monitor are applied when the prompt is sent.

**Actions** (you can change the action of each rule):

| Action | What the employee sees | Sent? | Recorded? |
| :--- | :--- | :--- | :--- |
| Block | Red dialog | No | Yes |
| Redact | Preview with `[REDACTED:…]` | Yes, masked (a file with a match is blocked instead) | Yes |
| Warn | Must confirm and may give a reason | Only if they confirm | Yes, with their reason |
| Monitor | Nothing | Yes | Yes |
| Allow | Nothing | Yes | No violation (the prompt is only counted) |

* **Off** = the rule is not checked at all; the item is sent.
* When several rules match, the **strictest action wins**: Block > Redact > Warn > Monitor > Allow.
* **Presets** (top of the page): *Recommended* = the defaults above, *Strict* = every rule Block (including all file uploads), *Monitor only* = every rule Monitor. Applying a preset switches **every rule On**.
* **Files:** text files up to 2 MB (txt, csv, json, code, logs, …) are also scanned with all the rules above. PDF, Office and image files are **not read**; only the "File uploads" rule applies to them.
* A rule can be limited to one site (site scope); it is then not enforced on other sites.

## 2. Website categories and Safe Search (every website)

Lists are built into the extension, so the sites a person visits are not sent anywhere. A blocked page never loads;
the person sees the AgentShield block page with the reason.

24 categories in 4 groups, the way enterprise web filters (Zscaler, Cisco Umbrella: security vs. content
categories) and parental controls (Qustodio, Net Nanny) arrange theirs. Every one is a switch.

| Group | Category | Blocks | Default |
| :--- | :--- | :--- | :--- |
| **Security threats** | Malware, phishing & scams | Known dangerous sites: malware, phishing, fake shops, scams | **On** |
| | Cryptomining | Sites and mining pools that mine cryptocurrency with the computer | Off |
| | Spyware & stalkerware | Phone/computer spying apps and their servers (mSpy, FlexiSPY, …) | Off |
| | Hacking & password cracking | Hacking tools, password cracks, stolen accounts | Off |
| | Remote-access tools | AnyDesk, TeamViewer, UltraViewer, RustDesk… websites (used in "tech support" scams) | Off |
| | Dynamic DNS | Free dynamic-DNS names (duckdns, no-ip, ddns.net…), often used by malware; may block home cameras/NAS | Off |
| | URL shorteners | bit.ly, tinyurl, t.co… (hide the real destination; LinkedIn's lnkd.in stays open) | Off |
| | Filter bypass | Public VPN, proxy and encrypted-DNS websites used to get around blocking | Off |
| **Data leaks** | File sharing & online storage | Dropbox, WeTransfer, MediaFire, MEGA, Terabox, Gofile… | Off |
| | Personal webmail | Yahoo Mail, Proton, Zoho, Rediffmail, throw-away mail (**Gmail and Outlook stay open**) | Off |
| **Adult content & kids safety** | Adult content | Pornography and sexually explicit sites (the list also contains character.ai) | **On** |
| | Mature & suggestive | Lingerie, suggestive and mixed adult sites | Off |
| | Dating | Tinder, Bumble, OkCupid, Shaadi, Jeevansathi, TrulyMadly, Aisle… | Off |
| | Gambling | Betting, casino and lottery sites | Off |
| | Drugs | Sites that sell or promote illegal drugs | Off |
| | Hate & violence | Hate speech, extremist and violent sites | Off |
| | Weapons | Weapon shops and dangerous-material sites | Off |
| | Chat rooms | Omegle-style and anonymous chat rooms (Chatroulette, Emerald Chat, OmeTV…) | Off |
| | Piracy | Illegal streaming, torrent and download sites for films, music and software | **On** |
| | **Safe Search** | Strict results on Google, Bing and DuckDuckGo; YouTube Restricted Mode | Follows *Adult content* until you set it yourself |
| **Productivity** | Social networks | Facebook, Instagram, TikTok, X, … (**LinkedIn and Reddit stay open**) | Off |
| | Movies, music & streaming | Netflix, Prime Video, Hotstar, Spotify, Gaana, JioSaavn, and any address with words like mp3, song, movie or bhojpuri (**YouTube stays open**) | Off |
| | Online games | Browser games and gaming sites (Poki, Miniclip, Roblox, Steam, Epic Games, MPL, Ludo King…) | Off |
| | Shopping | Flipkart, Myntra, Meesho, Ajio, Nykaa, eBay, AliExpress, Temu… (**Amazon stays open**) | Off |
| | Job search | Naukri, Indeed, Glassdoor, foundit, Internshala… (**LinkedIn stays open**) | Off |

**Quick settings (one click, top of Category blocking).** Each one sets *every* category; you can still change single
switches afterwards:

| Quick setting | Turns On | Safe Search |
| :--- | :--- | :--- |
| **Kids / family** | All security threats + adult, mature, dating, gambling, drugs, hate & violence, weapons, chat rooms, piracy + social networks | On |
| **Workplace** | All security threats + file sharing, personal webmail + adult, mature, dating, gambling, drugs, hate & violence, weapons, piracy + online games | On |
| **Security only** | All security threats + piracy (everything else Off) | Unchanged |
| **All off** | Nothing | Off |

For a child's browser, also consider: **Block unapproved AI tools** (section 3) and your own Block rules (section 4)
for specific sites. Time limits (bedtime or school-hours schedules) are not available.

**Never blocked by a category** (so everyday work keeps working): google.com, googleapis.com, gstatic.com,
googleusercontent.com, youtube.com, ytimg.com, microsoft.com, microsoftonline.com, live.com, office.com, windows.net,
bing.com, apple.com, icloud.com, amazon.com, amazonaws.com, cloudfront.net, akamaihd.net, github.com,
githubusercontent.com, wikipedia.org, cloudflare.com, blogspot.com, wordpress.com, linkedin.com, outlook.com,
hotmail.com, gmail.com, zoom.us, slack.com, notion.so, atlassian.net, salesforce.com, and the main AI sites
(chatgpt.com, openai.com, claude.ai, anthropic.com, perplexity.ai, deepseek.com, mistral.ai, poe.com, meta.ai, grok.com).
Your own **Block** rules still apply to them.

A site blocked by a category by mistake → add it as **Allow** in your website rules (section 4).

## 3. Unapproved AI tools

Switch **"Block unapproved AI tools"** On, and these AI sites are blocked unless they are on your **Allowed** list:
chatgpt.com, chat.openai.com, claude.ai, gemini.google.com, aistudio.google.com, copilot.microsoft.com, perplexity.ai,
chat.deepseek.com, deepseek.com, chat.mistral.ai, poe.com, character.ai, you.com, huggingface.co, meta.ai, grok.com,
chat.qwen.ai, kimi.com, pi.ai, jasper.ai, writesonic.com, quillbot.com.

New accounts start with **chatgpt.com, chat.openai.com, claude.ai, gemini.google.com and copilot.microsoft.com on the
Allowed list**, so with the switch On those stay open and the others are blocked. Default: **Off** (all AI sites open,
prompts still checked by section 1).

## 4. Your own website rules

| Type | Effect |
| :--- | :--- |
| **Block** | The domain and all its subdomains never load, whatever else is set. Stronger than everything else |
| **Allow** | Exception to categories (2) and to unapproved AI blocking (3). Prompts on an allowed AI site are still checked |
| Rule switched off (disabled) | Ignored |

New accounts start with these **Block** rules (data-exfiltration risk), which you can switch off or delete:
ilovepdf.com, smallpdf.com, pastebin.com, pdf2go.com, wetransfer.com.

## 5. Activation lock (not a switch)

Until a browser is connected to your account with an activation code, **all AI sites are blocked** in it (the 12 sites
in section 1 plus the AI sites in section 3), and nothing is sent from them. Installing the extension grants nothing.
The lock comes back when the plan ends, the browser is removed in the portal, the account is disabled or the server
cannot be reached for longer than the 15-minute session. Website rules from the last sync stay in force meanwhile.

## 6. Employee status (company workspaces)

| Status | Effect on that employee |
| :--- | :--- |
| Active | Normal rules |
| Warned | Normal rules (a recorded warning only) |
| Restricted | Every **Warn** becomes **Block** |
| Suspended | **Everything** they send to an AI site is blocked, even with every rule Off |

## How website blocks are enforced (two layers)

1. **Network level:** the browser's own blocking rules stop a blocked page before it loads (nothing is downloaded).
2. **Page level** (backup for what network rules cannot see):
   * when a rule or category is switched **On**, tabs that are **already open** on such a site are sent to the block page
     at once, without waiting for a reload;
   * a page restored with the Back/Forward buttons (from the browser's cache, so no network request) is checked again;
   * every navigation is also checked against your own Block rules and unapproved AI tools, and a check inside the page
     at load time covers the same.

## What wins when several apply (websites)

1. Your **Block** rule → blocked
2. Browser **not connected** + AI site → blocked (activation)
3. Your **Allow** rule → allowed
4. **Unapproved AI tool** (switch On) or a **category** that is On → blocked
5. Everything else → allowed

## What is not restricted

* Websites in categories that are Off, and every site not on any list.
* Prompts on websites that are not AI sites (section 1 list).
* Copying is not watched, and pasting is only checked inside AI sites' prompt boxes (pasted files as uploads).
* Content inside PDF, Office and image files.
* Free plan with its monthly prompt checks used up: AI sites stay open and website controls keep working, but prompts are **not checked** until the 1st of the month, an upgrade or credits.
* Other browsers (Firefox, Safari) and desktop AI apps, unless the optional Network Agent is installed; browsers without the extension.

## Where this is written in the other documents

| Topic | Document and section | Source of truth in the code |
| :--- | :--- | :--- |
| Rules, actions, presets | [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) → *Data Protection Rules*; [README.md](./README.md) → *Detection rules* | `backend/app/core/catalog.py` (`RULE_CATALOG`, `PRESETS`) |
| How a rule is decided (strictest wins, Off = not enforced) | [README.md](./README.md) → *How it works*; [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) → §2 *Dashboard ↔ enforcement* | `extension/src/shared/policy.ts` ↔ `backend/app/policies/evaluator.py` |
| Confidential keywords | [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) → *Confidential keywords* | `backend/app/api/organization.py` |
| Website controls, unapproved AI | [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) → *Website controls* | `extension/src/shared/domains.ts`, `KNOWN_AI_DOMAINS` in `catalog.py`, `DEFAULT_DOMAINS` in `backend/app/db/seed.py` |
| Categories, Safe Search, never-blocked sites | [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) → §5 *Website categories are list-based* | `WEB_CATEGORIES` in `catalog.py`, `extension/src/shared/web-categories.json` / `.ts`, `extension/rulesets/` |
| Activation lock, plan states | [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) → §2 and §4; [USER_SETUP.md](./USER_SETUP.md) | `extension/src/background/auth-state.ts`, `backend/app/core/entitlements.py` |
| Employee status | [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) → *Investigating* | `policy.ts: evaluateFindings` |
| What data is sent and stored | [DATA_HANDLING.md](./DATA_HANDLING.md) | `extension/src/content/content.ts`, `backend/app/core/privacy.py` |
| Limits (what is not enforced) | [SECURITY_ARCHITECTURE.md](./SECURITY_ARCHITECTURE.md) → §5 *Limitations* | — |
| Proof that On/Off works | [TESTING.md](./TESTING.md) → *Results at version 2.6.0* | `extension/tests/e2e/rules-e2e.js` |
