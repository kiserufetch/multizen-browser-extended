import type { Metafile } from "esbuild";

export function build(opts?: { outdir?: string }): Promise<Metafile>;
