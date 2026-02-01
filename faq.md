# FAQ: FHIR Subscriptions Broker Architecture

Companion to the [main specification](index.md) and [end-to-end example](e2e-ias-example.md).

---

### Why not require FHIR Subscriptions at every EHR?

Provider endpoints don't support FHIR Subscriptions today. Even where FHIR APIs exist, they often require provider-portal-specific registration and patient portal accounts. And registering with individual providers still doesn't give apps insight into when a patient is seen somewhere new. The brokered model lets networks meet the CMS July 4, 2026 requirement using whatever internal integration mechanisms their providers already support (HL7v2 ADT, polling, proprietary feeds), while exposing a single standard FHIR API to clients.

### Do notifications reveal PHI?

Even an `id-only` notification with no PHI in the message reveals to the receiving client that a patient was seen at a particular site of care. This is inherent in any encounter notification system, and it is the same category of information that networks already handle when operating Record Locator Services (RLS). Networks that maintain an RLS or broker RLS responses already know where patients have received care and pass that information to authorized parties. The Subscriptions Broker adds a real-time delivery mechanism on top of this existing trust model.

### How does the Client retrieve Encounter content?

The Client retrieves the resource identified by `focus.reference` in the notification bundle.

Baseline expectation is **Proxy Retrieval Mode**: `focus.reference` points to the Broker, and the Client retrieves the Encounter from the Broker using its existing Broker-issued access token. This avoids per-provider registrations and credentials during initial deployments.

Some networks may later enable **Direct Retrieval Mode**, where `focus.reference` points to a Data Source endpoint and the Client retrieves data from that source after discovering and completing the source's authorization flow.

### When would `focus.reference` point directly to Data Sources instead of the Broker?

Direct retrieval is only practical when Clients can be registered and authorized across the network without manual, provider-by-provider onboarding.

A Network may adopt direct links when it can support either:
- dynamic registration across participating providers (e.g., SMART/UDAP), or
- a single network-level registration step that is accepted across the network's providers.

Until then, Networks are expected to operate in Proxy Retrieval Mode.

### How are appointment notifications represented?

To keep the client-facing contract simple and compatible with existing profiles, appointment notifications are represented as planned Encounters conformant to the US Core Encounter profile (future-dated Encounter with `status="planned"`).

### How can a Client validate that a notification came from the Broker?

For `rest-hook` delivery, Brokers **SHALL** deliver notifications over HTTPS.

Clients **MAY** include custom headers in `Subscription.channel.header`. If present, the Broker **SHALL** include these headers in each notification request. A simple and effective pattern is a shared secret header (e.g., `X-Subscription-Token`) that the Client validates on receipt.

### What about patient matching? EHRs manage their own matching thresholds today.

This is a real concern. Today, when an EHR responds to a query, it applies its own matching algorithm and risk tolerance before releasing data. In the brokered model, the Broker performs matching to route notifications — and if the Broker matches incorrectly, a notification about the wrong patient could be sent.

How the Broker gains confidence in a match before firing a notification is a **network-internal decision**, explicitly out of scope for this protocol. Networks have options:

- **Centralized matching** — The network runs its own MPI and the Broker uses it directly
- **Provider-confirmed matching** — The network fans out match requests to individual providers before the Broker generates a notification
- **Hybrid approaches** — High-confidence matches notify immediately; lower-confidence matches require provider confirmation

This is analogous to existing network-level decisions about MPI thresholds and RLS participation. The protocol defines what the Client sees (a FHIR notification); it does not prescribe how the network arrives at the decision to send it.

One potential pattern is **match-before-notify**: when the Broker receives an event from a provider for the first time for a given patient, it queries the provider (using existing network-to-provider API calls, such as an RLS-style demographic query) to confirm that the provider considers it a match before firing a notification. Once confirmed, the Broker caches the mapping and subsequent events from that provider for that patient don't need re-confirmation. This gives providers matching authority without adding latency after the initial confirmation, and can be built entirely on existing network infrastructure. This is a network-internal implementation detail — not specified by this protocol.

### Why does the Broker assign a `Patient.id` instead of using an existing identifier?

Patients do not have a single stable identifier across organizations or networks. The brokered model does not require one. Instead:

1. The Client presents IAL2-verified identity attributes when requesting an access token
2. The Broker performs patient matching and returns a broker-scoped `Patient.id` in the token response (using the SMART on FHIR `patient` parameter)
3. The Client uses this ID in subscription filter criteria

This ID is meaningful only at the Broker. When events arrive from Data Sources, the Broker resolves them using its own internal identity matching. The Client never needs to know how patients are identified at individual providers.

### What trust and privacy model does the Broker operate under?

The Broker operates within the same trust framework that CMS-Aligned Networks already use for existing services like Record Locator Services:

- Patient demographic data and identifiers flow through network infrastructure for matching
- Providers share event data (e.g., ADT messages) with their network under existing participation agreements
- The network handles PHI about where a patient has received care

The Subscriptions Broker adds a delivery mechanism on top of this existing trust model — it does not expand the categories of PHI that the network handles or the legal basis under which it operates.

### Why is implicit consent acceptable for a pilot but not at scale?

For an initial pilot scoped to patients accessing their own data, implicit authorization is defensible — a patient who has completed IAL2 identity proofing and installed an IAS app can be assumed to consent to receiving their own notifications.

This does not extend to scenarios requiring explicit, granular consent:

- **Designated representatives** acting on behalf of a patient
- **Caregivers** with partial access rights
- **Minors and guardians** with age-dependent rules
- **Sensitive data** subject to 42 CFR Part 2 (substance use disorder) or state-level restrictions

These scenarios require a standardized mechanism for conveying consent context alongside identity. The community is exploring portable, cryptographically verifiable artifacts (e.g., "SMART Permission Tickets") that could encode identity, consent, and purpose of use. These are not required for this architecture but may inform future production profiles. The CMS Patient Preferences and Consent Workgroup is also exploring approaches.

### Can a Client receive notifications from providers in a different network?

Yes — through network peering. If the Client subscribes at Broker X, and Broker X peers with Broker Y, events from providers in Network Y can flow through to the Client. The Client doesn't need to know which network a provider belongs to; it receives all notifications through its single connection to Broker X.

How peering works between Brokers is a network-internal concern. The protocol specifies only the Client-facing FHIR API.

### What happens if the Client misses a notification?

Notification delivery is best effort. Clients should assume at-least-once delivery and be prepared for duplicates.

Each notification includes an `eventNumber` that increments sequentially. If a Client detects a gap (e.g., receives event 5 after event 3), it knows it missed event 4. The Client can use the Subscription `$status` operation or `$events` operation to catch up on missed notifications, following the patterns in the [FHIR R4 Subscriptions Backport IG](http://hl7.org/fhir/uv/subscriptions-backport/).

In addition to gap-based recovery, Clients **SHOULD** poll `$events` on startup/resume and periodically (on the order of weekly) to ensure nothing is missed due to extended downtime. Brokers **SHOULD** retain events for catch-up for at least 14 days.

### Does this require TEFCA?

No. This spec is designed for CMS-Aligned Networks broadly and does not require participation in any specific national network.

TEFCA QHINs are one example of a multi-party network trust framework where a Broker capability could be deployed, but adoption of this architecture is not contingent on TEFCA.
