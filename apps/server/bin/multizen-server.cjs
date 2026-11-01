#!/usr/bin/env node
// CommonJS on purpose. libuv sizes its pool at the first async file or DNS call, and Node up to at
// least 22.14 reads an ES module entry with async fs: from such a file this line runs too late, and
// the pool stays at 4. A name lookup holds a thread for as long as the resolver takes, and pages
// choose the names. On Windows libuv reads a copy of the environment this can't reach: there, set
// it before starting Node.
if (process.platform !== "win32") process.env.UV_THREADPOOL_SIZE ??= "64";
import("../dist/cli.js");
