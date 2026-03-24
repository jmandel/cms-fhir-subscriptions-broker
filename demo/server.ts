// Minimal server: builds the TSX bundle on the fly and serves static files.
// All actor logic runs in the browser — the server just serves the app.

const PORT = 3456;

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file("public/index.html"), { headers: { "content-type": "text/html" } });
    }

    if (path === "/index.tsx") {
      const result = await Bun.build({ entrypoints: ["./index.tsx"], target: "browser", format: "esm" });
      if (!result.success) return new Response("Build error: " + result.logs.join("\n"), { status: 500 });
      return new Response(result.outputs[0], { headers: { "content-type": "application/javascript", "cache-control": "no-store" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo running at http://localhost:${PORT}`);
