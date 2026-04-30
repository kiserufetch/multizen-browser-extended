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

export interface SystemInfo {
  mcpHttpUrl: string | null;
  appVersion: string;
  platform: string;
}

export interface MultizenApi {
  profiles: {
    list: () => Promise<ProfileSummary[]>;
    get: (id: ProfileId) => Promise<Profile | null>;
    create: (input: CreateProfileInput) => Promise<Profile>;
    update: (id: ProfileId, patch: UpdateProfileInput) => Promise<Profile>;
    delete: (id: ProfileId) => Promise<void>;
    launch: (id: ProfileId) => Promise<LaunchedProfile>;
    close: (id: ProfileId) => Promise<void>;
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
    importArchive: (
      passphrase: string,
    ) => Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  activity: {
    recent: () => Promise<ActivityEvent[]>;
    onEvent: (cb: (e: ActivityEvent) => void) => () => void;
  };
  system: {
    info: () => Promise<SystemInfo>;
  };
}

declare global {
  interface Window {
    multizen: MultizenApi;
  }
}

export type { ActivityEvent, AppSettings, Profile, ProfileSummary, LaunchedProfile };
