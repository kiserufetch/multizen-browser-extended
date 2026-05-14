SignPath.io Free OSS Application Draft
=========================================

SignPath offers free code signing for qualifying open-source projects. If approved, we get genuine code signatures for Windows (and CI integration) without paying for an EV cert or HSM. Apply at https://about.signpath.io/foundation/apply.

Apply from the project maintainer account (the GitHub user who owns multizenteam org). The application form asks for:

PROJECT NAME
MultiZen

PROJECT HOMEPAGE
https://getmultizen.com

GITHUB / SOURCE REPO
https://github.com/multizenteam/multizen-browser

LICENSE
MIT (with one source-patched binary dependency, CloakBrowser, which is also open source)

SHORT DESCRIPTION (one to two sentences)
MultiZen is a desktop app that runs a library of isolated Chromium browser profiles and exposes them to AI agents through a built-in Model Context Protocol (MCP) server. Each profile keeps its own cookies, fingerprint, and proxy, so Cursor, Claude Desktop, or any MCP client can drive a real browser while a human watches and can take over for CAPTCHAs or 2FA prompts.

LONG DESCRIPTION (project context)
The project pivoted in April 2026 from a multi-session Vue browser to an AI-native MCP browser, with a full rewrite to Electron + React + TypeScript + an open-source patched Chromium engine (CloakBrowser). It is positioned for solo developers, sales engineering teams, QA testing across regions, and small agencies running multi-account authenticated workflows. The desktop app phones home for nothing, has no telemetry, no license server, no account requirement. The MCP server runs on localhost only.

We currently ship a v0.2.3 release with CI-built artifacts for macOS arm64/x64, Windows x64, and Linux x86_64. Downloads are public on GitHub releases. Windows installer is unsigned today because Microsoft's EV-cert-on-hardware-HSM requirement is out of reach for a solo founder. The lack of a SmartScreen-passing signature is a meaningful adoption barrier on Windows.

WHY SIGNPATH WOULD HELP
1) Windows users hit SmartScreen on every install and many give up. A genuine signature plus eventual reputation building solves this without the $300+/yr EV-cert-with-HSM friction.
2) CI integration is already in place (GitHub Actions matrix build calls electron-builder with the signing config). Adding a signed step is a one-line config change.
3) macOS notarization is the other pain point. While SignPath is primarily Windows-focused, the Foundation also covers Apple Developer Program fees for qualifying projects.

CI / RELEASE WORKFLOW
- GitHub Actions, .github/workflows/release.yml, triggered on git tag push v*.
- electron-builder publishes to GitHub Releases via the auto-provided GH_TOKEN.
- Three OS runners build in parallel: macos-latest, windows-latest, ubuntu-latest.
- Artifacts: DMG + zip for mac, NSIS installer for win, AppImage for linux.

TECHNICAL CONTACTS
GitHub: @oboshto (maintainer)
Email: hello@getmultizen.com
Discord: https://discord.gg/pd6MhzPbJ3

NOTES FOR REVIEWERS
The CloakBrowser binary (open source patched Chromium) is downloaded by the app on first run from its own GitHub releases, hash-verified, and run locally. It is not part of the MultiZen installer itself. The MultiZen installer only contains the Electron shell + the JS/TS application code.

The project does include anti-detect / fingerprint manipulation features intended for legitimate uses (QA testing across regions, multi-account workflows the user is authorized to run, AI-driven research). We have a published acceptable-use policy at https://getmultizen.com/acceptable-use that explicitly prohibits TOS violations, mass account farming, ban evasion, and fraud.



POST-APPLICATION STEPS

Once approved, SignPath sends back a project ID and CI integration token. The release workflow needs three changes:

1) Add a SignPath signing step after electron-builder produces the unsigned EXE / DMG. SignPath provides a GitHub Action (their docs).

2) Switch electron-builder to skip its own Windows signing (we have none) and let SignPath handle it post-build. In electron-builder.yml the win section stays as-is, but we add a post-build hook.

3) Add the SignPath organization secret to the multizenteam/multizen-browser repo settings.

Expected response time from SignPath Foundation: 2 to 4 weeks during normal periods. Free tier has a monthly signing quota that easily covers our release cadence.
