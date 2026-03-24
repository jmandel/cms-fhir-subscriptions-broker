import { describe, test, expect } from "bun:test";
import { ClientApp, Broker, Provider, type HttpExchange, type HttpSender } from "./actors";

// ─── Test harness: in-memory HTTP routing ───────────────────────────────────

function createTestNetwork() {
  const log: HttpExchange[] = [];
  let counter = 0;

  const BASE = "http://test";

  const client = new ClientApp();

  // Create send function that routes through handlers
  const send: HttpSender = async (from, to, method, url, body, plane) => {
    const fullUrl = url.startsWith("http") ? url : `${BASE}${url}`;
    const path = new URL(fullUrl).pathname;

    // Try each handler (pass full URL so handlers can match by origin)
    for (const handler of [client.handle, homeBroker.handle, peerBroker.handle, valley.handle]) {
      const result = await handler(method, fullUrl, body);
      if (result) {
        log.push({
          id: `msg-${++counter}`, timestamp: new Date().toISOString(),
          from, to, method, url: fullUrl, requestBody: body,
          responseStatus: result.status, responseBody: result.body, plane,
        });
        return result.body;
      }
    }
    throw new Error(`No handler for ${method} ${fullUrl}`);
  };

  const homeBroker = new Broker("AZ Health Network", "home", `${BASE}/az-health/fhir`, send);
  const peerBroker = new Broker("SW Care Network", "peer", `${BASE}/sw-care/fhir`, send);
  const valley = new Provider("Valley Clinic", "valley-clinic", `${BASE}/valley-clinic/fhir`, true, send);
  const mercy = new Provider("Mercy Hospital Phoenix", "mercy-phoenix", `${BASE}/sw-care/fhir/sources/mercy-phoenix`, false, send);

  // Register feed endpoints on home broker (for peer→client translation)
  homeBroker.registerFeedEndpoint("urn:example:source:mercy-phoenix", `${BASE}/sw-care/fhir/sources/mercy-phoenix`);
  homeBroker.registerFeedEndpoint("urn:example:source:valley-clinic", `${BASE}/valley-clinic/fhir`);

  // Register hosted sources on peer broker
  peerBroker.hostedSources.set("mercy-phoenix", { providerName: "Mercy Hospital Phoenix" });

  return { client, homeBroker, peerBroker, valley, mercy, send, log, BASE };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Control Plane Setup", () => {
  test("client authorizes at home broker and gets patient context", async () => {
    const { homeBroker, send } = createTestNetwork();
    const resp = await send("HealthApp", "AZ Health Network", "POST", "http://test/az-health/fhir/token", {}, "setup");
    expect(resp.patient).toBe("broker-123");
    expect(resp.access_token).toBeTruthy();
  });

  test("client creates new-care-relationship subscription", async () => {
    const { homeBroker, send } = createTestNetwork();
    const resp = await send("HealthApp", "AZ Health Network", "POST", "http://test/az-health/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
      _criteria: { extension: [{ valueString: "Parameters?patient=broker-123" }] },
      channel: { type: "rest-hook", endpoint: "/app/notifications", _payload: { extension: [{ valueCode: "full-resource" }] } },
    }, "control");

    expect(resp.resourceType).toBe("Subscription");
    expect(resp.status).toBe("active");
    expect(homeBroker.clientSubs).toHaveLength(1);
    expect(homeBroker.clientSubs[0].callbackUrl).toBe("/app/notifications");
  });
});

describe("Peer Setup", () => {
  test("home broker creates peer subscription at peer broker", async () => {
    const { homeBroker, peerBroker, send } = createTestNetwork();
    const resp = await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");

    expect(resp.status).toBe("active");
    expect(peerBroker.peerSubs).toHaveLength(1);
  });

  test("attach authority for a patient", async () => {
    const { peerBroker, send } = createTestNetwork();
    // First create peer sub
    await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");

    const subId = peerBroker.peerSubs[0].id;
    const resp = await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters",
      parameter: [
        { name: "subject-handle", valueString: "broker-123" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Smith", given: ["Jane"] }] } },
        { name: "authority-id", valueString: "auth-jane" },
      ],
    }, "peer");

    expect(resp.parameter[1].valueInteger).toBe(1);
    expect(peerBroker.authorities).toHaveLength(1);
    expect(peerBroker.authorities[0].patientName).toBe("Jane Smith");
  });

  test("multiple patients multiplexed on one peer subscription", async () => {
    const { peerBroker, send } = createTestNetwork();
    await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");
    const subId = peerBroker.peerSubs[0].id;

    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "subject-handle", valueString: "broker-123" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Smith", given: ["Jane"] }] } },
        { name: "authority-id", valueString: "auth-jane" },
      ],
    }, "peer");
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "subject-handle", valueString: "broker-456" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Johnson", given: ["Bob"] }] } },
        { name: "authority-id", valueString: "auth-bob" },
      ],
    }, "peer");

    expect(peerBroker.authorities).toHaveLength(2);
    const state = peerBroker.getState();
    expect(state.watchedPatients).toHaveLength(2);
  });
});

describe("Notification Chain", () => {
  test("peer notification cascades to client via home broker", async () => {
    const { client, homeBroker, peerBroker, send } = createTestNetwork();

    // Setup: client sub at home broker
    await send("HealthApp", "AZ Health Network", "POST", "http://test/az-health/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
      channel: { type: "rest-hook", endpoint: "/app/notifications" },
    }, "control");

    // Setup: peer sub
    await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");

    // Peer broker sends notification (stored on home broker, not forwarded yet)
    await peerBroker.sendPeerNotification("urn:example:source:mercy-phoenix", "broker-123");
    expect(client.notifications).toHaveLength(0); // not yet forwarded
    expect(homeBroker.pendingPeerEvents).toHaveLength(1);

    // Home broker forwards to clients
    await homeBroker.forwardPeerEventsToClients();

    // Client should have received a new-care-relationship notification
    expect(client.notifications).toHaveLength(1);
    expect(client.notifications[0].kind).toBe("new-care-relationship");
    const params = client.notifications[0].payload;
    const feedEp = params?.parameter?.find((p: any) => p.name === "feed-endpoint")?.valueUrl;
    expect(feedEp).toContain("mercy-phoenix");
  });
});

describe("Data Plane", () => {
  test("client subscribes at brokered source feed endpoint", async () => {
    const { peerBroker, send } = createTestNetwork();

    // Authorize
    const tokenResp = await send("HealthApp", "SW Care Network", "POST", "http://test/sw-care/fhir/sources/mercy-phoenix/token", {}, "data");
    expect(tokenResp.patient).toBeTruthy();

    // Subscribe
    const subResp = await send("HealthApp", "SW Care Network", "POST", "http://test/sw-care/fhir/sources/mercy-phoenix/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/mercy" },
    }, "data");
    expect(subResp.status).toBe("active");
    expect(peerBroker.sourceFeedSubs.get("mercy-phoenix")).toHaveLength(1);
  });

  test("client subscribes at direct provider", async () => {
    const { valley, send } = createTestNetwork();

    const tokenResp = await send("HealthApp", "Valley Clinic", "POST", "http://test/valley-clinic/fhir/token", {}, "data");
    expect(tokenResp.patient).toBeTruthy();

    const subResp = await send("HealthApp", "Valley Clinic", "POST", "http://test/valley-clinic/fhir/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/valley" },
    }, "data");
    expect(subResp.status).toBe("active");
    expect(valley.subscriptions).toHaveLength(1);
  });

  test("brokered source feed notification reaches client", async () => {
    const { client, peerBroker, send } = createTestNetwork();

    // Subscribe
    await send("HealthApp", "SW Care Network", "POST", "http://test/sw-care/fhir/sources/mercy-phoenix/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/mercy" },
    }, "data");

    // Add encounter and notify
    peerBroker.addSourceEncounter("mercy-phoenix", "enc-1", "Dr. Chen");
    await peerBroker.sendSourceFeedNotification("mercy-phoenix", "enc-1");

    expect(client.notifications).toHaveLength(1);
    expect(client.notifications[0].kind).toBe("patient-data-feed");
    expect(client.notifications[0].from).toBe("mercy");
  });

  test("direct provider feed notification reaches client", async () => {
    const { client, valley, send } = createTestNetwork();

    await send("HealthApp", "Valley Clinic", "POST", "http://test/valley-clinic/fhir/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/valley" },
    }, "data");

    valley.addEncounter("enc-v1");
    await valley.sendFeedNotification("enc-v1");

    expect(client.notifications).toHaveLength(1);
    expect(client.notifications[0].kind).toBe("patient-data-feed");
    expect(client.notifications[0].from).toBe("valley");
  });
});

describe("Authority Lifecycle", () => {
  test("detaching authority decrements count, zero stops watching", async () => {
    const { peerBroker, send } = createTestNetwork();
    await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");
    const subId = peerBroker.peerSubs[0].id;

    // Attach two patients
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "subject-handle", valueString: "h-1" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Smith", given: ["Jane"] }] } },
        { name: "authority-id", valueString: "a-1" },
      ],
    }, "peer");
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "subject-handle", valueString: "h-2" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Johnson", given: ["Bob"] }] } },
        { name: "authority-id", valueString: "a-2" },
      ],
    }, "peer");
    expect(peerBroker.authorities).toHaveLength(2);

    // Detach Bob
    const resp = await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$detach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "authority-id", valueString: "a-2" },
      ],
    }, "peer");
    expect(resp.parameter[1].valueInteger).toBe(0); // Bob's handle count → 0
    expect(peerBroker.authorities).toHaveLength(1);
    expect(peerBroker.authorities[0].patientName).toBe("Jane Smith");

    // Detach Jane
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$detach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "authority-id", valueString: "a-1" },
      ],
    }, "peer");
    expect(peerBroker.authorities).toHaveLength(0);
    expect(peerBroker.getState().watchedPatients).toHaveLength(0);
  });
});

describe("End-to-End Scenario", () => {
  test("full flow: setup → mercy visit → data subscription → follow-up → valley → wind-down", async () => {
    const { client, homeBroker, peerBroker, valley, mercy, send, log } = createTestNetwork();

    // 1. Client auth + subscribe
    await send("HealthApp", "AZ Health Network", "POST", "http://test/az-health/fhir/token", {}, "setup");
    await send("HealthApp", "AZ Health Network", "POST", "http://test/az-health/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
      channel: { type: "rest-hook", endpoint: "/app/notifications" },
    }, "control");

    // 2. Peer setup
    await send("AZ Health Network", "SW Care Network", "POST", "http://test/sw-care/fhir/Subscription", {
      criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
      channel: { type: "rest-hook", endpoint: "/az-health/fhir/peer-notifications" },
    }, "peer");
    const subId = peerBroker.peerSubs[0].id;
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$attach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "subject-handle", valueString: "broker-123" },
        { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Smith", given: ["Jane"] }] } },
        { name: "authority-id", valueString: "auth-jane" },
      ],
    }, "peer");

    // 3. Mercy encounter → peer notify → forward → client notified
    await peerBroker.sendPeerNotification("urn:example:source:mercy-phoenix", "broker-123");
    await homeBroker.forwardPeerEventsToClients();
    expect(client.notifications).toHaveLength(1);

    // 4. Client subscribes at Mercy proxy
    await send("HealthApp", "SW Care Network", "POST", "http://test/sw-care/fhir/sources/mercy-phoenix/token", {}, "data");
    await send("HealthApp", "SW Care Network", "POST", "http://test/sw-care/fhir/sources/mercy-phoenix/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/mercy" },
    }, "data");

    // 5. Mercy follow-up (data plane only)
    peerBroker.addSourceEncounter("mercy-phoenix", "enc-mercy-1", "Dr. Chen");
    await peerBroker.sendSourceFeedNotification("mercy-phoenix", "enc-mercy-1");
    expect(client.notifications).toHaveLength(2);
    expect(client.notifications[1].kind).toBe("patient-data-feed");

    // 6. Valley visit → peer notify → forward → client
    await peerBroker.sendPeerNotification("urn:example:source:valley-clinic", "broker-123");
    await homeBroker.forwardPeerEventsToClients();
    expect(client.notifications).toHaveLength(3);

    // 7. Client subscribes at Valley directly
    await send("HealthApp", "Valley Clinic", "POST", "http://test/valley-clinic/fhir/token", {}, "data");
    await send("HealthApp", "Valley Clinic", "POST", "http://test/valley-clinic/fhir/Subscription", {
      criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
      channel: { type: "rest-hook", endpoint: "/app/source-notifications/valley" },
    }, "data");

    // 8. Valley follow-up
    valley.addEncounter("enc-valley-1");
    await valley.sendFeedNotification("enc-valley-1");
    expect(client.notifications).toHaveLength(4);

    // 9. Wind down
    await send("AZ Health Network", "SW Care Network", "POST", `http://test/sw-care/fhir/Subscription/${subId}/$detach-authority`, {
      resourceType: "Parameters", parameter: [
        { name: "authority-id", valueString: "auth-jane" },
      ],
    }, "peer");
    expect(peerBroker.authorities).toHaveLength(0);

    // Verify log captured everything
    expect(log.length).toBeGreaterThan(10);

    // Verify final states
    expect(client.getState().subscriptions).toHaveLength(0); // client doesn't track from actor side
    expect(client.getState().notifications).toHaveLength(4);
    expect(homeBroker.getState().clientSubscriptions).toHaveLength(1);
    expect(peerBroker.getState().watchedPatients).toHaveLength(0);
    expect(valley.getState().subscriptions).toHaveLength(1);
  });
});
