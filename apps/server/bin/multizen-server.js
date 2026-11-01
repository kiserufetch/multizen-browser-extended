#!/usr/bin/env node
// Before the first async file or DNS call, which is when libuv sizes its pool for good. A name
// lookup holds a thread for as long as the resolver takes, and pages choose the names. On Windows
// libuv reads a copy of the environment this can't reach: there, set it before starting Node.
if (process.platform !== "win32") process.env.UV_THREADPOOL_SIZE ??= "64";
import("../dist/cli.js");
