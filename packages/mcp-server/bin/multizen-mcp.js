#!/usr/bin/env node
// No build step: the workspace packages export TypeScript sources, so even a
// compiled standalone could not load them. Run the source through tsx.
import { register } from "tsx/esm/api";

register();
await import("../src/standalone.ts");
