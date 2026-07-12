import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve("web/dist");
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health" || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/protected/") || url.pathname.startsWith("/api/")) {
    proxyHub(request, response);
    return;
  }
  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = resolve(root, relativePath);

  if (!file.startsWith(`${root}${sep}`) && file !== root) {
    response.writeHead(404).end();
    return;
  }

  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(file)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

function proxyHub(request, response) {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: 8787,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
}

server.listen(4173, "127.0.0.1", () => {
  console.log("PWA shell listening on http://127.0.0.1:4173");
});
