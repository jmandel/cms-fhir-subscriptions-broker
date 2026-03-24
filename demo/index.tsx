import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { ClientApp, Broker, Provider, type HttpExchange } from "./actors";

// ─── Domain URLs (matching spec cast) ───────────────────────────────────────

const URLS = {
  azHealth: "https://broker.az-health.example.org/fhir",
  swCare: "https://broker.sw-care.example.org/fhir",
  valley: "https://valley-clinic.example.org/fhir",
  mercyProxy: "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix",
  appCallback: "https://app.example.org/fhir",
};

// ─── In-browser actor network ───────────────────────────────────────────────

let logCounter = 0;

function createNetwork(addEntry: (e: HttpExchange) => void) {
  logCounter = 0;

  const send = async (from: string, to: string, method: string, url: string, body: any, plane: HttpExchange["plane"]) => {
    for (const handler of [client.handle, homeBroker.handle, peerBroker.handle, valley.handle]) {
      const result = await handler(method, url, body);
      if (result) {
        addEntry({
          id: `msg-${++logCounter}`, timestamp: new Date().toISOString(),
          from, to, method, url, requestBody: body,
          responseStatus: result.status, responseBody: result.body, plane,
        });
        return result.body;
      }
    }
    // OOB / trigger entries logged directly by steps
    return { status: "no-handler" };
  };

  const client = new ClientApp();
  const homeBroker = new Broker("AZ Health Network", "home", URLS.azHealth, send);
  const peerBroker = new Broker("SW Care Network", "peer", URLS.swCare, send);
  const valley = new Provider("Valley Clinic", "valley-clinic", URLS.valley, true, send);
  const mercy = new Provider("Mercy Hospital Phoenix", "mercy-phoenix", URLS.mercyProxy, false, send);

  homeBroker.registerFeedEndpoint("urn:example:source:mercy-phoenix", URLS.mercyProxy);
  homeBroker.registerFeedEndpoint("urn:example:source:valley-clinic", URLS.valley);
  peerBroker.hostedSources.set("mercy-phoenix", { providerName: "Mercy Hospital Phoenix" });

  return { client, homeBroker, peerBroker, valley, mercy, send };
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Step {
  phase?: string; id: string; plane: string;
  title: string; desc: string; from: string; to: string;
  run: () => Promise<any>;
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface Store {
  currentStep: number;
  playing: boolean;
  entries: HttpExchange[];
  actorStates: any;
  stepEntryOffsets: number[];
  network: ReturnType<typeof createNetwork> | null;

  addEntry: (e: HttpExchange) => void;
  advanceStep: () => void;
  setPlaying: (v: boolean) => void;
  init: () => void;
  reset: () => void;
}

const useStore = create<Store>((set, get) => ({
  currentStep: 0, playing: false, entries: [], actorStates: null,
  stepEntryOffsets: [], network: null,

  addEntry: (e) => set((s) => ({ entries: [...s.entries, e] })),
  advanceStep: () => set((s) => ({ currentStep: s.currentStep + 1, stepEntryOffsets: [...s.stepEntryOffsets, s.entries.length] })),
  setPlaying: (v) => set({ playing: v }),

  init: () => {
    const net = createNetwork((e) => get().addEntry(e));
    set({ network: net, actorStates: getStates(net) });
  },

  reset: () => {
    logCounter = 0;
    const net = createNetwork((e) => get().addEntry(e));
    set({ currentStep: 0, entries: [], stepEntryOffsets: [], network: net, actorStates: getStates(net) });
  },
}));

function getStates(net: ReturnType<typeof createNetwork>) {
  return {
    healthApp: net.client.getState(),
    azHealth: net.homeBroker.getState(),
    swCare: net.peerBroker.getState(),
    mercyPhoenix: net.mercy.getState(),
    valleyClinic: net.valley.getState(),
  };
}

function refreshStates() {
  const net = useStore.getState().network;
  if (net) useStore.setState({ actorStates: getStates(net) });
}

// ─── Backport helpers ───────────────────────────────────────────────────────

const BF = (c: string) => ({ url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria", valueString: c });
const BP = (c: string) => ({ url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content", valueCode: c });

// ─── Steps (all run in-browser via actor methods) ───────────────────────────

function getSteps(): Step[] {
  const net = () => useStore.getState().network!;
  const addEntry = (e: Omit<HttpExchange, "id" | "timestamp">) => {
    useStore.getState().addEntry({ ...e, id: `msg-${++logCounter}`, timestamp: new Date().toISOString() } as HttpExchange);
  };

  return [
    { phase: "Control Plane Setup", id: "auth-home", plane: "setup",
      title: "Authorize at Home Broker",
      desc: "HealthApp authorizes at its Home Broker, receiving a broker-scoped patient context in the token response.",
      from: "HealthApp", to: "AZ Health Network",
      run: async () => {
        const resp = await net().send("HealthApp", "AZ Health Network", "POST", `${URLS.azHealth}/token`, "_demo=simplified-example&grant_type=client_credentials&client_id=healthapp-client-id&scope=launch/patient+patient/*.read", "setup");
        net().client.tokens.push({ endpoint: "AZ Health Network", patient: resp.patient, at: new Date().toISOString() });
        refreshStates();
      } },

    { id: "sub-home", plane: "control",
      title: "Subscribe for relationships",
      desc: "HealthApp subscribes for new-care-relationship notifications, filtered to its patient.",
      from: "HealthApp", to: "AZ Health Network",
      run: async () => {
        const resp = await net().send("HealthApp", "AZ Health Network", "POST", `${URLS.azHealth}/Subscription`, {
          criteria: "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
          _criteria: { extension: [BF("Parameters?patient=broker-123")] },
          channel: { type: "rest-hook", endpoint: `${URLS.appCallback}/notifications`, _payload: { extension: [BP("full-resource")] } },
        }, "control");
        net().client.subscriptions.push({ id: resp.id, topic: "new-care-relationship", at: new Date().toISOString(), endpoint: "AZ Health Network" });
        refreshStates();
      } },

    { id: "peer-sub", plane: "peer",
      title: "Establish peer subscription",
      desc: "Home Broker establishes a single multiplexed peer subscription with SW Care Network.",
      from: "AZ Health Network", to: "SW Care Network",
      run: async () => {
        await net().send("AZ Health Network", "SW Care Network", "POST", `${URLS.swCare}/Subscription`, {
          criteria: "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
          channel: { type: "rest-hook", endpoint: `${URLS.azHealth}/peer-notifications` },
        }, "peer");
        refreshStates();
      } },

    { id: "attach-jane", plane: "peer",
      title: "Watch Jane Smith",
      desc: "Attach an authority for Jane Smith — SW Care will now watch for care events involving her.",
      from: "AZ Health Network", to: "SW Care Network",
      run: async () => {
        const subId = net().peerBroker.peerSubs[0]?.id;
        await net().send("AZ Health Network", "SW Care Network", "POST", `${URLS.swCare}/Subscription/${subId}/$attach-authority`, {
          resourceType: "Parameters", parameter: [
            { name: "subject-handle", valueString: "broker-123" },
            { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Smith", given: ["Jane"] }], birthDate: "1980-02-01", gender: "female" } },
            { name: "authority-identifier", valueString: "auth-jane" },
          ],
        }, "peer");
        refreshStates();
      } },

    { id: "attach-bob", plane: "peer",
      title: "Watch Bob Johnson",
      desc: "Attach an authority for Bob Johnson — a second patient multiplexed on the same peer subscription.",
      from: "AZ Health Network", to: "SW Care Network",
      run: async () => {
        const subId = net().peerBroker.peerSubs[0]?.id;
        await net().send("AZ Health Network", "SW Care Network", "POST", `${URLS.swCare}/Subscription/${subId}/$attach-authority`, {
          resourceType: "Parameters", parameter: [
            { name: "subject-handle", valueString: "broker-456" },
            { name: "subject", resource: { resourceType: "Patient", name: [{ family: "Johnson", given: ["Bob"] }], birthDate: "1975-11-15", gender: "male" } },
            { name: "authority-identifier", valueString: "auth-bob" },
          ],
        }, "peer");
        refreshStates();
      } },

    // Mercy visit
    { phase: "Mercy Visit (brokered subscriptions)", id: "mercy-enc", plane: "trigger",
      title: "Encounter at Mercy Hospital",
      desc: "Jane visits Mercy Hospital Phoenix. Mercy detects the encounter and notifies SW Care Network out-of-band. Mercy doesn't host FHIR subscriptions — SW Care does that on its behalf.",
      from: "Mercy Hospital Phoenix", to: "SW Care Network",
      run: async () => {
        const encId = "enc-mercy-" + Date.now();
        net().mercy.addEncounter(encId);
        net().peerBroker.addSourceEncounter("mercy-phoenix", encId, "Mercy Hospital Phoenix");
        addEntry({ from: "Mercy Hospital Phoenix", to: "SW Care Network", method: "POST", url: "(out-of-band ADT notification)", requestBody: { event: "new-encounter", patient: "Jane Smith", encounterId: encId }, responseStatus: 200, responseBody: { status: "received" }, plane: "trigger" });
        refreshStates();
      } },

    { id: "mercy-peer", plane: "peer",
      title: "Peer notification → Home",
      desc: "SW Care Network sends a new-care-relationship peer notification to AZ Health Network.",
      from: "SW Care Network", to: "AZ Health Network",
      run: async () => {
        await net().peerBroker.sendPeerNotification("urn:example:source:mercy-phoenix", "urn:example:network:sw-care", "broker-123");
        refreshStates();
      } },

    { id: "mercy-client-notify", plane: "control",
      title: "Client notification",
      desc: "AZ Health Network translates the peer event into a new-care-relationship notification for HealthApp, including the feed-endpoint at SW Care's proxy for Mercy.",
      from: "AZ Health Network", to: "HealthApp",
      run: async () => {
        await net().homeBroker.forwardPeerEventsToClients();
        refreshStates();
      } },

    { id: "mercy-auth", plane: "data",
      title: "Authorize at Mercy proxy",
      desc: "HealthApp authorizes at the broker-hosted feed endpoint for Mercy, receiving a source-scoped patient context.",
      from: "HealthApp", to: "SW Care Network",
      run: async () => {
        const resp = await net().send("HealthApp", "SW Care Network", "POST", `${URLS.mercyProxy}/token`, "_demo=simplified-example&grant_type=client_credentials&client_id=healthapp-client-id&scope=launch/patient+patient/*.read", "data");
        net().client.tokens.push({ endpoint: "SW Care (Mercy proxy)", patient: resp.patient, at: new Date().toISOString() });
        refreshStates();
      } },

    { id: "mercy-sub", plane: "data",
      title: "Subscribe at Mercy proxy",
      desc: "HealthApp subscribes for patient-data-feed at the Mercy proxy. Same client experience as a direct endpoint.",
      from: "HealthApp", to: "SW Care Network",
      run: async () => {
        const resp = await net().send("HealthApp", "SW Care Network", "POST", `${URLS.mercyProxy}/Subscription`, {
          criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
          _criteria: { extension: [BF("Encounter?patient=mercy-pt"), BF("Appointment?patient=mercy-pt")] },
          channel: { type: "rest-hook", endpoint: `${URLS.appCallback}/source-notifications/mercy`, _payload: { extension: [BP("id-only")] } },
        }, "data");
        net().client.subscriptions.push({ id: resp.id, topic: "patient-data-feed (Mercy)", at: new Date().toISOString(), endpoint: "SW Care (Mercy proxy)" });
        refreshStates();
      } },

    // Mercy follow-up
    { phase: "Mercy Follow-up (data plane only)", id: "mercy-fu-enc", plane: "trigger",
      title: "Follow-up encounter at Mercy",
      desc: "Jane has a follow-up visit at Mercy. The encounter is detected out-of-band by SW Care Network.",
      from: "Mercy Hospital Phoenix", to: "SW Care Network",
      run: async () => {
        const encId = "enc-mercy-fu-" + Date.now();
        net().mercy.addEncounter(encId);
        net().peerBroker.addSourceEncounter("mercy-phoenix", encId, "Mercy Hospital Phoenix");
        addEntry({ from: "Mercy Hospital Phoenix", to: "SW Care Network", method: "POST", url: "(out-of-band encounter)", requestBody: { event: "follow-up", encounterId: encId }, responseStatus: 200, responseBody: { status: "received" }, plane: "trigger" });
        refreshStates();
      } },

    { id: "mercy-fu-notify", plane: "data",
      title: "Feed notification → HealthApp",
      desc: "SW Care's proxy sends a patient-data-feed notification directly to HealthApp. The Home Broker is not in the data path.",
      from: "SW Care Network", to: "HealthApp",
      run: async () => {
        const encs = Array.from(net().peerBroker.sourceEncounters.get("mercy-phoenix") || []);
        const last = encs[encs.length - 1];
        if (last) await net().peerBroker.sendSourceFeedNotification("mercy-phoenix", last.id);
        refreshStates();
      } },

    // Valley visit
    { phase: "Valley Visit (FHIR subscriptions)", id: "valley-enc", plane: "trigger",
      title: "Encounter at Valley Clinic",
      desc: "Jane visits Valley Clinic. Valley hosts its own FHIR subscriptions — unlike Mercy, no broker proxy needed.",
      from: "Valley Clinic", to: "SW Care Network",
      run: async () => {
        const encId = "enc-valley-" + Date.now();
        net().valley.addEncounter(encId);
        addEntry({ from: "Valley Clinic", to: "SW Care Network", method: "POST", url: "(out-of-band ADT notification)", requestBody: { event: "new-encounter", patient: "Jane Smith", encounterId: encId }, responseStatus: 200, responseBody: { status: "received" }, plane: "trigger" });
        refreshStates();
      } },

    { id: "valley-peer", plane: "peer",
      title: "Peer notification → Home",
      desc: "SW Care Network sends a peer notification to AZ Health Network — same as the Mercy case.",
      from: "SW Care Network", to: "AZ Health Network",
      run: async () => {
        await net().peerBroker.sendPeerNotification("urn:example:source:valley-clinic", "urn:example:network:sw-care", "broker-123");
        refreshStates();
      } },

    { id: "valley-client-notify", plane: "control",
      title: "Client notification",
      desc: "AZ Health Network notifies HealthApp. This time the feed-endpoint points directly to Valley Clinic — not a broker proxy.",
      from: "AZ Health Network", to: "HealthApp",
      run: async () => {
        await net().homeBroker.forwardPeerEventsToClients();
        refreshStates();
      } },

    { id: "valley-auth", plane: "data",
      title: "Authorize at Valley Clinic",
      desc: "HealthApp authorizes directly at Valley Clinic's own FHIR endpoint.",
      from: "HealthApp", to: "Valley Clinic",
      run: async () => {
        const resp = await net().send("HealthApp", "Valley Clinic", "POST", `${URLS.valley}/token`, "_demo=simplified-example&grant_type=client_credentials&client_id=healthapp-client-id&scope=launch/patient+patient/*.read", "data");
        net().client.tokens.push({ endpoint: "Valley Clinic", patient: resp.patient, at: new Date().toISOString() });
        refreshStates();
      } },

    { id: "valley-sub", plane: "data",
      title: "Subscribe at Valley Clinic",
      desc: "HealthApp subscribes for patient-data-feed at Valley Clinic. Same client code as the brokered Mercy endpoint.",
      from: "HealthApp", to: "Valley Clinic",
      run: async () => {
        const resp = await net().send("HealthApp", "Valley Clinic", "POST", `${URLS.valley}/Subscription`, {
          criteria: "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
          _criteria: { extension: [BF("Encounter?patient=valley-pt"), BF("Appointment?patient=valley-pt")] },
          channel: { type: "rest-hook", endpoint: `${URLS.appCallback}/source-notifications/valley`, _payload: { extension: [BP("id-only")] } },
        }, "data");
        net().client.subscriptions.push({ id: resp.id, topic: "patient-data-feed (Valley)", at: new Date().toISOString(), endpoint: "Valley Clinic" });
        refreshStates();
      } },

    // Valley follow-up
    { phase: "Valley Follow-up (data plane only)", id: "valley-fu-enc", plane: "trigger",
      title: "Follow-up at Valley Clinic",
      desc: "Jane has an appointment at Valley Clinic.",
      from: "Valley Clinic", to: "Valley Clinic",
      run: async () => {
        const encId = "enc-valley-fu-" + Date.now();
        net().valley.addEncounter(encId);
        addEntry({ from: "Valley Clinic", to: "Valley Clinic", method: "POST", url: "(internal encounter creation)", requestBody: { event: "follow-up", encounterId: encId }, responseStatus: 200, responseBody: { status: "recorded" }, plane: "trigger" });
        refreshStates();
      } },

    { id: "valley-fu-notify", plane: "data",
      title: "Feed notification → HealthApp",
      desc: "Valley Clinic sends a patient-data-feed notification directly to HealthApp. The Home Broker is not involved.",
      from: "Valley Clinic", to: "HealthApp",
      run: async () => {
        const last = net().valley.encounters[net().valley.encounters.length - 1];
        if (last) await net().valley.sendFeedNotification(last.id);
        refreshStates();
      } },

    // Wind down
    { phase: "Wind Down", id: "detach-bob", plane: "peer",
      title: "Detach Bob Johnson",
      desc: "Detach the authority for Bob Johnson. His authority count drops to zero — SW Care stops watching for Bob.",
      from: "AZ Health Network", to: "SW Care Network",
      run: async () => {
        const subId = net().peerBroker.peerSubs[0]?.id;
        await net().send("AZ Health Network", "SW Care Network", "POST", `${URLS.swCare}/Subscription/${subId}/$detach-authority`, {
          resourceType: "Parameters", parameter: [{ name: "authority-identifier", valueString: "auth-bob" }],
        }, "peer");
        refreshStates();
      } },

    { id: "detach-jane", plane: "peer",
      title: "Detach Jane Smith",
      desc: "Detach the authority for Jane Smith. No watched patients remain — the peer subscription is idle.",
      from: "AZ Health Network", to: "SW Care Network",
      run: async () => {
        const subId = net().peerBroker.peerSubs[0]?.id;
        await net().send("AZ Health Network", "SW Care Network", "POST", `${URLS.swCare}/Subscription/${subId}/$detach-authority`, {
          resourceType: "Parameters", parameter: [{ name: "authority-identifier", valueString: "auth-jane" }],
        }, "peer");
        refreshStates();
      } },
  ];
}

// ─── Step execution ─────────────────────────────────────────────────────────

const STEPS_REF = { current: null as Step[] | null };
function steps() { return STEPS_REF.current || (STEPS_REF.current = getSteps()); }

async function runStep(i: number) {
  if (i !== useStore.getState().currentStep) return;
  await steps()[i].run();
  useStore.getState().advanceStep();
}

async function runAll(speed: number) {
  if (useStore.getState().playing) return;
  useStore.setState({ playing: true });
  while (useStore.getState().currentStep < steps().length) {
    await runStep(useStore.getState().currentStep);
    if (speed > 0) await new Promise(r => setTimeout(r, speed));
  }
  useStore.setState({ playing: false });
}

function resetAll() {
  useStore.getState().reset();
  STEPS_REF.current = null; // recreate steps with new network
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const PLANE: Record<string, { color: string; bg: string; label: string }> = {
  setup:   { color: "#6366f1", bg: "#eef2ff", label: "Setup" },
  control: { color: "#16a34a", bg: "#f0fdf4", label: "Control" },
  peer:    { color: "#64748b", bg: "#f1f5f9", label: "Peer" },
  data:    { color: "#d97706", bg: "#fefce8", label: "Data" },
  trigger: { color: "#dc2626", bg: "#fef2f2", label: "Trigger" },
};

const mono: React.CSSProperties = { fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11 };

const ACTOR_ID_MAP: Record<string, string> = {
  "HealthApp": "healthApp", "AZ Health Network": "azHealth", "SW Care Network": "swCare",
  "Valley Clinic": "valleyClinic", "Mercy Hospital Phoenix": "mercyPhoenix",
};

// ─── Components ─────────────────────────────────────────────────────────────

function App() {
  useEffect(() => { useStore.getState().init(); }, []);
  const states = useStore(s => s.actorStates);
  if (!states) return null;

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 14, color: "#1e293b", background: "#f8fafc", height: "100vh", display: "flex", flexDirection: "column" }}>
      <TopBar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ width: "55%", maxWidth: 800, borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ActorDiagram />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          <CurrentStepBanner />
          <UnifiedTimeline />
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const [speed, setSpeed] = useState(800);
  const playing = useStore(s => s.playing);
  const done = useStore(s => s.currentStep >= steps().length);
  return (
    <div style={{ background: "#0f172a", color: "white", padding: "8px 20px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>CMS-Aligned Networks Protocol Demo</div>
      <div style={{ display: "flex", gap: 4, marginLeft: 16 }}>
        {Object.entries(PLANE).map(([k, v]) => (
          <span key={k} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: v.color + "22", color: v.color, fontWeight: 600 }}>{v.label}</span>
        ))}
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
        <select value={speed} onChange={e => setSpeed(+e.target.value)} style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #334155", background: "#1e293b", color: "#cbd5e1", fontSize: 12 }}>
          <option value={0}>Instant</option><option value={400}>Fast</option><option value={800}>Normal</option><option value={1500}>Slow</option>
        </select>
        <Btn onClick={() => runAll(speed)} disabled={playing || done}>{playing ? "Running…" : "▶ Play All"}</Btn>
        <Btn onClick={() => runStep(useStore.getState().currentStep)} disabled={playing || done}>Step ›</Btn>
        <Btn onClick={resetAll} bg="#dc2626">Reset</Btn>
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled, bg }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; bg?: string }) {
  return <button onClick={onClick} disabled={disabled} style={{ background: bg || "#3b82f6", color: "white", border: "none", padding: "5px 12px", borderRadius: 4, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, opacity: disabled ? 0.4 : 1 }}>{children}</button>;
}

// ─── Actor Diagram (SVG + foreignObject) ────────────────────────────────────

// Layout constants
// Layout: 2 columns, 3 rows. App on top spanning both cols, brokers middle, providers bottom.
const PAD = 20;
const CARD_W = 280, COL_GAP = 80, ROW_GAP = 40;
const CARD_H = 140, APP_H = 80;
const COL1_X = PAD, COL2_X = PAD + CARD_W + COL_GAP;
const W = COL2_X + CARD_W + PAD;
const ROW1_Y = PAD; // HealthApp (spans both cols)
const ROW2_Y = ROW1_Y + APP_H + ROW_GAP; // Brokers
const ROW3_Y = ROW2_Y + CARD_H + ROW_GAP; // Providers
const H = ROW3_Y + CARD_H + PAD;

function ActorDiagram() {
  const states = useStore(s => s.actorStates);
  const currentStep = useStore(s => s.currentStep);
  if (!states) return null;

  const active = currentStep > 0 ? (() => {
    const step = steps()[currentStep - 1];
    return { from: ACTOR_ID_MAP[step?.from] || null, to: ACTOR_ID_MAP[step?.to] || null };
  })() : { from: null, to: null };

  const role = (id: string) => active.from === id ? "from" as const : active.to === id ? "to" as const : null;

  return (
    <div style={{ background: "white", flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ fontSize: 11, fontWeight: 600, padding: "8px 16px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
        Network Architecture
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
          {/* ── Connection lines ── */}
          {/* Control: HealthApp (bottom center) → AZ Network (top center) */}
          <line x1={W / 2 - COL_GAP / 4} y1={ROW1_Y + APP_H} x2={COL1_X + CARD_W / 2} y2={ROW2_Y} stroke="#16a34a" strokeWidth="2" />
          <SvgLabel x={COL1_X + CARD_W / 2 - 30} y={ROW1_Y + APP_H + (ROW_GAP / 2) + 4} text="CONTROL" color="#16a34a" />

          {/* Peer: AZ Network → SW Care Network */}
          <line x1={COL1_X + CARD_W} y1={ROW2_Y + CARD_H / 2} x2={COL2_X} y2={ROW2_Y + CARD_H / 2} stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="6 3" />
          <SvgLabel x={(COL1_X + CARD_W + COL2_X) / 2} y={ROW2_Y + CARD_H / 2 - 8} text="PEER" color="#94a3b8" />

          {/* Hosts: SW Care → Mercy Phoenix */}
          <line x1={COL2_X + CARD_W / 2} y1={ROW2_Y + CARD_H} x2={COL2_X + CARD_W / 2} y2={ROW3_Y} stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 3" />
          <SvgLabel x={COL2_X + CARD_W / 2 + 24} y={ROW2_Y + CARD_H + ROW_GAP / 2 + 4} text="HOSTS" color="#94a3b8" />

          {/* Data: HealthApp → Valley (via right side) */}
          <line x1={W / 2 + COL_GAP / 4} y1={ROW1_Y + APP_H} x2={COL2_X + CARD_W / 2} y2={ROW2_Y} stroke="#d97706" strokeWidth="1" strokeDasharray="4 3" opacity="0.4" />

          {/* ── Cards ── */}
          {/* Row 1: HealthApp spanning both columns */}
          <SvgCard x={COL1_X} y={ROW1_Y} w={CARD_W * 2 + COL_GAP} h={APP_H} name="HealthApp" color="#3b82f6" badge="Client" role={role("healthApp")}>
            <div style={{ display: "flex", gap: 16 }}>
              <CSection label="Sessions">
                {states.healthApp.tokens.map((t: any, i: number) => (
                  <div key={i} style={{ fontSize: 9, color: "#64748b", whiteSpace: "nowrap" }}>{t.endpoint} → pt={t.patient}</div>
                ))}
              </CSection>
              <CSection label="Subscriptions">
                {states.healthApp.subscriptions.map((s: any, i: number) => (
                  <Pill key={i} color={s.topic.includes("care-rel") ? "#16a34a" : "#d97706"}>{s.topic}</Pill>
                ))}
              </CSection>
              <CSection label="Notifications">{states.healthApp.notifications.length > 0 ? <CBadge n={states.healthApp.notifications.length} label="received" color="#3b82f6" /> : null}</CSection>
            </div>
          </SvgCard>

          {/* Row 2: Brokers */}
          <SvgCard x={COL1_X} y={ROW2_Y} w={CARD_W} h={CARD_H} name="AZ Network" color="#16a34a" badge="Home Broker" role={role("azHealth")}>
            <CSection label="Client subs"><CBadge n={states.azHealth.clientSubscriptions.length} label="active" color="#16a34a" /></CSection>
            <CSection label="Watched patients"><WatchList patients={states.azHealth.watchedPatients} color="#16a34a" /></CSection>
          </SvgCard>

          <SvgCard x={COL2_X} y={ROW2_Y} w={CARD_W} h={CARD_H} name="SW Care Network" color="#16a34a" badge="Peer Broker" role={role("swCare")}>
            <CSection label="Peer link">{states.swCare.peerSubscriptions.length > 0 ? <Pill color="#64748b">← AZ Network</Pill> : null}</CSection>
            <CSection label="Watched patients"><WatchList patients={states.swCare.watchedPatients} color="#16a34a" /></CSection>
          </SvgCard>

          {/* Row 3: Providers */}
          <SvgCard x={COL1_X} y={ROW3_Y} w={CARD_W} h={CARD_H} name="Valley Clinic" color="#d97706" badge="FHIR Subscriptions" role={role("valleyClinic")}>
            <CSection label="Feed endpoint"><div style={{ fontSize: 9, color: "#d97706", background: "#fefce8", padding: "2px 4px", borderRadius: 3, wordBreak: "break-all" }}>{URLS.valley}</div></CSection>
            <CSection label="Client subs"><CBadge n={states.valleyClinic.subscriptions.length} label="active" color="#d97706" /></CSection>
            <CSection label="Encounters"><CBadge n={states.valleyClinic.encounters.length} label="total" color="#d97706" /></CSection>
          </SvgCard>

          <SvgCard x={COL2_X} y={ROW3_Y} w={CARD_W} h={CARD_H} name="Mercy Phoenix" color="#dc2626" badge="Brokered Subs" role={role("mercyPhoenix")}>
            <CSection label="Feed endpoint">
              <div style={{ fontSize: 9, color: "#64748b" }}>Hosted by SW Care</div>
              <div style={{ fontSize: 9, color: "#dc2626", background: "#fef2f2", padding: "2px 4px", borderRadius: 3, wordBreak: "break-all", marginTop: 2 }}>{URLS.mercyProxy}</div>
            </CSection>
            <CSection label="Encounters"><CBadge n={states.mercyPhoenix.encounters.length} label="total" color="#dc2626" /></CSection>
          </SvgCard>
        </svg>
      </div>
    </div>
  );
}

function SvgLabel({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  return (
    <text x={x} y={y} textAnchor="middle" fill={color} fontSize="9" fontWeight="700" fontFamily="Inter, system-ui, sans-serif" letterSpacing="0.08em">
      {text}
    </text>
  );
}

function SvgCard({ x, y, w, h, name, color, badge, role, children }: {
  x: number; y: number; w: number; h: number;
  name: string; color: string; badge?: string; role?: "from" | "to" | null;
  children: React.ReactNode;
}) {
  const isActive = role === "from" || role === "to";
  const roleLabel = role === "from" ? "REQ" : role === "to" ? "RSP" : null;
  // Extra padding around the foreignObject so border + boxShadow don't clip
  const M = 14;

  return (
    <foreignObject x={x - M} y={y - M} width={w + M * 2} height={h + M * 2}>
      <div style={{
        margin: M, width: w, height: h, fontFamily: "Inter, system-ui, sans-serif",
        border: `${isActive ? 2 : 1}px solid ${isActive ? color : color + "33"}`,
        borderRadius: 6, overflow: "hidden", background: "white",
        boxShadow: isActive ? `0 0 10px ${color}30` : "none",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ background: color + "0a", padding: "4px 6px", borderBottom: `1px solid ${color}18`, display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
          <span style={{ flex: 1, fontWeight: 700, fontSize: 11, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
          {roleLabel && <span style={{ fontSize: 7, padding: "1px 3px", borderRadius: 3, background: color, color: "white", fontWeight: 700, flexShrink: 0 }}>{roleLabel}</span>}
          {badge && <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 6, background: color + "15", color, fontWeight: 600, flexShrink: 0 }}>{badge}</span>}
        </div>
        <div style={{ padding: "4px 6px", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
          {children}
        </div>
      </div>
    </foreignObject>
  );
}

function CSection({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: "#94a3b8", fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 1 }}>{label}</div>
      {children || <div style={{ color: "#94a3b8", fontSize: 9, fontStyle: "italic" }}>—</div>}
    </div>
  );
}

function WatchList({ patients, color }: { patients: any[]; color: string }) {
  if (!patients?.length) return <div style={{ color: "#94a3b8", fontSize: 9, fontStyle: "italic" }}>No active watches</div>;
  return <>{patients.map((p: any) => (
    <div key={p.handle} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9 }}>
      <span style={{ fontWeight: 600, color: "#334155" }}>{p.name}</span>
      <span style={{ width: 14, height: 14, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700, background: color + "15", color }}>{p.count}</span>
    </div>
  ))}</>;
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ display: "inline-block", fontSize: 8, padding: "1px 4px", borderRadius: 6, background: color + "12", color, fontWeight: 600, marginRight: 2, marginBottom: 1 }}>{children}</span>;
}

function CBadge({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, background: n > 0 ? color + "15" : "#f1f5f9", color: n > 0 ? color : "#cbd5e1" }}>{n}</span>
      <span style={{ fontSize: 9, color: n > 0 ? "#475569" : "#cbd5e1" }}>{label}</span>
    </div>
  );
}

// ─── Current Step Banner ────────────────────────────────────────────────────

function CurrentStepBanner() {
  const currentStep = useStore(s => s.currentStep);
  const idx = currentStep > 0 ? currentStep - 1 : 0;
  const step = steps()[idx];
  if (!step || currentStep === 0) return <div style={{ height: 40, flexShrink: 0, background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }} />;
  const p = PLANE[step.plane] || PLANE.setup;
  return (
    <div style={{ padding: "8px 14px", height: 40, background: p.bg, borderBottom: `2px solid ${p.color}33`, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <div style={{ width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, background: p.color, color: "white", flexShrink: 0 }}>✓</div>
      <span style={{ fontSize: 8, fontWeight: 700, color: p.color, background: p.color + "18", padding: "2px 6px", borderRadius: 8, textTransform: "uppercase", flexShrink: 0 }}>{p.label}</span>
      <div style={{ fontSize: 11, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={step.desc}>{step.desc}</div>
    </div>
  );
}

// ─── Unified Timeline ───────────────────────────────────────────────────────

function openInTab(entry: HttpExchange) {
  const shortUrl = entry.url.replace(/^https?:\/\/[^/]+/, "") || entry.url;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${entry.method} ${shortUrl}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',system-ui,sans-serif;background:#f8fafc;color:#1e293b;height:100vh;display:flex;flex-direction:column}.header{padding:12px 20px;background:white;border-bottom:1px solid #e2e8f0;font-size:12px;display:flex;gap:12px;align-items:center;flex-shrink:0}.header .from{font-weight:700;color:#3b82f6}.header .to{font-weight:700;color:#16a34a}.header .method{background:#f1f5f9;padding:2px 8px;border-radius:3px;font-weight:700;font-family:monospace;font-size:11px}.header .status{font-weight:700;color:${entry.responseStatus < 300 ? "#16a34a" : "#ef4444"}}.header .url{color:#94a3b8;font-family:monospace;font-size:11px}.panels{display:flex;flex:1;overflow:hidden}.panel{flex:1;display:flex;flex-direction:column;overflow:hidden}.panel+.panel{border-left:1px solid #e2e8f0}.panel-title{padding:8px 16px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;background:white;border-bottom:1px solid #e2e8f0;flex-shrink:0}.panel pre{flex:1;overflow:auto;padding:16px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:monospace;background:white;margin:0}</style></head><body>
<div class="header"><span class="from">${entry.from}</span><span style="color:#94a3b8">\u2192</span><span class="to">${entry.to}</span><span class="method">${entry.method}</span><span class="url">${shortUrl}</span><span class="status">${entry.responseStatus}</span></div>
<div class="panels"><div class="panel"><div class="panel-title">Request</div><pre>${JSON.stringify(entry.requestBody, null, 2) || "(empty)"}</pre></div><div class="panel"><div class="panel-title">Response</div><pre>${JSON.stringify(entry.responseBody, null, 2) || "(pending)"}</pre></div></div></body></html>`;
  window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
}

function UnifiedTimeline() {
  const currentStep = useStore(s => s.currentStep);
  const playing = useStore(s => s.playing);
  const entries = useStore(s => s.entries);
  const offsets = useStore(s => s.stepEntryOffsets);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current && (ref.current.scrollTop = ref.current.scrollHeight); }, [currentStep, entries.length]);

  let lastPhase = "";
  const entriesForStep = (i: number): HttpExchange[] => {
    if (i >= currentStep) return [];
    const start = i === 0 ? 0 : (offsets[i - 1] || 0);
    return entries.slice(start, offsets[i] || entries.length);
  };

  return (
    <div ref={ref} style={{ flex: 1, overflowY: "auto", background: "white" }}>
      {steps().map((step, i) => {
        const showPhase = step.phase && step.phase !== lastPhase;
        if (step.phase) lastPhase = step.phase;
        const done = i < currentStep;
        const active = i === currentStep;
        const p = PLANE[step.plane] || PLANE.setup;
        if (i > currentStep) return null;

        return (
          <React.Fragment key={step.id}>
            {showPhase && <div style={{ fontSize: 9, fontWeight: 700, padding: "6px 12px", background: "#f8fafc", color: "#475569", textTransform: "uppercase", letterSpacing: "0.04em", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 1 }}>{step.phase}</div>}
            <div style={{ padding: "5px 12px", display: "flex", alignItems: "center", gap: 6, background: active ? p.bg : "transparent", borderLeft: `3px solid ${active ? p.color : done ? p.color + "40" : "transparent"}`, borderBottom: "1px solid #f1f5f9" }}>
              {done
                ? <div style={{ width: 18, textAlign: "center", color: p.color, fontWeight: 700, fontSize: 11, flexShrink: 0 }}>✓</div>
                : <div style={{ width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, flexShrink: 0, background: p.color + "18", color: p.color }}>{i + 1}</div>}
              <div style={{ flex: 1, fontSize: 11, fontWeight: active ? 600 : 400, color: done ? "#64748b" : "#1e293b" }}>{step.title}</div>
              <span style={{ fontSize: 8, fontWeight: 600, color: p.color, background: p.color + "12", padding: "1px 5px", borderRadius: 6, flexShrink: 0 }}>{p.label}</span>
              {active && <button onClick={() => runStep(i)} disabled={playing} style={{ background: p.color, color: "white", border: "none", borderRadius: 3, padding: "2px 7px", fontSize: 9, fontWeight: 600, cursor: playing ? "not-allowed" : "pointer", flexShrink: 0 }}>Run</button>}
            </div>
            {entriesForStep(i).map(entry => {
              const ep = PLANE[entry.plane] || PLANE.setup;
              const shortUrl = entry.url.replace(/^https?:\/\/[^/]+/, "") || entry.url;
              return (
                <div key={entry.id} onClick={() => openInTab(entry)} style={{ padding: "3px 12px 3px 36px", display: "flex", alignItems: "center", gap: 5, cursor: "pointer", borderBottom: "1px solid #fafafa", borderLeft: `3px solid ${p.color}15` }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                  <div style={{ width: 4, height: 4, borderRadius: "50%", background: ep.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 9, fontWeight: 600, color: "#475569", flexShrink: 0 }}>{entry.from}</span>
                  <span style={{ fontSize: 9, color: "#94a3b8" }}>→</span>
                  <span style={{ fontSize: 9, fontWeight: 600, color: "#475569", flexShrink: 0 }}>{entry.to}</span>
                  <span style={{ ...mono, fontSize: 8, fontWeight: 700, color: ep.color, flexShrink: 0 }}>{entry.method}</span>
                  <span style={{ ...mono, fontSize: 8, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{shortUrl}</span>
                  <span style={{ ...mono, fontSize: 8, fontWeight: 700, color: entry.responseStatus < 300 ? "#16a34a" : "#ef4444", flexShrink: 0 }}>{entry.responseStatus}</span>
                  <span style={{ fontSize: 8, color: "#cbd5e1" }}>↗</span>
                </div>
              );
            })}
          </React.Fragment>
        );
      })}
      {currentStep === 0 && <div style={{ padding: "40px 20px", textAlign: "center", color: "#cbd5e1", fontSize: 13 }}>Click Step or Play All to begin.</div>}
    </div>
  );
}

// ─── Mount ──────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(<App />);
