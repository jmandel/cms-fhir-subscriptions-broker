// Single server on :3000 — routes by Host header to in-process handlers
import { handle as clientHandle, setBrokerHandle, setDataSourceHandle } from "./client/handler";
import { handle as brokerHandle, setClientNotify } from "./broker/handler";
import { handle as dataSourceHandle, setBrokerHandle as dsSetBrokerHandle } from "./data-source/handler";

const PORT = 3000;
const dashboardPath = import.meta.dir + "/dashboard.html";

// Wire up inter-service communication (all in-process, no network)
setClientNotify(clientHandle);
setBrokerHandle(brokerHandle);
setDataSourceHandle(dataSourceHandle);
dsSetBrokerHandle(brokerHandle);

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "ias-client.localhost": clientHandle,
  "broker.localhost": brokerHandle,
  "mercy-ehr.localhost": dataSourceHandle,
};

function getHandler(host: string | null): ((req: Request) => Promise<Response>) | null {
  if (!host) return null;
  const h = host.split(":")[0];
  return routes[h] || null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const host = req.headers.get("host");
    const handler = getHandler(host);

    // CORS preflight for subdomain requests
    const origin = req.headers.get("origin") || "";
    const allowedOrigin = /^http:\/\/([\w-]+\.)?localhost:3000$/.test(origin) ? origin : `http://localhost:${PORT}`;
    if (req.method === "OPTIONS" && handler) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Serve dashboard for bare localhost
    if (!handler) {
      return new Response(Bun.file(dashboardPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Route to handler
    const resp = await handler(req);

    // Add CORS headers for cross-origin requests
    const respHeaders = new Headers(resp.headers);
    respHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    respHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    return new Response(resp.body, { status: resp.status, headers: respHeaders });
  },
});

console.log(`[Server] All services on :${PORT}`);
console.log(`  http://localhost:${PORT}              → Dashboard`);
console.log(`  http://ias-client.localhost:${PORT}    → IAS Client`);
console.log(`  http://broker.localhost:${PORT}        → Broker`);
console.log(`  http://mercy-ehr.localhost:${PORT}     → Mercy EHR`);
