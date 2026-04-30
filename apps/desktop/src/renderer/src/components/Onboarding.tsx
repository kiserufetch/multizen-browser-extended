import { useState, type JSX } from "react";
import { ArrowRight, Bot, KeyRound, Sparkles } from "lucide-react";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";

interface Props {
  onDone: () => void;
}

type Step = "welcome" | "key" | "ready";

export function Onboarding({ onDone }: Props): JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function saveKey(skip: boolean): Promise<void> {
    setBusy(true);
    try {
      if (!skip && keyDraft.trim()) {
        await window.multizen.settings.update({ anthropicApiKey: keyDraft.trim() });
      }
      setStep("ready");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[--color-bg]">
      <div
        className="absolute inset-0 pointer-events-none opacity-50"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 50% 40% at 50% 30%, rgba(139, 92, 246, 0.15), transparent), radial-gradient(ellipse 40% 30% at 70% 70%, rgba(255, 61, 138, 0.08), transparent)",
        }}
      />

      <div className="relative w-full max-w-md mx-6 surface-1 rounded-2xl p-8 shadow-[var(--shadow-modal)]">
        {step === "welcome" && (
          <>
            <div className="flex justify-center mb-6">
              <img src="/icon.png" alt="" width={64} height={64} className="rounded-xl" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-center mb-2">
              Welcome to <span className="gradient-text">MultiZen</span>
            </h1>
            <p className="text-sm text-[--color-fg-muted] text-center leading-relaxed mb-8">
              An AI-native browser for agents and operators. Isolated profiles, anti-detect
              fingerprints, and full MCP control — all on your machine.
            </p>

            <div className="space-y-3 mb-8">
              <Bullet icon={<Sparkles size={14} />} text="Drive browsers from Cursor or Claude Desktop via MCP" />
              <Bullet icon={<KeyRound size={14} />} text="Each profile keeps cookies, login state and a unique fingerprint" />
              <Bullet icon={<Bot size={14} />} text="AI agent or human operator — same profiles, shared state" />
            </div>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              rightIcon={<ArrowRight size={14} />}
              onClick={() => setStep("key")}
            >
              Get started
            </Button>
          </>
        )}

        {step === "key" && (
          <>
            <div className="flex justify-center mb-5">
              <div className="w-12 h-12 rounded-xl surface-2 flex items-center justify-center text-[--color-accent-pink]">
                <KeyRound size={20} />
              </div>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-center mb-2">
              Connect your Anthropic key
            </h2>
            <p className="text-sm text-[--color-fg-muted] text-center leading-relaxed mb-6">
              Optional. Powers natural-language click and extract. Stays in your OS keychain —
              never proxied through MultiZen servers. You can add or change it later.
            </p>

            <Label>API key</Label>
            <Input
              autoFocus
              type="password"
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              className="font-mono mb-6"
            />

            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => void saveKey(true)}>
                Skip for now
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={busy || !keyDraft.trim()}
                onClick={() => void saveKey(false)}
              >
                {busy ? "Saving…" : "Save & continue"}
              </Button>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <div className="flex justify-center mb-5">
              <div className="w-12 h-12 rounded-full gradient-bg flex items-center justify-center">
                <Sparkles size={22} className="text-white" />
              </div>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-center mb-2">
              You're all set
            </h2>
            <p className="text-sm text-[--color-fg-muted] text-center leading-relaxed mb-8">
              Create your first profile to get going. Each profile is its own isolated browser
              session — perfect for one client, one persona, or one workflow.
            </p>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              rightIcon={<ArrowRight size={14} />}
              onClick={onDone}
            >
              Create my first profile
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Bullet({ icon, text }: { icon: React.ReactNode; text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-7 h-7 rounded-md surface-2 flex items-center justify-center text-[--color-accent-pink] shrink-0">
        {icon}
      </span>
      <span className="leading-relaxed text-[--color-fg-muted]">{text}</span>
    </div>
  );
}
