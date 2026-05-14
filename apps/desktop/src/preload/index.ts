import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  UpdateProfileInput,
  LaunchedProfile,
  FingerprintConfig,
} from "@multizen/types";
import type { ActivityEvent } from "@multizen/mcp-server";
import type { AppSettings } from "@multizen/settings-store";
import type { ChromiumStatus, DeviceFamily, ProxyConfig } from "@multizen/types";

export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
}

/** Mirror of the catalog types from @multizen/profile-manager. */
export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}
export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}
export interface FingerprintReconcilePatch {
  device?: DeviceFamily;
  localeId?: string;
  screen?: { width: number; height: number };
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

interface SystemInfo {
  mcpHttpUrl: string | null;
  appVersion: string;
  platform: NodeJS.Platform;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

const api = {
  profiles: {
    list: (): Promise<ProfileSummary[]> => ipcRenderer.invoke("profiles:list"),
    get: (id: ProfileId): Promise<Profile | null> => ipcRenderer.invoke("profiles:get", id),
    create: (input: CreateProfileInput): Promise<Profile> =>
      ipcRenderer.invoke("profiles:create", input),
    update: (id: ProfileId, patch: UpdateProfileInput): Promise<Profile> =>
      ipcRenderer.invoke("profiles:update", id, patch),
    delete: (id: ProfileId): Promise<void> => ipcRenderer.invoke("profiles:delete", id),
    launch: (id: ProfileId): Promise<LaunchedProfile> =>
      ipcRenderer.invoke("profiles:launch", id),
    close: (id: ProfileId): Promise<void> => ipcRenderer.invoke("profiles:close", id),
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke("profiles:export", id, passphrase),
    importArchive: (
      passphrase: string,
    ): Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }> =>
      ipcRenderer.invoke("profiles:import", passphrase),
    onRunningChanged: (cb: (change: RunningStateChange) => void): (() => void) => {
      const listener = (_: unknown, change: RunningStateChange): void => cb(change);
      ipcRenderer.on("profiles:running-changed", listener);
      return () => ipcRenderer.off("profiles:running-changed", listener);
    },
    onProxyCountryUpdated: (
      cb: (update: { id: string; country: string }) => void,
    ): (() => void) => {
      const listener = (
        _: unknown,
        update: { id: string; country: string },
      ): void => cb(update);
      ipcRenderer.on("profiles:proxy-country-updated", listener);
      return () => ipcRenderer.off("profiles:proxy-country-updated", listener);
    },
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke("settings:update", patch),
  },
  activity: {
    recent: (): Promise<ActivityEvent[]> => ipcRenderer.invoke("activity:recent"),
    onEvent: (cb: (e: ActivityEvent) => void): (() => void) => {
      const listener = (_: unknown, e: ActivityEvent): void => cb(e);
      ipcRenderer.on("activity:event", listener);
      return () => ipcRenderer.off("activity:event", listener);
    },
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke("system:info"),
  },
  chromium: {
    status: (): Promise<ChromiumStatus> => ipcRenderer.invoke("chromium:status"),
    retry: (): Promise<ChromiumStatus> => ipcRenderer.invoke("chromium:retry"),
    onStatus: (cb: (status: ChromiumStatus) => void): (() => void) => {
      const listener = (_: unknown, status: ChromiumStatus): void => cb(status);
      ipcRenderer.on("chromium:status", listener);
      return () => ipcRenderer.off("chromium:status", listener);
    },
  },
  fingerprint: {
    generate: (): Promise<FingerprintConfig> =>
      ipcRenderer.invoke("fingerprint:generate"),
    devices: (): Promise<ReadonlyArray<DeviceCatalogEntry>> =>
      ipcRenderer.invoke("fingerprint:devices"),
    locales: (): Promise<ReadonlyArray<LocaleCatalogEntry>> =>
      ipcRenderer.invoke("fingerprint:locales"),
    reconcile: (
      current: FingerprintConfig,
      patch: FingerprintReconcilePatch,
    ): Promise<FingerprintConfig> =>
      ipcRenderer.invoke("fingerprint:reconcile", current, patch),
    localeForCountry: (cc: string): Promise<string | null> =>
      ipcRenderer.invoke("fingerprint:localeForCountry", cc),
  },
  proxy: {
    detectGeo: (
      proxy: ProxyConfig,
      profileId?: string,
    ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> =>
      ipcRenderer.invoke("proxy:detectGeo", proxy, profileId),
  },
};

contextBridge.exposeInMainWorld("multizen", api);

export type MultizenApi = typeof api;
