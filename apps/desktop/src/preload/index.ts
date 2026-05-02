import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  UpdateProfileInput,
  LaunchedProfile,
} from "@multizen/types";
import type { ActivityEvent } from "@multizen/mcp-server";
import type { AppSettings } from "@multizen/settings-store";

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
};

contextBridge.exposeInMainWorld("multizen", api);

export type MultizenApi = typeof api;
