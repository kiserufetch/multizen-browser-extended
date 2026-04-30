import { useEffect, useState } from "react";
import type { ProfileSummary } from "@multizen/types";

declare global {
  interface Window {
    multizen: {
      profiles: {
        list: () => Promise<ProfileSummary[]>;
        create: (input: { name: string; tags?: string[] }) => Promise<{ id: string }>;
        delete: (id: string) => Promise<void>;
        launch: (id: string) => Promise<{ cdpEndpoint: string }>;
        close: (id: string) => Promise<void>;
      };
    };
  }
}

export function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    const list = await window.multizen.profiles.list();
    setProfiles(list);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createProfile(): Promise<void> {
    const name = window.prompt("Profile name");
    if (!name) return;
    await window.multizen.profiles.create({ name });
    await refresh();
  }

  async function launchProfile(id: string): Promise<void> {
    await window.multizen.profiles.launch(id);
    await refresh();
  }

  async function closeProfile(id: string): Promise<void> {
    await window.multizen.profiles.close(id);
    await refresh();
  }

  async function deleteProfile(id: string): Promise<void> {
    if (!window.confirm("Delete this profile? Cookies and state will be lost.")) return;
    await window.multizen.profiles.delete(id);
    await refresh();
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
        <button
          type="button"
          onClick={createProfile}
          className="px-4 h-10 rounded-md bg-gradient-to-r from-[--color-accent-orange] via-[--color-accent-pink] to-[--color-accent-purple] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          + New profile
        </button>
      </header>

      <main>
        {loading && <div className="text-[--color-fg-muted]">Loading…</div>}
        {!loading && profiles.length === 0 && (
          <div className="text-center py-20 border border-dashed border-[--color-border] rounded-xl">
            <p className="text-[--color-fg-muted] mb-2">No profiles yet.</p>
            <button
              type="button"
              onClick={createProfile}
              className="text-sm text-[--color-accent-pink] hover:underline"
            >
              Create your first profile
            </button>
          </div>
        )}
        {!loading && profiles.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {profiles.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-[--color-border] bg-[--color-bg-elevated] p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold">{p.name}</h3>
                  {p.isRunning && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[--color-accent-pink]/15 text-[--color-accent-pink]">
                      running
                    </span>
                  )}
                </div>
                {p.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap mb-3">
                    {p.tags.map((t) => (
                      <span key={t} className="text-xs px-2 py-0.5 rounded bg-[--color-bg]">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="text-xs text-[--color-fg-dim] mb-4 font-mono truncate">
                  {p.id}
                </div>
                <div className="flex gap-2">
                  {!p.isRunning ? (
                    <button
                      type="button"
                      onClick={() => launchProfile(p.id)}
                      className="flex-1 h-9 rounded-md bg-[--color-accent-purple]/10 text-[--color-accent-purple] text-sm hover:bg-[--color-accent-purple]/20"
                    >
                      Launch
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => closeProfile(p.id)}
                      className="flex-1 h-9 rounded-md border border-[--color-border] text-sm hover:border-[--color-fg-muted]"
                    >
                      Close
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteProfile(p.id)}
                    className="h-9 px-3 rounded-md border border-[--color-border] text-sm text-[--color-fg-muted] hover:text-[--color-fg]"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
