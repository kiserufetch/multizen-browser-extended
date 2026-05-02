import { type JSX } from "react";
import { ArrowRight, Bot, Layers, Sparkles } from "lucide-react";
import { Button } from "./ui/Button";

interface Props {
  onDone: () => void;
}

export function Onboarding({ onDone }: Props): JSX.Element {
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

      <div className="relative w-full max-w-md mx-6 rounded-2xl bg-white/[0.02] ring-1 ring-white/5 p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex justify-center mb-6">
          <img src="/icon.png" alt="" width={64} height={64} className="rounded-xl" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-center mb-2">
          Welcome to <span className="gradient-text">MultiZen</span>
        </h1>
        <p className="text-sm text-slate-400 text-center leading-relaxed mb-8">
          An AI-native browser for agents and operators. Isolated profiles, anti-detect
          fingerprints, and full MCP control — all on your machine.
        </p>

        <div className="space-y-3 mb-8">
          <Bullet icon={<Sparkles size={14} />} text="Drive browsers from Cursor or Claude Desktop via MCP" />
          <Bullet icon={<Layers size={14} />} text="Each profile keeps cookies, login state and a unique fingerprint" />
          <Bullet icon={<Bot size={14} />} text="AI agent or human operator — same profiles, shared state" />
        </div>

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          rightIcon={<ArrowRight size={14} />}
          onClick={onDone}
        >
          Create my first profile
        </Button>
      </div>
    </div>
  );
}

function Bullet({ icon, text }: { icon: React.ReactNode; text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-7 h-7 rounded-md bg-white/[0.02] ring-1 ring-white/5 flex items-center justify-center text-purple-400 shrink-0">
        {icon}
      </span>
      <span className="leading-relaxed text-slate-400">{text}</span>
    </div>
  );
}
