import { useState, type JSX } from "react";
import { Modal, ModalFooter } from "./ui/Modal";
import { Input, Textarea, Label } from "./ui/Input";
import { Button } from "./ui/Button";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function CreateProfileModal({ open, onClose, onCreated }: Props): JSX.Element {
  const [name, setName] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setName("");
    setTagsRaw("");
    setNotes("");
    setError(null);
    setBusy(false);
  }

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tags = tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await window.multizen.profiles.create({
        name: name.trim(),
        tags,
        notes: notes.trim() || undefined,
      });
      reset();
      onCreated(created.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New profile"
      description="Each profile is an isolated browser session with its own cookies, login state, and fingerprint."
    >
      <div className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            autoFocus
            placeholder="e.g. sarah-sales"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submit();
            }}
          />
        </div>
        <div>
          <Label>Tags</Label>
          <Input
            placeholder="linkedin, sales, eu (comma-separated)"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
          />
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea
            rows={3}
            placeholder="What this profile is for, which proxy to use, etc."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && (
          <div className="px-3 py-2 rounded-md border border-[--color-danger]/30 bg-[--color-danger]/10 text-xs text-[--color-danger]">
            {error}
          </div>
        )}
      </div>

      <ModalFooter>
        <Button
          variant="ghost"
          onClick={() => {
            reset();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? "Creating…" : "Create profile"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
