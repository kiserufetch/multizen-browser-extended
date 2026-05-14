MULTIZEN v0.2.1 REDDIT LAUNCH PLAN
=====================================================

GENERAL STRATEGY

Image post in every sub (Reddit weighs image posts higher in feed). Title in the post field, image is the firstrun screen or profiles list depending on the sub. First top-level comment from you contains the GitHub link and the website. Never put a link in the post body itself, it tanks the algorithm and tags your post as a promo. Wait 60 seconds after posting before adding the comment so it does not look auto-scripted.

Time of day: weekdays 9am to 11am Pacific time hit the engagement peak for US tech subs. r/cursor and r/ClaudeAI tend to peak later in the day. Avoid Saturday morning (low engagement) and Sunday night (also low).

Cadence: do not blast all ten on the same day. Two per day across a week is safer. Mods of related subs are in the same Discord servers, and a "this guy posted everywhere on Monday" pattern gets people downvoting reflexively.

Rule of thumb across all subs: be honest about what is not done. "70 to 85 percent success on simple sites, less on Cloudflare Enterprise" lands better than "passes every detection test". Reddit will sniff out marketing language faster than any other platform.

Karma: each sub needs at least some account history. If your reddit account is fresh, post a couple of low-stakes comments in unrelated subs first, get past 100 comment karma, then start.

Screenshots to use:
  firstrun.webp at public/screenshots/firstrun.webp on the landing repo
  profiles-list.webp at public/screenshots/profiles-list.webp on the landing repo
Both are already optimized to under 110 KB.



=====================================================
SUBREDDIT 1: r/SideProject
=====================================================

Members: 220k+. Show-off friendly. Founder narrative works best here.
Screenshot to attach: firstrun.webp (looks polished, good first impression)
Best day: any weekday morning
Flair: usually "Project" or "Side Project"
Rules notes: self-promo welcomed, but tell the story, do not just dump a link

TITLE (pick one):
  Spent 3 months turning my browser into a tool for Claude
  Built a browser that AI agents can drive while you watch
  My side project: a Chromium with built-in MCP for AI agents

POST BODY:

I have been working on this on weekends for the last few months. It started because I was using Claude Desktop to help me with sales outreach research, but every time it needed to log into LinkedIn or check a CRM it would either fail or kick me out to do it manually. The MCP servers I tried either ran headless and got caught by every bot detector, or they only exposed profile CRUD without actually being able to navigate.

So I built MultiZen. It is a desktop app that runs a library of isolated Chromium profiles. Each profile has its own cookies, login state, fingerprint, and proxy. There is a local MCP server on port 7777 that any MCP client can connect to. Cursor, Claude Desktop, Cline, all the usual ones. The AI gets tools to list profiles, launch them, navigate, click, type, extract, and screenshot.

The trick that took the longest was making AI sessions and human sessions share state. You can be in the middle of an automated workflow, hit a 2FA prompt, the AI hands it to you, you enter the code in the actual Chromium window, and the AI continues. Cookies and session state survive between launches.

Stack is Electron, React, TypeScript, Yarn 4 workspaces. The browser engine is a patched Chromium fork (CloakBrowser) that handles canvas, WebGL, audio, font fingerprints at C++ level. Everything is MIT licensed, runs on macOS, Windows, Linux.

What it does not do yet: TLS JA3/JA4 spoofing is on the roadmap but not in this build. So sites that fingerprint at the TLS layer (some Cloudflare Enterprise setups, DataDome) will catch you. I am transparent about this in the FAQ.

Feedback welcome. Specifically curious whether the AI-plus-human handoff resonates as a use case or whether people just want pure automation.

FIRST COMMENT (post 60 seconds after the main post):

Repo and downloads here for anyone curious:
github.com/multizenteam/multizen-browser
website with screenshots is at getmultizen.com



=====================================================
SUBREDDIT 2: r/selfhosted
=====================================================

Members: 350k+. Strict about actually-self-hostable software.
Screenshot to attach: profiles-list.webp (shows it running)
Best day: midweek (Tue-Thu) morning
Flair: Software (required)
Rules notes: do not say "cloud version available" anywhere or it gets flagged. We have none, so we are fine. Mention MIT explicitly.

TITLE (pick one):
  MultiZen: self-hosted MCP browser for AI agents, MIT
  Self-hosted browser library with built-in MCP server, free and open source
  Local-only MCP browser for Cursor and Claude Desktop

POST BODY:

Sharing something I have been building. It is a desktop app that lets you run a library of isolated browser profiles, each with its own cookies, login state, proxy, and fingerprint. Profiles live on your disk in plain SQLite plus standard Chromium user-data-dir format. Nothing leaves your machine.

The thing that makes it different from just running multiple Chrome profiles is the MCP server. There is a localhost MCP endpoint on port 7777 that exposes navigate, click, type, extract, screenshot tools to any MCP client. So Cursor or Claude Desktop can drive any profile while you watch. When the AI gets stuck on a CAPTCHA or 2FA, you take over in the same Chromium window, then hand back.

Self-hosting story: there is no account, no license server, no telemetry, no auto-update phone-home. The desktop app does not call out to anything you did not configure. If we shut down the project tomorrow, your install keeps working forever. Profile export is a single encrypted file you control.

Stack: Electron, TypeScript, React, native MCP server from the official SDK. Browser engine is a patched Chromium fork (CloakBrowser) that handles anti-detect at the C++ level. Optional proxy support per profile (HTTP and SOCKS5), with a local SOCKS5 bridge that keeps DNS resolution remote so you do not leak to your ISP.

Caveats: not signed for macOS Gatekeeper or Windows SmartScreen, so first launch will warn you. Notarization is on the to-do list when there is budget for an Apple Developer ID. TLS fingerprint spoofing is also not in yet.

License is MIT for the core, source patches in CloakBrowser are also open.

FIRST COMMENT:

Releases for macOS, Windows, Linux are here:
github.com/multizenteam/multizen-browser
The landing has more context and screenshots: getmultizen.com



=====================================================
SUBREDDIT 3: r/LocalLLaMA
=====================================================

Members: 700k+. Smart, technical, allergic to AI-generated marketing.
Screenshot to attach: profiles-list.webp (technical detail matters here)
Best day: weekday morning PT
Flair: Resources or Tools
Rules notes: self-promo allowed but be technical and honest. They downvote shallow promo. Mention how it works with local models specifically.

TITLE (pick one):
  Built an MCP server for persistent browser sessions, works with local LLMs through Cursor or any MCP client
  Local browser library with MCP, drive it from your local model
  Open source MCP browser, no API calls home, drives a real Chromium

POST BODY:

I built this because I wanted my local Qwen-32B through Cursor to be able to log into stuff and actually do work, not just analyze code. The pattern I kept hitting was either Playwright running headless (gets caught), or paying for a hosted browser service (defeats the local-first thing entirely).

MultiZen is a desktop app that runs a library of isolated Chromium profiles. Each one keeps its own cookies, login state, fingerprint, and proxy. There is a local MCP server on port 7777 that any MCP client can connect to. Anything that speaks MCP works: Cursor with a local LLM proxy, Claude Desktop, Cline, custom clients. The model gets tools for navigate, click, type, extract, screenshot.

What is actually local:
no auth or account, no license server, no telemetry
profiles stored as SQLite plus plain Chromium user-data-dir
the patched Chromium binary auto-downloads on first run from a known mirror, hash verified, then runs entirely offline
even the fingerprint generation is deterministic from a profile-id seed, no network roundtrip

Anti-detect honesty: I am using CloakBrowser as the underlying engine. It handles canvas, WebGL, audio, font fingerprints at C++ level, which is the only way you actually pass FingerprintJS and similar. JS-injection level patches (the old Puppeteer-stealth approach) gets caught by anything modern. CloakBrowser is open source and the patches are auditable.

What does not work: TLS JA3/JA4 spoofing is not in. Behavioral analysis (DataDome) is not in. So Cloudflare Enterprise and the meanest anti-bot stacks will still catch you. The MultiZen anti-detect score on fingerprint-scan.com is around 65/100 on my Luxembourg residential proxy, which is roughly the CloakBrowser ceiling without custom patches.

Stack is Electron, TypeScript, the official MCP server SDK over HTTP. Runs on macOS (arm64 and x64), Windows x64, Linux x86_64. MIT license.

Real question I am still working out: does it make sense to expose a single MCP server with all profiles, or one MCP server per profile? Right now it is one shared. Curious what local-first folks would prefer for multi-agent setups.

FIRST COMMENT:

Repo: github.com/multizenteam/multizen-browser
Landing with the full feature list: getmultizen.com



=====================================================
SUBREDDIT 4: r/cursor
=====================================================

Members: ~80k. Cursor users, MCP-aware. Friendly to relevant tools.
Screenshot to attach: profiles-list.webp
Best day: any weekday
Flair: Showcase or Discussion
Rules notes: tag MCP in the title, that is what they care about.

TITLE (pick one):
  Made a Cursor MCP that drives real Chromium with anti-detect built in
  MCP server for Cursor that gives your agent a persistent browser library
  Built an MCP for Cursor so I could log it into LinkedIn through code

POST BODY:

You can already get Cursor to do crazy stuff with the codebase. What I kept wanting was for it to also log into things and actually finish tasks, not just write the code that would. Existing browser MCPs run headless or only expose profile management, neither of which works for real auth flows.

MultiZen is a desktop app that runs alongside Cursor. It starts a local MCP server on port 7777 that exposes navigate, click, type, extract, screenshot for a library of isolated Chromium profiles you create in the GUI. Each profile is a real persistent Chromium with its own cookies, proxy, and anti-detect fingerprint. Cursor sees them as MCP tools.

Cursor config snippet to make it work:
  in ~/.cursor/mcp.json under mcpServers add multizen with url http://localhost:7777/sse

The workflow that pays off the most: I have a profile per client. Cursor drives the right profile for whatever I am working on. When auth challenges show up (most do at some point), the actual Chromium window is right there, I click through it, Cursor continues.

It is free and MIT. macOS, Windows, Linux. Browser engine is CloakBrowser under the hood so canvas, WebGL, audio fingerprints are real, not JS-injected.

Honest limits: not signed on Mac so Gatekeeper warns. TLS fingerprint spoofing not done yet so very aggressive anti-bot stacks will still catch you.

If you have a setup you want to test it with let me know, I am collecting use cases.

FIRST COMMENT:

Repo: github.com/multizenteam/multizen-browser
Setup walkthrough and screenshots on the site: getmultizen.com



=====================================================
SUBREDDIT 5: r/ClaudeAI
=====================================================

Members: 150k+. Claude users. MCP-friendly.
Screenshot to attach: firstrun.webp (polished, on-brand with Claude aesthetic)
Best day: weekday afternoon
Flair: MCP or Resources
Rules notes: no anti-Claude takes, generally accepting if relevant to the product

TITLE (pick one):
  Made an MCP server for Claude Desktop that gives it a real browser with persistent logins
  Claude Desktop plus a browser library with MCP, free and open source
  MCP browser server I built for my own Claude Desktop workflows

POST BODY:

I use Claude Desktop daily for research and writing, and the part that always broke was anything that needed me to be logged into something. Claude could draft the email but could not actually go look up the customer in the CRM, log into the analytics tool, pull the actual number, and keep going. So I built this.

MultiZen runs as a desktop app next to Claude Desktop. It hosts a local MCP server on port 7777. You add it to Claude Desktop's MCP config and now Claude has tools to navigate, click, type, extract from a library of isolated Chromium profiles that you manage from a GUI. Each profile is a real Chromium with cookies, proxy, and anti-detect fingerprint that persist between runs.

The magic for me is the handoff: Claude does its part, hits a 2FA prompt, hands to me, I enter the code in the actual Chromium window that just opened, Claude picks up where it left off. Same cookies, same session, no replay nonsense.

Setup is a 3-line addition to claude_desktop_config.json. Repo has the exact snippet.

Free, MIT, runs locally. macOS, Windows, Linux. No account, no cloud, no API calls home. The anti-detect engine is open source CloakBrowser.

If you are doing anything sales-engineering shaped with Claude Desktop or just want it to actually finish authenticated tasks, this is what I would have wanted six months ago.

FIRST COMMENT:

Repo with the Claude Desktop config snippet: github.com/multizenteam/multizen-browser
Landing: getmultizen.com



=====================================================
SUBREDDIT 6: r/ChatGPTCoding
=====================================================

Members: 150k+. Broader AI-coding audience.
Screenshot to attach: profiles-list.webp
Best day: weekday morning
Flair: Resources or Show and Tell
Rules notes: explain what coding workflow problem this solves

TITLE (pick one):
  Open source MCP browser library, free, works with Cursor and Claude Desktop
  Built a local MCP server that lets your AI agent log into actual websites
  My weekend project: persistent browser sessions for AI coding agents

POST BODY:

Tools like Cursor and Claude Desktop are great at writing code that calls APIs. What they could not do well was actually use those APIs from a logged-in human session. Half my workflow involves checking dashboards, pulling numbers from internal tools, copying data between SaaS apps. None of that has clean APIs.

So I made MultiZen. It is a desktop app that runs a library of isolated Chromium profiles plus a local MCP server. Any MCP client (Cursor, Claude Desktop, Cline) gets tools to drive the browser: navigate, click, type, extract, screenshot. Profiles keep their own cookies, login state, fingerprint, proxy between sessions.

Concrete example: I have a profile pointed at our team's Notion. I tell Cursor "go pull this week's standup notes from Notion, summarize them, and append the summary to the readme". Cursor uses the MCP tools, navigates the actual Notion in a real Chromium window, extracts the content, writes the readme. No Notion API tokens to manage.

Stack is Electron + TypeScript + the official MCP SDK. Browser engine is a patched Chromium (CloakBrowser) so canvas, WebGL, audio fingerprints are real and the AI session passes most simple bot checks. MIT, no telemetry, runs locally.

The not-yet stuff: TLS fingerprint spoof is not implemented. So very aggressive bot detection (Cloudflare Enterprise, DataDome) will still flag the session.

FIRST COMMENT:

GitHub: github.com/multizenteam/multizen-browser
Site: getmultizen.com



=====================================================
SUBREDDIT 7: r/AI_Agents
=====================================================

Members: 50k+ and growing fast. Very engaged with MCP discussions.
Screenshot to attach: firstrun.webp
Best day: weekday morning
Flair: Tool or Showcase
Rules notes: be specific about agent use case, this audience hates vague "AI-powered" framing

TITLE (pick one):
  Browser library for AI agents with MCP, persistent sessions across runs
  Open source MCP browser agents can drive while humans watch in real time
  Built this because agent browser tools are either headless or just profile managers

POST BODY:

What I kept hitting building agent workflows: cloud browser services (Browserbase, Hyperbrowser) are great for parallel scraping but they reset state every session, so any task that needs persistent login state across multiple agent runs falls apart. And local browser MCPs that did exist were either pure Playwright headless (caught by everything) or just exposed profile CRUD without the navigation surface.

MultiZen is a desktop app that solves the persistent-state side. It hosts a library of isolated Chromium profiles, each with their own cookies, login, fingerprint, proxy. There is a local MCP server on port 7777 with navigate, click, type, extract, screenshot tools. Any MCP-compatible agent runtime can drive it.

The interesting part for agent design: state persists between agent invocations. So an agent that needs to log into a portal Monday and check it again Friday does not log in twice, it just opens the same profile. Cookies, IndexedDB, the works. Combined with the MCP-shared activity log, you can write multi-step workflows that span days.

Handoff to humans is built in. Agent gets stuck on a CAPTCHA, you click through in the GUI, agent continues. The Chromium window is the same window the agent is driving.

Stack: Electron, TypeScript, official MCP SDK over HTTP/SSE. Browser engine is CloakBrowser (open source patched Chromium, real anti-detect). MIT, runs locally, no account, no cloud.

Honest about limits: not built for high-parallelism. Roughly 30 to 50 profiles per machine before the resource ceiling. If you need 500 concurrent browsers, this is the wrong tool. For under-50 persistent personas it is solid.

Curious what folks here are using for the persistent-session piece. Just curious where the rough edges are.

FIRST COMMENT:

Source and binaries: github.com/multizenteam/multizen-browser
Site has architecture notes: getmultizen.com



=====================================================
SUBREDDIT 8: r/mcp (or r/ModelContextProtocol)
=====================================================

Members: small (5-10k) but exact target audience.
Screenshot to attach: profiles-list.webp
Best day: any
Flair: Server (if available)
Rules notes: easy crowd, just describe the MCP server clearly

TITLE (pick one):
  MultiZen: MCP browser server with anti-detect Chromium, MIT
  New MCP server for persistent browser sessions, open source
  MCP server that drives a library of isolated real Chromium profiles

POST BODY:

Sharing a new MCP server I built. It exposes a desktop browser library to any MCP client.

Transport: HTTP plus SSE on localhost:7777. Standard SDK build, no surprises.

Tools exposed:
list_profiles, get_profile, create_profile
launch_profile, close_profile
navigate, click, type, extract, screenshot

The "browser" here is not headless. It is a desktop GUI that hosts real Chromium windows. Each profile has its own cookies, login state, proxy, fingerprint. State persists across MCP sessions. So if the agent logs into something on Monday, calling launch_profile on Friday brings back the same session.

Anti-detect is real: the underlying binary is CloakBrowser (open source patched Chromium), so canvas, WebGL, audio, font fingerprints work at C++ level instead of JS-injection level.

Works with: Cursor, Claude Desktop, Cline, Continue, anything else that speaks MCP. Config snippet for each is in the repo readme.

MIT. macOS, Windows, Linux. No account. No telemetry. No cloud component.

Happy to answer MCP-specific questions about tool design choices (notably why I went with a single shared server vs one per profile).

FIRST COMMENT:

Repo with tool schema and setup: github.com/multizenteam/multizen-browser
getmultizen.com



=====================================================
SUBREDDIT 9: r/macapps
=====================================================

Members: ~50k. Tight community, friendly to free Mac apps.
Screenshot to attach: firstrun.webp (looks like a polished Mac app)
Best day: weekend morning is fine
Flair required: include [Mac][Free] or [Open Source] in title
Rules notes: must be actually a Mac app (we are). Mention M-series support explicitly.

TITLE (pick one):
  [Mac][Free][Open Source] MultiZen: browser library for AI agents and humans
  [Free] MultiZen for macOS: isolated browser profiles plus MCP for AI agents
  [Open Source] Desktop app that gives Claude Desktop a real browser to drive

POST BODY:

A Mac app I have been building. Runs natively on Apple Silicon (arm64 build available) and Intel. Universal in spirit, separate binaries in practice.

What it does: gives you a library of isolated Chromium profiles. Each one has its own cookies, login, proxy, fingerprint. You launch them from a GUI that feels like a calm dark-mode dashboard. The point is to keep work-related logins separated. Client A in one profile, personal in another, side project in a third, and so on.

The twist: there is a local server on port 7777 that exposes the browser to any MCP client. So if you use Claude Desktop or Cursor, you can have the AI drive any of the profiles for you. You watch in real time, intervene whenever you want, take over when it is stuck. It is a bit hard to explain without seeing it work, the readme has a video.

Free, MIT, no account, no telemetry. Built with Electron and React.

First-launch caveat: I do not have an Apple Developer ID yet (it is $99 a year, on the list when there is budget). So you will see the Gatekeeper "cannot verify" warning the first time you open the DMG. Right-click the app icon, click Open, click Open again on the dialog. After that it remembers.

Honest about what is not perfect: Universal binary would be nicer than two separate DMGs. UI density is intentionally Bloomberg-ish, might be too small for some. Activity log only goes back 200 events.

FIRST COMMENT:

DMGs for Apple Silicon and Intel: github.com/multizenteam/multizen-browser/releases/latest
Site: getmultizen.com



=====================================================
SUBREDDIT 10: r/opensource
=====================================================

Members: ~200k. Friendly to new OSS projects.
Screenshot to attach: profiles-list.webp
Best day: weekday morning
Flair: Showcase or Promotional
Rules notes: lead with the license, lead with the fact that it is actually open

TITLE (pick one):
  MultiZen: MIT-licensed browser library with MCP for AI agents, source on GitHub
  Released v0.2.1 of MultiZen, open source desktop browser plus MCP server
  Open source alternative to AdsPower and GoLogin for AI agent use cases

POST BODY:

Released v0.2.1 of a project I have been working on for a few months. Sharing here because the open source angle is genuine, not a hook.

What it is: a desktop app that runs a library of isolated Chromium profiles. Each profile has its own cookies, login state, fingerprint, proxy. There is a local MCP server so AI agents (Cursor, Claude Desktop, Cline) can drive any profile through standardized tools.

The whole stack is open:
core app under MIT (Electron, React, TypeScript)
MCP server uses the official Anthropic SDK
browser engine is CloakBrowser, which is also open source and source-patched

No closed bits, no "Pro edition with the good stuff", no license server, no telemetry, no account. The download link works offline, the app runs offline (after first-launch binary download), no part of it phones home.

I picked MIT because the alternative was open-core, which felt dishonest after seeing how that goes wrong in the AdsPower and GoLogin space (free tier that nags you constantly to upgrade). Easier to just charge for support and patches later if it makes sense.

Stack notes for fellow contributors: Yarn 4 workspaces, electron-vite, electron-builder, GitHub Actions for matrix builds across macOS arm64/x64, Windows x64, Linux x64. Tests are sparse, I am the only contributor so far. PRs welcome especially for new MCP tool surfaces and the platform spoofing layer.

FIRST COMMENT:

Repo: github.com/multizenteam/multizen-browser
Releases page has the binaries: github.com/multizenteam/multizen-browser/releases/latest
Landing: getmultizen.com



=====================================================
AFTER POSTING: WHAT TO DO
=====================================================

Reply to every comment within the first 2 hours. Reddit weighs OP engagement heavily for first-page placement.

When someone asks "how is this different from X", answer specifically and honestly. "X is great for Y, MultiZen is meant for Z" beats trying to win every comparison.

Save any thoughtful critique that comes up. Real product feedback from Reddit is more useful than the upvote count.

Do not crosspost. Each sub wants the post to be authored fresh in that community.

If a post gets removed by automod, do not repost the same content. Wait for mod reply, fix what they flag, then ask for re-approval.

If you want to track conversions: GitHub release downloads are public, you can see star deltas in real time, Yandex Metrika on the landing tracks unique visitors per referrer.
