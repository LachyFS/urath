import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

export async function serveDirectory(directory, base = "/") {
  const root = resolve(directory);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (!url.pathname.startsWith(base)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const relative =
        decodeURIComponent(url.pathname.slice(base.length)) || "index.html";
      const path = resolve(root, relative);
      if (!path.startsWith(root + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await readFile(path);
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".wasm": "application/wasm",
            ".css": "text/css",
            ".json": "application/json",
          }[extname(path)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${base}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
