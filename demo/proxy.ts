// Reverse proxy (:3000) — routes by Host header, serves dashboard
const PORT = 3000;
const dashboardPath = import.meta.dir + "/dashboard.html";

const routes: Record<string, string> = {
  "ias-client.localhost": "http://localhost:3001",
  "broker.localhost": "http://localhost:3002",
  "mercy-ehr.localhost": "http://localhost:3003",
};

function getTarget(host: string | null): string | null {
  if (!host) return null;
  // Strip port
  const h = host.split(":")[0];
  return routes[h] || null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const host = req.headers.get("host");
    const target = getTarget(host);

    // CORS preflight
    if (req.method === "OPTIONS" && target) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": `http://localhost:${PORT}`,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Serve dashboard for bare localhost
    if (!target) {
      const file = Bun.file(dashboardPath);
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Proxy to backend
    const url = new URL(req.url);
    const proxyUrl = `${target}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    headers.delete("host");

    const proxyReq: RequestInit = {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    };

    try {
      const resp = await fetch(proxyUrl, proxyReq);

      // Build response headers with CORS
      const respHeaders = new Headers(resp.headers);
      respHeaders.set("Access-Control-Allow-Origin", `http://localhost:${PORT}`);
      respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      respHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

      return new Response(resp.body, {
        status: resp.status,
        headers: respHeaders,
      });
    } catch (e: any) {
      return Response.json(
        { error: `Proxy error: ${e.message}` },
        { status: 502 }
      );
    }
  },
});


console.log(`[Proxy] Dashboard & proxy on :${PORT}`);
console.log(`  http://localhost:${PORT}            → Dashboard`);
console.log(`  http://ias-client.localhost:${PORT}  → Client (:3001)`);
console.log(`  http://broker.localhost:${PORT}      → Broker (:3002)`);
console.log(`  http://mercy-ehr.localhost:${PORT}   → Data Source (:3003)`);
