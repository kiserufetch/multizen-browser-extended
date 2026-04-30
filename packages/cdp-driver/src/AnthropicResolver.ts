import type { ExtractContext, NaturalLanguageResolver } from "./types.js";

export interface AnthropicResolverOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * BYOK Anthropic resolver. The user provides their own API key in
 * MultiZen settings. We never proxy keys through our own infrastructure.
 *
 * Used for two things:
 *   1. Natural-language click target resolution
 *   2. Natural-language structured data extraction
 */
export class AnthropicResolver implements NaturalLanguageResolver {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicResolverOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async resolveClickTarget(snapshot: ExtractContext, description: string): Promise<number | null> {
    const prompt = [
      `You are helping locate a specific element on a web page.`,
      `Page URL: ${snapshot.url}`,
      `Page title: ${snapshot.title}`,
      `User wants to click: "${description}"`,
      ``,
      `Here is the accessibility tree (trimmed):`,
      JSON.stringify(snapshot.accessibilityTree, null, 2).slice(0, 12000),
      ``,
      `Find the single best matching element. Reply with ONLY a JSON object:`,
      `{"backendNodeId": <number>}`,
      `or {"backendNodeId": null} if you can't find a confident match.`,
      `Do not include any other text, code fences, or explanation.`,
    ].join("\n");

    const text = await this.callClaude(prompt, 200);
    try {
      const parsed = JSON.parse(extractJson(text)) as { backendNodeId: number | null };
      return parsed.backendNodeId ?? null;
    } catch {
      return null;
    }
  }

  async extract(snapshot: ExtractContext, query: string): Promise<unknown> {
    const treeJson = JSON.stringify(snapshot.accessibilityTree).slice(0, 18000);
    const fallback = snapshot.textContent ? `\n\nText fallback (first 6000 chars):\n${snapshot.textContent.slice(0, 6000)}` : "";

    const prompt = [
      `Extract structured data from this web page.`,
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      `Query: ${query}`,
      ``,
      `Accessibility tree (trimmed):`,
      treeJson,
      fallback,
      ``,
      `Reply with ONLY a JSON value (object, array, or primitive) representing the extracted data.`,
      `Do not include code fences or explanation. If the requested data is not on the page, return null.`,
    ].join("\n");

    const text = await this.callClaude(prompt, 4000);
    try {
      return JSON.parse(extractJson(text));
    } catch {
      // Return raw text as fallback
      return { _raw: text };
    }
  }

  private async callClaude(prompt: string, maxTokens: number): Promise<string> {
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const block = json.content.find((c) => c.type === "text");
    return block?.text ?? "";
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  // Strip optional code fences
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1]) return fenceMatch[1];
  return trimmed;
}
