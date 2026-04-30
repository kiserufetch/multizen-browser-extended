import { useCallback, useEffect, useState, type JSX } from "react";
import { Sidebar, type Section } from "./components/Sidebar";
import { ProfilesSection } from "./sections/ProfilesSection";
import { ActivitySection } from "./sections/ActivitySection";
import { SettingsSection } from "./sections/SettingsSection";
import { ProfileDetail } from "./components/ProfileDetail";
import { CreateProfileModal } from "./components/CreateProfileModal";
import { PromptModal } from "./components/PromptModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { Onboarding } from "./components/Onboarding";
import type { ProfileSummary } from "./types";

type Modal =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "detail"; profileId: string }
  | { kind: "import-passphrase" }
  | { kind: "export-passphrase"; profileId: string }
  | { kind: "delete-confirm"; profileId: string };

const ONBOARDING_KEY = "multizen.onboarded";

export function App(): JSX.Element {
  const [section, setSection] = useState<Section>("profiles");
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [toast, setToast] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(ONBOARDING_KEY);
  });

  const refresh = useCallback(async () => {
    if (!window.multizen) {
      setLoading(false);
      return;
    }
    const list = await window.multizen.profiles.list();
    setProfiles(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.multizen) return;
    const off = window.multizen.activity.onEvent((e) => {
      if (
        e.tool === "launch_profile" ||
        e.tool === "close_profile" ||
        e.tool === "create_profile"
      ) {
        void refresh();
      }
    });
    return off;
  }, [refresh]);

  function showToast(msg: string): void {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }

  function dismissOnboarding(): void {
    window.localStorage.setItem(ONBOARDING_KEY, "1");
    setShowOnboarding(false);
    setModal({ kind: "create" });
  }

  async function launchProfile(id: string): Promise<void> {
    try {
      await window.multizen.profiles.launch(id);
    } catch (e) {
      showToast(`Launch failed: ${(e as Error).message}`);
    }
    await refresh();
  }

  async function closeProfile(id: string): Promise<void> {
    await window.multizen.profiles.close(id);
    await refresh();
  }

  async function importProfile(passphrase: string): Promise<void> {
    setModal({ kind: "none" });
    const result = await window.multizen.profiles.importArchive(passphrase);
    if (!result.ok) {
      if (result.reason !== "cancelled") {
        showToast(`Import failed: ${result.reason}`);
      }
      return;
    }
    await refresh();
    setModal({ kind: "detail", profileId: result.id });
  }

  async function exportProfile(profileId: string, passphrase: string): Promise<void> {
    setModal({ kind: "none" });
    if (passphrase.length < 8) {
      showToast("Passphrase must be at least 8 characters");
      return;
    }
    const result = await window.multizen.profiles.exportArchive(profileId, passphrase);
    if (result.ok) {
      showToast(`Exported to ${result.path.split("/").slice(-1)[0]}`);
    } else if (result.reason !== "cancelled") {
      showToast(`Export failed: ${result.reason}`);
    }
  }

  async function deleteProfile(id: string): Promise<void> {
    setModal({ kind: "none" });
    await window.multizen.profiles.close(id).catch(() => {});
    await window.multizen.profiles.delete(id);
    await refresh();
  }

  const runningCount = profiles.filter((p) => p.isRunning).length;

  if (showOnboarding && window.multizen) {
    return <Onboarding onDone={dismissOnboarding} />;
  }

  return (
    <div className="h-screen flex">
      <Sidebar current={section} onChange={setSection} runningCount={runningCount} />

      <div className="flex-1 overflow-y-auto">
        {!window.multizen && (
          <div className="m-6 px-4 py-3 rounded-md border border-[--color-danger]/30 bg-[--color-danger]/10 text-sm text-[--color-danger]">
            Preload bridge missing — <code>window.multizen</code> is undefined. Open DevTools
            (View → Toggle Developer Tools) for details.
          </div>
        )}

        <div className="p-8">
          {section === "profiles" && (
            <ProfilesSection
              profiles={profiles}
              loading={loading}
              onCreate={() => setModal({ kind: "create" })}
              onImport={() => setModal({ kind: "import-passphrase" })}
              onLaunch={launchProfile}
              onClose={closeProfile}
              onOpen={(id) => setModal({ kind: "detail", profileId: id })}
              onExport={(id) => setModal({ kind: "export-passphrase", profileId: id })}
              onDelete={(id) => setModal({ kind: "delete-confirm", profileId: id })}
            />
          )}
          {section === "activity" && <ActivitySection />}
          {section === "settings" && <SettingsSection />}
        </div>
      </div>

      <CreateProfileModal
        open={modal.kind === "create"}
        onClose={() => setModal({ kind: "none" })}
        onCreated={(id) => setModal({ kind: "detail", profileId: id })}
      />

      {modal.kind === "detail" && (
        <ProfileDetail
          profileId={modal.profileId}
          onClose={() => setModal({ kind: "none" })}
          onSaved={refresh}
          onDeleted={refresh}
          onExport={(id) => setModal({ kind: "export-passphrase", profileId: id })}
          onDelete={(id) => setModal({ kind: "delete-confirm", profileId: id })}
        />
      )}

      <PromptModal
        open={modal.kind === "import-passphrase"}
        title="Import profile archive"
        description="Choose a .mzar file. Provide the passphrase used at export."
        label="Passphrase"
        inputType="password"
        placeholder="Passphrase"
        confirmLabel="Choose file & import"
        onSubmit={importProfile}
        onCancel={() => setModal({ kind: "none" })}
      />

      <PromptModal
        open={modal.kind === "export-passphrase"}
        title="Export profile archive"
        description="Choose a passphrase to encrypt the archive. You'll need it to import this profile elsewhere. Minimum 8 characters."
        label="New passphrase"
        inputType="password"
        placeholder="At least 8 characters"
        confirmLabel="Encrypt & save…"
        onSubmit={(p) => {
          if (modal.kind === "export-passphrase") {
            return exportProfile(modal.profileId, p);
          }
          return Promise.resolve();
        }}
        onCancel={() => setModal({ kind: "none" })}
      />

      <ConfirmModal
        open={modal.kind === "delete-confirm"}
        title="Delete this profile?"
        description="Cookies, login state, and on-disk data will be erased permanently. This cannot be undone."
        confirmLabel="Yes, delete"
        destructive
        onConfirm={() => {
          if (modal.kind === "delete-confirm") {
            void deleteProfile(modal.profileId);
          }
        }}
        onCancel={() => setModal({ kind: "none" })}
      />

      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-3 rounded-md surface-1 shadow-[var(--shadow-modal)] text-sm animate-[slideUp_200ms_ease-out]">
          {toast}
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
