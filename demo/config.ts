// Centralized configuration for the FHIR Subscriptions Broker demo.
// All service URLs are derived from these settings.
//
// Environment variables:
//   BASE_URL       — public base URL (default: http://localhost:3000)
//   ROUTING_MODE   — "subdomain" or "path" (default: subdomain)
//   PORT           — server listen port (default: 3000)

const mode = (process.env.ROUTING_MODE || "subdomain") as "subdomain" | "path";
const port = parseInt(process.env.PORT || "3000");
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

export const config = {
  port,
  mode,
  baseUrl,
  services: {
    client:     { subdomain: "ias-client", pathPrefix: "/client" },
    broker:     { subdomain: "broker",     pathPrefix: "/broker" },
    dataSource: { subdomain: "mercy-ehr",  pathPrefix: "/mercy-ehr" },
  },
} as const;

export type ServiceName = keyof typeof config.services;

/** URL for browser / external access to a service */
export function serviceUrl(service: ServiceName): string {
  const s = config.services[service];
  if (config.mode === "subdomain") {
    return `http://${s.subdomain}.localhost:${config.port}`;
  }
  return `${config.baseUrl}${s.pathPrefix}`;
}

/** URL for server-to-server calls (loopback — never leaves the host) */
export function internalUrl(service: ServiceName): string {
  const s = config.services[service];
  if (config.mode === "subdomain") {
    return `http://${s.subdomain}.localhost:${config.port}`;
  }
  return `http://localhost:${config.port}${s.pathPrefix}`;
}

/** Path prefix for a service (empty string in subdomain mode) */
export function servicePath(service: ServiceName): string {
  if (config.mode === "subdomain") return "";
  return config.services[service].pathPrefix;
}

/** Inject config variables into an HTML string (adds script before </head>) */
export function injectHtmlConfig(html: string, selfService?: ServiceName): string {
  const vars = [
    `var __BROKER__ = ${JSON.stringify(serviceUrl("broker"))};`,
    `var __CLIENT__ = ${JSON.stringify(serviceUrl("client"))};`,
    `var __EHR__ = ${JSON.stringify(serviceUrl("dataSource"))};`,
    `var __DASHBOARD__ = ${JSON.stringify(config.baseUrl)};`,
  ];
  if (selfService !== undefined) {
    vars.push(`var __BASE__ = ${JSON.stringify(servicePath(selfService))};`);
  }
  const script = `<script>${vars.join("\n")}</script>`;
  return html.replace("</head>", script + "\n</head>");
}
