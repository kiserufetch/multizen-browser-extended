// A local page for acceptance flows: no dependencies, so it also runs inside the image.
const http = require("node:http");

const port = Number(process.env.FIXTURE_PORT || 18999);
const host = process.env.FIXTURE_HOST || "127.0.0.1";
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/file") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="report.txt"',
      });
      res.end("downloaded-bytes");
    } else if (url.pathname === "/echo") {
      html(`<!doctype html><title>cookie: ${(req.headers.cookie ?? "none").replace(/[<>]/g, "")}</title><p>echo</p>`);
    } else {
      html(`<!doctype html><title>AC page</title>
        <button onclick="document.title='clicked'">Press me</button>
        <a href="/file">Download report</a>
        <p>tab ${url.searchParams.get("tab") ?? "one"}</p>`);
    }
  })
  .listen(port, host, () => console.log(`fixture on ${host}:${port}`));
