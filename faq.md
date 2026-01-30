# FAQ: FHIR Subscriptions Broker Architecture

Companion to the [main specification](index.md) and [end-to-end example](e2e-ias-example.md).

---

### Why not require FHIR Subscriptions at every EHR?

Most provider endpoints don't support FHIR Subscriptions today, and many don't expose FHIR APIs at all. Even where FHIR APIs exist, they require provider-portal-specific registration — there's no trust framework that lets an application register at scale. The brokered model lets networks meet the CMS July 4, 2026 requirement using whatever internal integration mechanisms their providers already support (HL7v2 ADT, polling, proprietary feeds), while exposing a single standard FHIR API to clients.

### Don't notifications reveal PHI even with `id-only` payloads?

Yes. Even an `id-only` notification reveals that a patient was seen at a particular site of care — that is PHI. This is not unique to the brokered model; it is inherent in any notification system, and it is the same category of information that networks already handle when operating Record Locator Services (RLS). Networks that maintain an RLS already know where patients have received care and share that information with authorized parties. The Subscriptions Broker adds a real-time delivery mechanism on top of this existing trust model.

### What about patient matching? EHRs manage their own matching thresholds today.

This is a real concern. Today, when an EHR responds to a query, it applies its own matching algorithm and risk tolerance before releasing data. In the brokered model, the Broker performs matching to route notifications — and if the Broker matches incorrectly, a notification about the wrong patient could be sent.

How the Broker gains confidence in a match before firing a notification is a **network-internal decision**, explicitly out of scope for this protocol. Networks have options:

- **Centralized matching** — The network runs its own MPI and the Broker uses it directly
- **Provider-confirmed matching** — The network fans out match requests to individual providers before the Broker generates a notification
- **Hybrid approaches** — High-confidence matches notify immediately; lower-confidence matches require provider confirmation

This is analogous to existing network-level decisions about MPI thresholds and RLS participation. The protocol defines what the Client sees (a FHIR notification); it does not prescribe how the network arrives at the decision to send it.

For data retrieval, the Data Source always retains control — when a Client follows a `focus.reference` URL to fetch the actual resource, the Data Source applies its own authorization and matching before releasing data.

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

These scenarios require a standardized mechanism for conveying consent context alongside identity. The [Argonaut Project](https://confluence.hl7.org/spaces/AP/pages/86969961/Argonaut+Project+Home) is considering a 2026 initiative on **"SMART Permission Tickets"** that could encode identity, consent, and purpose of use into a verifiable token. The CMS Patient Preferences and Consent Workgroup is also exploring approaches.

### Can a Client receive notifications from providers in a different network?

Yes — through network peering. If the Client subscribes at Broker X, and Broker X peers with Broker Y, events from providers in Network Y can flow through to the Client. The Client doesn't need to know which network a provider belongs to; it receives all notifications through its single connection to Broker X.

How peering works between Brokers is a network-internal concern. The protocol specifies only the Client-facing FHIR API.

### What happens if the Client misses a notification?

Each notification includes an `eventNumber` that increments sequentially. If a Client detects a gap (e.g., receives event 5 after event 3), it knows it missed event 4. The Client can use the Subscription's `$status` operation or `$events` operation to catch up on missed notifications. Specific error recovery mechanisms follow the patterns defined in the [FHIR R4 Subscriptions Backport IG](http://hl7.org/fhir/uv/subscriptions-backport/).

### How does this relate to TEFCA?

This spec defines a new capability — brokered FHIR Subscriptions — that any CMS-Aligned Network would adopt, including TEFCA QHINs. A Broker could be operated by a QHIN, by another type of CMS-Aligned Network, or by a network that participates in both. The spec is not specific to any particular network type.
