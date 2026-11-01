export { ProfileManager, type DataDirReconciliation, type StoredSecrets } from "./ProfileManager.js";
export {
  createSecretBox,
  generateSecretKey,
  isSealed,
  parseSecretKey,
  SecretKeyError,
  type SecretBox,
} from "./secretBox.js";
export {
  defaultFingerprint,
  generateFingerprint,
  reconcileFingerprint,
  FingerprintReconcileError,
  hostPlatformFamily,
  deviceCatalog,
  localeCatalog,
  findLocaleIdByCountry,
  CHROME_VERSION_FULL,
  CHROME_VERSION_MAJOR,
  reducedUserAgent,
  deviceMemoryApiValue,
  type DeviceCatalogEntry,
  type LocaleCatalogEntry,
  type GenerateFingerprintOptions,
} from "./fingerprint.js";
export { exportProfile, importProfile } from "./archive.js";
export {
  archiveFileName,
  exportProfileToArchive,
  importProfileFromArchive,
  type ImportFromArchiveOptions,
  type ImportedArchive,
} from "./transfer.js";
