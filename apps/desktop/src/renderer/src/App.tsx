import { useCallback, useEffect, useState, type JSX } from "react";
import { ProfileList } from "./components/ProfileList";
import { ProfileDetail } from "./components/ProfileDetail";
import { ActivityPanel } from "./components/ActivityPanel";
import { SettingsModal } from "./components/SettingsModal";
import type { ProfileSummary } from "./types";

type Modal =
  | { kind: "none" }
  | { kind: "detail"; profileId: string }
  | { kind: "settings" };

export function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<Modal>({ kind: "none" });

  const refresh = useCallback(async () => {
    const list = await window.multizen.profiles.list();
    setProfiles(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // re-fetch when activity events arrive (launch / close changes isRunning)
    const off = window.multizen.activity.onEvent((e) => {
      if (e.tool === "launch_profile" || e.tool === "close_profile" || e.tool === "create_profile") {
        void refresh();
      }
    });
    return off;
  }, [refresh]);

  async function createProfile(): Promise<void> {
    const name = window.prompt("Profile name");
    if (!name) return;
    const created = await window.multizen.profiles.create({ name });
    await refresh();
    setModal({ kind: "detail", profileId: created.id });
  }

  async function launchProfile(id: string): Promise<void> {
    try {
      await window.multizen.profiles.launch(id);
    } catch (e) {
      window.alert(`Launch failed: ${(e as Error).message}`);
    }
    await refresh();
  }

  async function closeProfile(id: string): Promise<void> {
    await window.multizen.profiles.close(id);
    await refresh();
  }

  async function importProfile(): Promise<void> {
    const passphrase = window.prompt(
      "Passphrase for the archive (the one used at export time):",
    );
    if (!passphrase) return;
    const result = await window.multizen.profiles.importArchive(passphrase);
    if (!result.ok) {
      if (result.reason !== "cancelled") {
        window.alert(`Import failed: ${result.reason}`);
      }
      return;
    }
    await refresh();
    setModal({ kind: "detail", profileId: result.id });
  }

  return (
    <div className="min-h-screen p-8">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="gradient-text">MultiZen</span>
          </h1>
          <p className="text-sm text-[--color-fg-muted]">
            AI-native browser for agents and operators · v0.2.0-pre
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={importProfile}
            className="px-3 h-10 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted] transition-colors"
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => setModal({ kind: "settings" })}
            className="px-3 h-10 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted] transition-colors"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={createProfile}
            className="px-4 h-10 rounded-md bg-gradient-to-r from-[--color-accent-orange] via-[--color-accent-pink] to-[--color-accent-purple] text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            + New profile
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <main>
          {loading ? (
            <div className="text-[--color-fg-muted]">Loading…</div>
          ) : (
            <ProfileList
              profiles={profiles}
              onCreate={createProfile}
              onLaunch={launchProfile}
              onClose={closeProfile}
              onOpen={(id) => setModal({ kind: "detail", profileId: id })}
            />
          )}
        </main>
        <aside>
          <ActivityPanel />
        </aside>
      </div>

      {modal.kind === "detail" && (
        <ProfileDetail
          profileId={modal.profileId}
          onClose={() => setModal({ kind: "none" })}
          onSaved={refresh}
          onDeleted={refresh}
        />
      )}
      {modal.kind === "settings" && (
        <SettingsModal onClose={() => setModal({ kind: "none" })} />
      )}
    </div>
  );
}
