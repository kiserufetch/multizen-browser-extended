import { useMemo, useState, type JSX } from "react";
import { Layers, Plus, Search, Upload } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProfileCard } from "../components/ProfileCard";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/EmptyState";
import type { ProfileSummary } from "../types";

interface Props {
  profiles: ProfileSummary[];
  loading: boolean;
  onCreate: () => void;
  onImport: () => void;
  onLaunch: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProfilesSection(props: Props): JSX.Element {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.profiles;
    return props.profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [props.profiles, search]);

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Profiles"
        description="Isolated browser sessions. Launch one manually, or let your AI agent drive it through MCP."
        actions={
          <>
            <Button variant="secondary" leftIcon={<Upload size={14} />} onClick={props.onImport}>
              Import
            </Button>
            <Button variant="primary" leftIcon={<Plus size={14} />} onClick={props.onCreate}>
              New profile
            </Button>
          </>
        }
      />

      {props.profiles.length > 0 && (
        <div className="mb-5">
          <Input
            leftIcon={<Search size={14} />}
            placeholder="Search by name or tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {props.loading ? (
        <div className="text-sm text-[--color-fg-muted]">Loading…</div>
      ) : props.profiles.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No profiles yet"
          description="Create your first browser profile. Each profile keeps cookies, login state, and a unique fingerprint isolated."
          action={
            <Button variant="primary" leftIcon={<Plus size={14} />} onClick={props.onCreate}>
              Create your first profile
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <div className="text-sm text-[--color-fg-muted] py-12 text-center">
          No matches for "{search}"
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              onLaunch={() => props.onLaunch(p.id)}
              onClose={() => props.onClose(p.id)}
              onOpen={() => props.onOpen(p.id)}
              onExport={() => props.onExport(p.id)}
              onDelete={() => props.onDelete(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
