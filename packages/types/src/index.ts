export type ProfileId = string;

export interface ProxyConfig {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface FingerprintConfig {
  userAgent?: string;
  locale: string;
  timezone: string;
  screen: { width: number; height: number };
  webgl?: {
    vendor: string;
    renderer: string;
  };
  hardwareConcurrency?: number;
  deviceMemory?: number;
  platform?: "MacIntel" | "Win32" | "Linux x86_64";
}

export interface Profile {
  id: ProfileId;
  name: string;
  notes?: string;
  tags: string[];
  proxy?: ProxyConfig;
  fingerprint: FingerprintConfig;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  tags: string[];
  lastOpenedAt?: string;
  isRunning: boolean;
}

export interface CreateProfileInput {
  name: string;
  notes?: string;
  tags?: string[];
  proxy?: ProxyConfig;
  fingerprint?: Partial<FingerprintConfig>;
}

export interface UpdateProfileInput {
  name?: string;
  notes?: string;
  tags?: string[];
  proxy?: ProxyConfig | null;
  fingerprint?: Partial<FingerprintConfig>;
}

export interface LaunchedProfile {
  id: ProfileId;
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
}

export interface McpToolError {
  code: "PROFILE_NOT_FOUND" | "PROFILE_ALREADY_RUNNING" | "PROFILE_NOT_RUNNING" | "LAUNCH_FAILED" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
}
