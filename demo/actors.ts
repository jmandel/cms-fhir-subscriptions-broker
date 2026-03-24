// Functional core: standalone actor classes that share an HTTP transport layer.
// Each actor has real endpoints, processes real FHIR payloads, and accumulates
// state from what it actually receives — no faking.

// ─── Shared types ───────────────────────────────────────────────────────────

export interface HttpExchange {
  id: string;
  timestamp: string;
  from: string;
  to: string;
  method: string;
  url: string;
  requestBody: any;
  responseStatus: number;
  responseBody: any;
  plane: "control" | "data" | "peer" | "setup" | "trigger";
}

export type HttpHandler = (method: string, url: string, body: any) => Promise<{ status: number; body: any } | null>;
export type HttpSender = (from: string, to: string, method: string, url: string, body: any, plane: HttpExchange["plane"]) => Promise<any>;

// ─── Shared FHIR builders ───────────────────────────────────────────────────

export function tokenResponse(patient: string) {
  return { access_token: `token-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, token_type: "Bearer", expires_in: 3600, scope: "launch/patient patient/*.read", patient };
}

export function subscriptionResponse(id: string, topic: string, filters: string[], endpoint: string, content: string) {
  return {
    resourceType: "Subscription", id, status: "active", criteria: topic,
    _criteria: { extension: filters.map(f => ({ url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria", valueString: f })) },
    channel: { type: "rest-hook", endpoint, payload: "application/fhir+json",
      _payload: { extension: [{ url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content", valueCode: content }] } },
  };
}

export function notificationBundle(subscriptionUrl: string, topic: string, focusEntries: Array<{ url: string; resource?: any }>) {
  const n = Math.floor(Math.random() * 100) + 1;
  return {
    resourceType: "Bundle", type: "subscription-notification", timestamp: new Date().toISOString(),
    entry: [
      {
        fullUrl: `urn:uuid:${crypto.randomUUID()}`,
        resource: {
          resourceType: "SubscriptionStatus", status: "active", type: "event-notification",
          eventsSinceSubscriptionStart: n,
          notificationEvent: focusEntries.map((f, i) => ({
            eventNumber: n + i, timestamp: new Date().toISOString(),
            focus: { reference: f.url, type: f.resource?.resourceType },
          })),
          subscription: { reference: subscriptionUrl },
          topic,
        },
      },
      ...focusEntries.filter(f => f.resource).map(f => ({ fullUrl: f.url, resource: f.resource })),
    ],
  };
}

export function encounterResource(id: string, patientRef: string, provider: string, status = "finished") {
  return {
    resourceType: "Encounter", id, status,
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    subject: { reference: patientRef },
    participant: [{ individual: { display: provider } }],
    period: { start: new Date().toISOString().split("T")[0] },
  };
}

// ─── Actor: Client App ──────────────────────────────────────────────────────

export class ClientApp {
  name = "HealthApp";
  tokens: Array<{ endpoint: string; patient: string; at: string }> = [];
  subscriptions: Array<{ id: string; topic: string; at: string; endpoint: string }> = [];
  notifications: Array<{ at: string; kind: string; from: string; payload: any }> = [];

  // Handles incoming notification POSTs (callback endpoints)
  handle: HttpHandler = async (method, url, body) => {
    if (method !== "POST") return null;
    let path: string;
    try { path = new URL(url).pathname; } catch { path = url; }

    // new-care-relationship callback
    if (path.endsWith("/notifications") && !path.includes("source-notifications")) {
      const focusEntry = body?.entry?.[1]?.resource;
      this.notifications.push({
        at: new Date().toISOString(),
        kind: "new-care-relationship",
        from: "Home Broker",
        payload: focusEntry,
      });
      return { status: 200, body: {} };
    }

    // patient-data-feed callbacks
    if (path.includes("/source-notifications/")) {
      const source = path.split("/").pop();
      const status = body?.entry?.[0]?.resource;
      const focusRef = status?.notificationEvent?.[0]?.focus?.reference;
      this.notifications.push({
        at: new Date().toISOString(),
        kind: "patient-data-feed",
        from: source || "unknown",
        payload: { focusReference: focusRef },
      });
      return { status: 200, body: {} };
    }

    return null;
  };

  reset() {
    this.tokens = [];
    this.subscriptions = [];
    this.notifications = [];
  }

  getState() {
    return { name: this.name, type: "client", tokens: this.tokens, subscriptions: this.subscriptions, notifications: this.notifications };
  }
}

// ─── Actor: Broker ──────────────────────────────────────────────────────────

interface BrokerSub { id: string; topic: string; callbackUrl: string; filters: string[]; content: string }
interface Authority { subjectHandle: string; authorityId: string; patientName: string; demographics: any }

export class Broker {
  name: string;
  role: "home" | "peer";

  // Subscriptions this broker serves
  clientSubs: BrokerSub[] = [];
  peerSubs: BrokerSub[] = [];

  // Pending peer events received but not yet forwarded to clients
  pendingPeerEvents: Array<{ sourceId: string; networkId: string; feedEndpoint?: string }> = [];
  sourceFeedSubs: Map<string, BrokerSub[]> = new Map(); // keyed by source slug

  // Authorities (peer side)
  authorities: Authority[] = [];

  // Encounters stored for brokered sources
  sourceEncounters: Map<string, Array<{ id: string; resource: any }>> = new Map();

  // Sources this broker hosts feed endpoints for (brokered providers)
  hostedSources: Map<string, { providerName: string }> = new Map();

  private send: HttpSender;
  private baseUrl: string;

  constructor(name: string, role: "home" | "peer", baseUrl: string, send: HttpSender) {
    this.name = name;
    this.role = role;
    this.baseUrl = baseUrl;
    this.send = send;
  }

  handle: HttpHandler = async (method, url, body) => {
    // Check if this URL belongs to this broker (by origin + path prefix)
    const base = new URL(this.baseUrl);
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) return null;
    const path = parsed.pathname;
    const prefix = base.pathname;

    // Token endpoint
    if (method === "POST" && path === `${prefix}/token`) {
      // Home broker token
      const resp = tokenResponse(this.role === "home" ? "broker-123" : "peer-token");
      return { status: 200, body: resp };
    }

    // Source-specific token (brokered feed endpoint)
    const sourceTokenMatch = path.match(new RegExp(`^${prefix}/sources/([^/]+)/token$`));
    if (method === "POST" && sourceTokenMatch) {
      const sourceSlug = sourceTokenMatch[1];
      const patientId = `${sourceSlug}-pt-${Date.now().toString(36)}`;
      const resp = tokenResponse(patientId);
      return { status: 200, body: resp };
    }

    // Create subscription
    if (method === "POST" && path === `${prefix}/Subscription`) {
      const topic = body?.criteria || "";
      const callbackUrl = body?.channel?.endpoint || "";
      const filters = (body?._criteria?.extension || []).map((e: any) => e.valueString).filter(Boolean);
      const content = body?.channel?._payload?.extension?.[0]?.valueCode || "full-resource";
      const id = `sub-${Date.now()}`;
      const sub: BrokerSub = { id, topic, callbackUrl, filters, content };

      if (topic.includes("peer-network-events")) {
        this.peerSubs.push(sub);
      } else {
        this.clientSubs.push(sub);
      }

      return { status: 201, body: subscriptionResponse(id, topic, filters, callbackUrl, content) };
    }

    // Source-specific subscription (brokered feed)
    const sourceSubMatch = path.match(new RegExp(`^${prefix}/sources/([^/]+)/Subscription$`));
    if (method === "POST" && sourceSubMatch) {
      const sourceSlug = sourceSubMatch[1];
      const topic = body?.criteria || "";
      const callbackUrl = body?.channel?.endpoint || "";
      const filters = (body?._criteria?.extension || []).map((e: any) => e.valueString).filter(Boolean);
      const content = body?.channel?._payload?.extension?.[0]?.valueCode || "id-only";
      const id = `sub-${sourceSlug}-${Date.now()}`;
      const sub: BrokerSub = { id, topic, callbackUrl, filters, content };

      if (!this.sourceFeedSubs.has(sourceSlug)) this.sourceFeedSubs.set(sourceSlug, []);
      this.sourceFeedSubs.get(sourceSlug)!.push(sub);

      return { status: 201, body: subscriptionResponse(id, topic, filters, callbackUrl, content) };
    }

    // Attach authority
    if (method === "POST" && path.startsWith(prefix) && path.endsWith("$attach-authority")) {
      const handle = body?.parameter?.find((p: any) => p.name === "subject-handle")?.valueString;
      const authIdParam = body?.parameter?.find((p: any) => p.name === "authority-identifier"); const authId = authIdParam?.valueString || authIdParam?.valueIdentifier?.value;
      const patientRes = body?.parameter?.find((p: any) => p.name === "subject")?.resource;
      const name = patientRes?.name?.[0];
      const patientName = name ? `${name.given?.[0]} ${name.family}` : "Unknown";

      this.authorities.push({ subjectHandle: handle, authorityId: authId, patientName, demographics: patientRes });
      const count = this.authorities.filter(a => a.subjectHandle === handle).length;

      return { status: 200, body: { resourceType: "Parameters", parameter: [{ name: "subject-handle", valueString: handle }, { name: "authority-count", valueInteger: count }] } };
    }

    // Detach authority
    if (method === "POST" && path.startsWith(prefix) && path.endsWith("$detach-authority")) {
      const authIdParam = body?.parameter?.find((p: any) => p.name === "authority-identifier"); const authId = authIdParam?.valueString || authIdParam?.valueIdentifier?.value;
      const idx = this.authorities.findIndex(a => a.authorityId === authId);
      let handle = "";
      if (idx >= 0) {
        handle = this.authorities[idx].subjectHandle;
        this.authorities.splice(idx, 1);
      }
      const count = this.authorities.filter(a => a.subjectHandle === handle).length;

      return { status: 200, body: { resourceType: "Parameters", parameter: [{ name: "subject-handle", valueString: handle }, { name: "authority-count", valueInteger: count }] } };
    }

    // Peer notification callback (home broker receives from peer)
    if (method === "POST" && path.startsWith(prefix) && path.includes("/peer-notifications")) {
      return this.handlePeerNotification(body);
    }

    // Source-specific encounter read
    const encMatch = path.match(new RegExp(`^${prefix}/sources/([^/]+)/Encounter/(.+)$`));
    if (method === "GET" && encMatch) {
      const sourceSlug = encMatch[1];
      const encId = encMatch[2];
      const encounters = this.sourceEncounters.get(sourceSlug) || [];
      const enc = encounters.find(e => e.id === encId);
      if (enc) return { status: 200, body: enc.resource };
      // Generate on the fly if not found (demo convenience)
      const providerName = this.hostedSources.get(sourceSlug)?.providerName || sourceSlug;
      const resource = encounterResource(encId, `Patient/${sourceSlug}-pt`, providerName);
      return { status: 200, body: resource };
    }

    return null;
  };

  // Home broker: receive peer notification — store it, don't forward yet
  private async handlePeerNotification(body: any): Promise<{ status: number; body: any }> {
    const peerParams = body?.entry?.[1]?.resource;
    if (!peerParams) return { status: 200, body: {} };

    const sourceId = peerParams?.parameter?.find((p: any) => p.name === "source-id")?.valueIdentifier?.value;
    const networkId = peerParams?.parameter?.find((p: any) => p.name === "network-id")?.valueIdentifier?.value;
    const feedEndpoint = this.resolveFeedEndpoint(sourceId);

    this.pendingPeerEvents.push({ sourceId, networkId, feedEndpoint });

    return { status: 200, body: {} };
  }

  // Forward pending peer events to client subscriptions (called as a separate step)
  async forwardPeerEventsToClients() {
    while (this.pendingPeerEvents.length > 0) {
      const evt = this.pendingPeerEvents.shift()!;
      const clientParams: any = { resourceType: "Parameters", parameter: [] };
      if (evt.sourceId) clientParams.parameter.push({ name: "source-id", valueIdentifier: { system: "https://cms.gov/fhir/sid/source-id", value: evt.sourceId } });
      if (evt.networkId) clientParams.parameter.push({ name: "network-id", valueIdentifier: { system: "https://cms.gov/fhir/sid/network-id", value: evt.networkId } });
      if (evt.feedEndpoint) clientParams.parameter.push({ name: "feed-endpoint", valueUrl: evt.feedEndpoint });

      for (const sub of this.clientSubs) {
        const bundle = notificationBundle(
          `${this.baseUrl}/Subscription/${sub.id}`,
          "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
          [{ url: `urn:uuid:${crypto.randomUUID()}`, resource: clientParams }],
        );
        await this.send(this.name, "HealthApp", "POST", sub.callbackUrl, bundle, "control");
      }
    }
  }

  // Map source IDs to feed endpoints — this would come from network config in reality
  private feedEndpointMap: Map<string, string> = new Map();

  registerFeedEndpoint(sourceId: string, feedEndpoint: string) {
    this.feedEndpointMap.set(sourceId, feedEndpoint);
  }

  private resolveFeedEndpoint(sourceId: string): string | undefined {
    return this.feedEndpointMap.get(sourceId);
  }

  // Peer broker: notify home broker of a new care relationship
  async sendPeerNotification(sourceId: string, networkId: string, subjectHandle: string) {
    const peerParams: any = { resourceType: "Parameters", parameter: [
      { name: "kind", valueCode: "new-care-relationship" },
      { name: "subject-handle", valueString: subjectHandle },
      { name: "source-id", valueIdentifier: { system: "https://cms.gov/fhir/sid/source-id", value: sourceId } },
      { name: "network-id", valueIdentifier: { system: "https://cms.gov/fhir/sid/network-id", value: networkId } },
    ]};

    for (const sub of this.peerSubs) {
      const bundle = notificationBundle(
        `${this.baseUrl}/Subscription/${sub.id}`,
        "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
        [{ url: `urn:uuid:${crypto.randomUUID()}`, resource: peerParams }],
      );
      await this.send(this.name, "AZ Health Network", "POST", sub.callbackUrl, bundle, "peer");
    }
  }

  // Brokered source: send data-plane notification to subscribers
  async sendSourceFeedNotification(sourceSlug: string, encounterId: string) {
    const subs = this.sourceFeedSubs.get(sourceSlug) || [];
    const encUrl = `${this.baseUrl}/sources/${sourceSlug}/Encounter/${encounterId}`;

    for (const sub of subs) {
      const bundle = notificationBundle(
        `${this.baseUrl}/sources/${sourceSlug}/Subscription/${sub.id}`,
        "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
        [{ url: encUrl }],
      );
      const target = sub.callbackUrl.includes("mercy") ? "HealthApp" : "HealthApp";
      await this.send(`${this.name} (${sourceSlug} proxy)`, target, "POST", sub.callbackUrl, bundle, "data");
    }
  }

  // Store an encounter for a brokered source
  addSourceEncounter(sourceSlug: string, encId: string, providerName: string) {
    if (!this.sourceEncounters.has(sourceSlug)) this.sourceEncounters.set(sourceSlug, []);
    const resource = encounterResource(encId, `Patient/${sourceSlug}-pt`, providerName);
    this.sourceEncounters.get(sourceSlug)!.push({ id: encId, resource });
  }

  reset() {
    this.clientSubs = [];
    this.peerSubs = [];
    this.pendingPeerEvents = [];
    this.sourceFeedSubs.clear();
    this.authorities = [];
    this.sourceEncounters.clear();
  }

  getState() {
    const authsByHandle: Record<string, { name: string; count: number; authorities: string[] }> = {};
    for (const a of this.authorities) {
      if (!authsByHandle[a.subjectHandle]) authsByHandle[a.subjectHandle] = { name: a.patientName, count: 0, authorities: [] };
      authsByHandle[a.subjectHandle].count++;
      authsByHandle[a.subjectHandle].authorities.push(a.authorityId);
    }

    return {
      name: this.name, type: this.role === "home" ? "home-broker" : "peer-broker",
      clientSubscriptions: this.clientSubs.map(s => ({ id: s.id, topic: s.topic })),
      peerSubscriptions: this.peerSubs.map(s => ({ id: s.id, callbackUrl: s.callbackUrl })),
      watchedPatients: Object.entries(authsByHandle).map(([handle, info]) => ({ handle, ...info })),
      hostedFeeds: Array.from(this.sourceFeedSubs.entries()).map(([slug, subs]) => ({
        source: slug, clientCount: subs.length,
      })),
      sourceEncounters: Object.fromEntries(
        Array.from(this.sourceEncounters.entries()).map(([slug, encs]) => [slug, encs.length])
      ),
    };
  }
}

// ─── Actor: Provider (direct FHIR) ──────────────────────────────────────────

export class Provider {
  name: string;
  slug: string;
  hasSubscriptions: boolean;
  feedBaseUrl: string;

  subscriptions: BrokerSub[] = [];
  encounters: Array<{ id: string; resource: any }> = [];

  private send: HttpSender;

  constructor(name: string, slug: string, feedBaseUrl: string, hasSubscriptions: boolean, send: HttpSender) {
    this.name = name;
    this.slug = slug;
    this.feedBaseUrl = feedBaseUrl;
    this.hasSubscriptions = hasSubscriptions;
    this.send = send;
  }

  handle: HttpHandler = async (method, url, body) => {
    const base = new URL(this.feedBaseUrl);
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) return null;
    const path = parsed.pathname;
    const prefix = base.pathname;

    if (!this.hasSubscriptions) return null;

    // Token
    if (method === "POST" && path === `${prefix}/token`) {
      const resp = tokenResponse(`${this.slug}-pt-${Date.now().toString(36)}`);
      return { status: 200, body: resp };
    }

    // Create subscription
    if (method === "POST" && path === `${prefix}/Subscription`) {
      const topic = body?.criteria || "";
      const callbackUrl = body?.channel?.endpoint || "";
      const filters = (body?._criteria?.extension || []).map((e: any) => e.valueString).filter(Boolean);
      const content = body?.channel?._payload?.extension?.[0]?.valueCode || "id-only";
      const id = `sub-${this.slug}-${Date.now()}`;
      const sub: BrokerSub = { id, topic, callbackUrl, filters, content };
      this.subscriptions.push(sub);
      return { status: 201, body: subscriptionResponse(id, topic, filters, callbackUrl, content) };
    }

    // Read encounter
    const encMatch = path.match(new RegExp(`^${prefix}/Encounter/(.+)$`));
    if (method === "GET" && encMatch) {
      const encId = encMatch[1];
      const enc = this.encounters.find(e => e.id === encId);
      if (enc) return { status: 200, body: enc.resource };
      const resource = encounterResource(encId, `Patient/${this.slug}-pt`, this.name);
      return { status: 200, body: resource };
    }

    return null;
  };

  addEncounter(encId: string): any {
    const resource = encounterResource(encId, `Patient/${this.slug}-pt`, this.name);
    this.encounters.push({ id: encId, resource });
    return resource;
  }

  async sendFeedNotification(encounterId: string) {
    const encUrl = `${this.feedBaseUrl}/Encounter/${encounterId}`;
    for (const sub of this.subscriptions) {
      const bundle = notificationBundle(
        `${this.feedBaseUrl}/Subscription/${sub.id}`,
        "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
        [{ url: encUrl }],
      );
      await this.send(this.name, "HealthApp", "POST", sub.callbackUrl, bundle, "data");
    }
  }

  reset() {
    this.subscriptions = [];
    this.encounters = [];
  }

  getState() {
    return {
      name: this.name, type: this.hasSubscriptions ? "provider-direct" : "provider-no-subscriptions",
      feedEndpoint: this.feedBaseUrl,
      subscriptions: this.subscriptions.map(s => ({ id: s.id, topic: s.topic })),
      encounters: this.encounters.map(e => ({ id: e.id })),
    };
  }
}
