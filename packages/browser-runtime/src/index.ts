export * from "./host.ts";
export * from "./ChromiumBootstrap.ts";
export * from "./CamoufoxBootstrap.ts";
export * from "./ChromiumBrowserDriver.ts";
// Type only, never a value export. camoufox-js freezes its install dir when it
// loads, and CamoufoxBootstrap sets CAMOUFOX_INSTALL_DIR just before importing
// it, so loading this module any earlier would resolve the wrong dir. It also
// keeps camoufox-js and playwright-core out of Chromium-only startup. The router
// imports it lazily on the first Camoufox launch.
export type { FirefoxBrowserDriver, FirefoxBrowserDriverOptions } from "./FirefoxBrowserDriver.ts";
export * from "./engineRegistry.ts";
export * from "./engineRouter.ts";
export * from "./displayMode.ts";
export * from "./xvfb.ts";
export * from "./browserLimiter.ts";
export * from "./egressPolicy.ts";
export * from "./socks5Bridge.ts";
export * from "./proxyGeo.ts";
export * from "./launchGeo.ts";
export * from "./launchTimezone.ts";
export * from "./cdpReadiness.ts";
export * from "./processTree.ts";
export * from "./portProbe.ts";
export * from "./serverLock.ts";
export * from "./runState.ts";
export * from "./firefoxFingerprint.ts";
export * from "./startPage.ts";
export * from "./linuxSandbox.ts";
export * from "./extensions/ExtensionsService.ts";
export * from "./extensions/companion.ts";
export * from "./extensions/crxPipeline.ts";
export * from "./extensions/extensionStore.ts";
export * from "./extensions/webstoreDownload.ts";
