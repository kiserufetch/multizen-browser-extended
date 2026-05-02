import { useState, type JSX } from "react";
import { Cube, Kbd } from "../atoms";

interface Props {
  onCreate: (name: string, tags: string[]) => Promise<void>;
}

/**
 * Two-step first-run. We omit the Anthropic-key step from the original
 * Claude Design output because MultiZen no longer calls any external API.
 */
export function FirstRun({ onCreate }: Props): JSX.Element {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("acme — sales · west");
  const [tags, setTags] = useState("linkedin, client-acme");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), tags.split(",").map((s) => s.trim()).filter(Boolean));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background: "#0a0b0f",
        padding: 48,
        overflow: "hidden",
      }}
    >
      {/* Halo */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(168,85,247,0.10), transparent 70%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      />

      <div
        className="relative flex flex-col items-center gap-5 text-center"
        style={{ maxWidth: 520 }}
      >
        <Cube size={88} />

        {step === 1 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em" }}
              >
                A library of isolated browsers.
              </div>
              <div className="text-[14px] text-slate-400 mt-3 leading-relaxed">
                Each profile keeps its own cookies, login state, fingerprint, and proxy. Launch them
                yourself, or let Claude drive them via MCP — and watch every tool call stream in.
              </div>
            </div>
            <div className="flex gap-6 mt-1.5 mono text-[11px] text-slate-500">
              <span>macOS · Windows</span>
              <span>·</span>
              <span>Chromium</span>
              <span>·</span>
              <span>MCP HTTP</span>
            </div>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="btn-brand text-[13px] mt-2"
              style={{ padding: "10px 16px", borderRadius: 11 }}
            >
              Continue
              <Kbd>⏎</Kbd>
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <div
                className="font-bold tracking-tight text-slate-100"
                style={{ fontSize: 26, lineHeight: 1.15, letterSpacing: "-0.01em" }}
              >
                Create your first profile.
              </div>
              <div className="text-[13px] text-slate-400 mt-2.5 leading-relaxed">
                Give it a name and a tag. You can edit fingerprint, proxy, and notes anytime.
              </div>
            </div>
            <div
              className="w-full flex flex-col gap-2.5 text-left"
              style={{
                padding: 14,
                borderRadius: 14,
                background: "rgba(255,255,255,0.025)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
              }}
            >
              <Field label="Name">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input mono"
                />
              </Field>
              <Field label="Tags">
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="comma-separated"
                  className="input mono"
                />
              </Field>
            </div>
            <button
              type="button"
              disabled={busy || !name.trim()}
              onClick={() => void submit()}
              className="btn-brand text-[13px] mt-2"
              style={{ padding: "10px 16px", borderRadius: 11 }}
            >
              {busy ? "Creating…" : "Create profile"}
              <Kbd>⌘ ⏎</Kbd>
            </button>
          </>
        )}

        {/* Step indicator */}
        <div className="flex gap-1.5 mt-2">
          {[1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: i === step ? 22 : 6,
                height: 6,
                borderRadius: 3,
                background: i === step ? "linear-gradient(90deg, #a855f7, #ec4899)" : "rgba(255,255,255,0.08)",
                transition: "width 240ms cubic-bezier(0.2,0.8,0.2,1)",
              }}
            />
          ))}
        </div>
      </div>

      <style>{`
        .input {
          padding: 8px 11px;
          border-radius: 9px;
          background: rgba(255,255,255,0.04);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 500;
          width: 100%;
          border: 0;
          outline: 0;
        }
        .input:focus {
          box-shadow: inset 0 0 0 1px rgba(168,85,247,0.4);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}
