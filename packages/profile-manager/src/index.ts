export { ProfileManager } from "./ProfileManager.js";
export {
  defaultFingerprint,
  generateFingerprint,
  reconcileFingerprint,
  reconcileDeviceFamilyToHost,
  hostPlatformFamily,
  deviceCatalog,
  localeCatalog,
  CHROME_VERSION_FULL,
  CHROME_VERSION_MAJOR,
  type DeviceCatalogEntry,
  type LocaleCatalogEntry,
} from "./fingerprint.js";
export { exportProfile, importProfile } from "./archive.js";
