# Relationship Feed + Source Feed Endpoints

**Status:** Draft

## 1. Overview

![Architecture overview](images/architecture-overview.svg)

> **Example cast** — used throughout this document:
>
> | Name | Role | Feed endpoint |
> |------|------|---------------|
> | **HealthApp** | Client application | — |
> | **AZ Health Net Broker** | Home Broker | `broker.az-health.example.org/fhir` |
> | **SW Care Broker** | Peer Broker | `broker.sw-care.example.org/fhir` |
> | **Valley Clinic** | Provider in SW Care; hosts own FHIR feed | `valley-clinic.example.org/fhir` |
> | **Mercy Hospital Phoenix** | Provider in SW Care; no FHIR capability | `broker.sw-care.example.org/fhir/sources/mercy-phoenix` (hosted by SW Care Broker) |
>
> Valley Clinic hosts its own subscribable FHIR endpoint. Mercy Hospital Phoenix cannot, so the SW Care Broker hosts a `feed-endpoint` on its behalf. In both cases, the client does the same thing: authorize, subscribe, receive notifications.

A client subscribes once at its home Broker to learn about new sources of care data. When notified, the client discovers the source through the network's existing RLS, selects source-specific `patient-data-feed` endpoints, and subscribes there for ongoing encounter and appointment data. Whether the source feed endpoint is provider-operated or broker-hosted, the client does the same thing. Peer Brokers signal each other about watched patients across network boundaries, multiplexing many local interests behind one peer subscription so cross-network signaling scales without per-client fan-out.

### 1.1 Three planes

| Plane | Purpose | Surface |
|-------|---------|---------|
| **Control** | Signal that a new source is relevant | Home Broker → Client |
| **Data** | Ongoing encounter and appointment feed | Source feed endpoint → Client |
| **Peer** | Cross-network relationship signaling | Broker ↔ Broker |

### 1.2 End-to-end flow

![End-to-end flow](images/end-to-end-flow.svg)

1. Client authorizes at its Home Broker. The token response includes a broker-scoped `patient` context.
2. Client creates a `new-care-relationship` subscription at the Home Broker, filtered to that patient.
3. The Home Broker ensures it has peer subscriptions with all relevant peer Brokers (§6.1), attaching an authority for this patient on each (§6.3). If peer subscriptions already exist, the Home Broker multiplexes onto them.
4. A patient visits a provider. The provider's network detects the new care relationship internally (ADT, FHIR event, polling — mechanism is network-internal).
5. If the provider is in the Home Network, the Home Broker learns about it directly. If the provider is in a peer network, the peer Broker signals the Home Broker via the `peer-network-events` channel (§6.5).
6. Home Broker sends the client a `new-care-relationship` notification. The notification may include correlation hints (`source-id`, `network-id`) and a catch-up cursor (`initial-since`).
7. Client uses the network's existing RLS or documented source lookup to discover the source and learn its organization and `feed-endpoint`.
8. Client authorizes at the source feed endpoint. The token response includes a source-scoped `patient` context.
9. Client creates a `patient-data-feed` subscription at the source feed endpoint, filtered to that patient.
10. If `initial-since` was included, client does a catch-up query from that time to pick up the triggering encounter.
11. All subsequent encounters and appointments at that source arrive via the subscription. The Home Broker is not in the data path.

---

## 2. Terms

**Home Broker.** The Broker where the client has its relationship subscription. It notifies the client when new sources become relevant. It may learn about sources locally or from peer Brokers. It is not necessarily where ongoing clinical data is read.

**Source.** A real care source the client may choose to follow. Identified minimally by stable identifiers. Richer detail (organization name, practitioner roles, etc.) comes from RLS, not from the notification.

**Source feed endpoint.** A FHIR base URL that supports the minimal data-plane contract defined in this spec (§4.6). Identified in the source resolution result as `feed-endpoint`. It may be hosted by the provider itself or by the provider's network Broker on the provider's behalf. The client does the same thing in both cases.

**Subject handle.** (Peer model.) A receiver-assigned identifier for a patient on a peer link. The requesting broker supplies this handle when attaching authorities, and the sending peer echoes it in notifications. Multiple authorities for the same patient use the same handle. The requesting broker already knows its own patients — it assigns the handle, so the sending peer does not need to coalesce across attachments.

**Authority attachment.** (Peer model.) One local reason for keeping a subject active on a peer link. Each has a stable identifier.

**Source resolution result.** The result of discovery for one chosen source. It includes:

- the source organization
- `feed-endpoint` — the FHIR base URL where the client subscribes for `patient-data-feed`
- optionally, `source-fhir-base` — the provider's native FHIR API, if one exists (may support reads/search but not necessarily subscriptions)

When a provider hosts its own FHIR subscriptions, `feed-endpoint` and `source-fhir-base` may be the same URL. When a network Broker hosts the feed on the provider's behalf, `feed-endpoint` points to the Broker's per-provider endpoint and `source-fhir-base` may be absent or point to a separate provider API with different capabilities.

Networks MAY expose this result directly through a FHIR RLS mechanism. If they do not, their existing out-of-band RLS or discovery flow SHALL still make equivalent information derivable.

---

## 3. Topics

| Topic | Plane | Delivered by | Delivered to | Focus | Content | Purpose |
|-------|-------|-------------|-------------|-------|---------|---------|
| `new-care-relationship` | Control | Home Broker | Client | `Parameters` | `full-resource` | Signal that a new source is relevant |
| `patient-data-feed` | Data | Source feed endpoint | Client | `Encounter` or `Appointment` | `id-only` | Ongoing event notifications |
| `peer-network-events` | Peer | Peer Broker | Peer Broker | `Parameters` | `full-resource` | Cross-network relationship signaling |

---

## 4. Client-Facing Model

### 4.1 Authorization and patient identity

Patient identity is resolved during authorization at every endpoint. The token response includes the patient context the client uses at that endpoint.

- At the Home Broker, the token response includes a broker-scoped patient context (e.g., `"patient": "broker-123"`). The client uses this in its `new-care-relationship` subscription filter.
- At a source feed endpoint, the token response includes a source-scoped patient context (e.g., `"patient": "Patient/source-456"`). The client uses this in its `patient-data-feed` subscription filter.

This is the same pattern at every level. No separate patient-resolution API is needed. SMART on FHIR is one way to convey this — the `patient` parameter in the token response is standard SMART behavior.

### 4.2 Home Broker subscription

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "topic": "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
  "channelType": {
    "system": "http://terminology.hl7.org/CodeSystem/subscription-channel-type",
    "code": "rest-hook"
  },
  "endpoint": "https://app.example.org/fhir/notifications",
  "contentType": "application/fhir+json",
  "content": "full-resource"
}
```

### 4.3 Relationship notification

When a new source becomes relevant for the patient, the Home Broker sends a notification. The focus is a `Parameters` resource that may carry correlation and catch-up hints.

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-03-23T15:20:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 7,
        "notificationEvent": [
          {
            "eventNumber": 7,
            "timestamp": "2026-03-23T15:19:45Z",
            "focus": {
              "reference": "urn:uuid:params-1",
              "type": "Parameters"
            }
          }
        ],
        "subscription": {
          "reference": "https://broker.az-health.example.org/fhir/Subscription/sub-rel-1"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship"
      }
    },
    {
      "fullUrl": "urn:uuid:params-1",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          {
            "name": "source-id",
            "valueIdentifier": {
              "system": "https://cms.gov/fhir/sid/source-id",
              "value": "urn:source:mercy-phoenix"
            }
          },
          {
            "name": "network-id",
            "valueIdentifier": {
              "system": "https://cms.gov/fhir/sid/network-id",
              "value": "urn:network:sw-care"
            }
          },
          {
            "name": "initial-since",
            "valueInstant": "2026-03-23T15:19:45Z"
          }
        ]
      }
    }
  ]
}
```

**Hint fields:**

| Field | Purpose |
|-------|---------|
| `source-id` | Stable source key. Correlates to the network's RLS output so the client can match this event to a discovered source. |
| `network-id` | Stable network key. Used with `source-id` for correlation. |
| `initial-since` | Catch-up cursor. Tells the client where to begin its initial historical query at the source feed endpoint. |

**Rules:**

- A Home Broker MAY include `source-id`, `network-id`, and `initial-since`.
- If included, these fields SHALL correlate correctly to the network's existing RLS output or documented source lookup.
- A Home Broker MAY send a thinner event that simply means "discovery changed for this patient" without correlation hints. Even without hints, the client can act on it by re-running discovery.
- The notification is intentionally not a full RLS payload. It SHALL NOT require the network to inline complete `Organization` or `Endpoint` resources.

### 4.4 Source resolution result

This specification defines a canonical in-band FHIR shape for source resolution, even though a network MAY continue to provide discovery or RLS out of band.

If a network exposes a FHIR discovery or RLS mechanism, it SHOULD return a `Parameters` resource shaped like this. If it does not expose a FHIR mechanism, its existing out-of-band process SHALL still make equivalent information derivable.

The canonical source-resolution result for one source includes:

- `source-id`
- `network-id`
- `organization`
- `feed-endpoint`
- optionally, `source-fhir-base`

Example (Mercy Hospital Phoenix — broker-hosted feed):

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "source-resolution",
      "part": [
        {
          "name": "source-id",
          "valueIdentifier": {
            "system": "https://cms.gov/fhir/sid/source-id",
            "value": "urn:source:mercy-phoenix"
          }
        },
        {
          "name": "network-id",
          "valueIdentifier": {
            "system": "https://cms.gov/fhir/sid/network-id",
            "value": "urn:network:sw-care"
          }
        },
        {
          "name": "organization",
          "resource": {
            "resourceType": "Organization",
            "identifier": [
              {
                "system": "https://cms.gov/fhir/sid/source-id",
                "value": "urn:source:mercy-phoenix"
              }
            ],
            "name": "Mercy Hospital Phoenix"
          }
        },
        {
          "name": "feed-endpoint",
          "resource": {
            "resourceType": "Endpoint",
            "status": "active",
            "connectionType": {
              "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
              "code": "hl7-fhir-rest"
            },
            "address": "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix"
          }
        }
      ]
    }
  ]
}
```

Mercy has no native FHIR API, so `source-fhir-base` is absent. For Valley Clinic, `feed-endpoint` and `source-fhir-base` would both point to `https://valley-clinic.example.org/fhir`.

**Field semantics:**

| Field | Purpose |
|-------|---------|
| `source-id` | Stable source key for correlation with relationship notifications |
| `network-id` | Stable network key for correlation |
| `organization` | The underlying care source |
| `feed-endpoint` | The FHIR endpoint where the client subscribes for `patient-data-feed` |
| `source-fhir-base` | Optional. The provider's native FHIR API, which may support broader capabilities (reads, search) but is not required to support subscriptions |

### 4.5 Discovery and source lookup

After receiving a relationship notification, the client uses the network's existing RLS or documented source lookup to resolve the new source into the canonical source-resolution result above.

This spec does not standardize the discovery transport. The network's documented approach may be:

- the existing RLS directly
- the existing RLS plus a network-specific source directory
- another documented lookup available to authorized clients
- a future FHIR RLS mechanism that returns the canonical `Parameters` result

The requirements are:

- If the notification includes `source-id` and `network-id`, the network's documented process SHALL return those same values so the client can correlate the event to the resolved source.
- For each chosen source, that process SHALL yield the canonical source-resolution information:
  - source organization
  - `feed-endpoint`

### 4.6 Source feed endpoint contract

Every source feed endpoint SHALL support:

- Token-authenticated FHIR requests
- `Subscription` create, read, and delete for the `patient-data-feed` topic
- `id-only` notifications with absolute `Encounter` and `Appointment` URLs
- `read` on `Encounter` and `Appointment`
- Catch-up search over `Encounter` and `Appointment` for the patient from a given time

This contract is intentionally narrow. It does not require broad FHIR API access beyond the feed and read-back needed here.

The authorization flow at this endpoint SHALL return a source-scoped patient context in the token response (§4.1). The client uses this for subscription filters and catch-up queries.

When a network Broker hosts a `feed-endpoint` on behalf of a provider, that endpoint SHALL be provider-specific and SHALL expose this same contract.

### 4.7 Source feed subscription

After resolving the source and authorizing at the source feed endpoint, the client creates a subscription filtered to the patient context from the token response. This example shows HealthApp subscribing at Valley Clinic (direct):

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "topic": "https://cms.gov/fhir/SubscriptionTopic/patient-data-feed",
  "channelType": {
    "system": "http://terminology.hl7.org/CodeSystem/subscription-channel-type",
    "code": "rest-hook"
  },
  "endpoint": "https://app.example.org/fhir/source-notifications/valley-clinic",
  "contentType": "application/fhir+json",
  "content": "id-only",
  "filterBy": [
    {
      "resource": "Encounter",
      "filterParameter": "patient",
      "value": "Patient/source-456"
    },
    {
      "resource": "Appointment",
      "filterParameter": "patient",
      "value": "Patient/source-456"
    }
  ]
}
```

`Patient/source-456` is the source-scoped patient reference from the token response at this endpoint (§4.1).

### 4.8 Source feed notification

Continuing the Valley Clinic (direct) example:

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-03-23T16:02:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-2",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 12,
        "notificationEvent": [
          {
            "eventNumber": 12,
            "timestamp": "2026-03-23T16:01:52Z",
            "focus": {
              "reference": "https://valley-clinic.example.org/fhir/Encounter/enc-789",
              "type": "Encounter"
            }
          }
        ],
        "subscription": {
          "reference": "https://valley-clinic.example.org/fhir/Subscription/sub-feed-1"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/patient-data-feed"
      }
    }
  ]
}
```

The client reads back the resource from the URL in `focus.reference`, which is at the same endpoint it subscribed to. For a broker-hosted source like Mercy Hospital Phoenix, the URLs would be at the SW Care Broker's proxy (`broker.sw-care.example.org/fhir/sources/mercy-phoenix/...`) but the interaction is identical.

---

## 5. Core Design Rules

### 5.1 One actionable locator

The only locator the client needs for a source is `feed-endpoint`. There is no separate connection URL or connection resource.

### 5.2 One client experience

The client always authorizes, subscribes, receives notifications, and reads back resources at a source feed endpoint. Whether that endpoint is provider-operated or broker-hosted is invisible to the client.

### 5.3 Discovery remains authoritative

The relationship notification does not replace discovery. Discovery (RLS) remains the authoritative source for the full set of sources and the actual `feed-endpoint` URL.

The notification is a trigger: "something changed — re-run discovery." The optional hints make that re-run more efficient but are not a substitute.

### 5.4 Patient identity is resolved by authorization

Patient identity is resolved during the authorization step at every endpoint (§4.1). The token response includes the patient context the client uses for subscription filters and queries. No separate patient-resolution API is needed.

---

## 6. Peer Model

### 6.1 One multiplexed peer subscription

Each peer pair uses one long-lived `Subscription` for the `peer-network-events` topic. This single channel carries notifications for all watched subjects between the two Brokers.

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "topic": "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
  "channelType": {
    "system": "http://terminology.hl7.org/CodeSystem/subscription-channel-type",
    "code": "rest-hook"
  },
  "endpoint": "https://broker.az-health.example.org/fhir/peer-notifications",
  "contentType": "application/fhir+json",
  "content": "full-resource"
}
```

The peer does not create one subscription per watched patient or per downstream client.

### 6.2 Peer API surface

| Operation | Purpose |
|-----------|---------|
| `POST /Subscription` | Create the multiplexed peer subscription |
| `GET /Subscription/{id}` | Read the peer subscription |
| `DELETE /Subscription/{id}` | Terminate the peer subscription |
| `POST /Subscription/{id}/$attach-authority` | Add one authority attachment |
| `POST /Subscription/{id}/$detach-authority` | Remove one authority attachment |

Notification delivery uses standard `subscription-notification` bundles to `Subscription.endpoint`.

These operations may be managed out-of-band, but the implementation SHALL preserve the same logical semantics: one multiplexed stream, per-authority attach/detach, and the notification shapes defined below.

### 6.3 Attaching an authority

An authority attachment tells a peer: "watch for this patient." The requesting broker supplies a `subject-handle` that it has already resolved locally — the sending peer echoes this handle in notifications without needing to coalesce across attachments.

`POST [peer-base]/Subscription/{id}/$attach-authority`

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "subject-handle",
      "valueString": "patient-broker-a-123"
    },
    {
      "name": "subject",
      "resource": {
        "resourceType": "Patient",
        "identifier": [
          {
            "system": "https://payer.example.org/member-id",
            "value": "ABC123"
          }
        ],
        "name": [{ "family": "Smith", "given": ["Jane"] }],
        "birthDate": "1980-02-01",
        "gender": "female",
        "address": [{ "postalCode": "78701" }]
      }
    },
    {
      "name": "authority-identifier",
      "valueIdentifier": {
        "system": "https://broker.az-health.example.org/fhir/authority-attachment-id",
        "value": "auth-123"
      }
    },
    {
      "name": "supporting-artifact",
      "part": [
        { "name": "type", "valueString": "permission-ticket" },
        { "name": "value", "valueString": "opaque-ticket-or-token" }
      ]
    }
  ]
}
```

Response:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "subject-handle", "valueString": "patient-broker-a-123" },
    { "name": "authority-count", "valueInteger": 3 }
  ]
}
```

**Fields:**

| Field | Direction | Purpose |
|-------|-----------|---------|
| `subject-handle` | Request | Receiver-assigned patient handle. The sender echoes this in notifications. Multiple authorities for the same patient use the same handle. |
| `subject` | Request | Patient demographics for cross-network matching |
| `authority-identifier` | Request | Stable ID for this authority attachment |
| `supporting-artifact` | Request | Optional typed artifact (e.g., permission ticket) |
| `authority-count` | Response | How many authorities are behind this subject-handle |

**Rules:**

- Multiple authorities with the same `subject-handle` are treated as the same patient. The sender does not need to match demographics across attachments to determine this.
- The sender uses the supplied demographics to match incoming events, and echoes the `subject-handle` in notifications.
- `supporting-artifact` is optional and opaque unless a peer pair agrees on meaning out of band.

### 6.4 Detaching an authority

`POST [peer-base]/Subscription/{id}/$detach-authority`

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "authority-identifier",
      "valueIdentifier": {
        "system": "https://broker.az-health.example.org/fhir/authority-attachment-id",
        "value": "auth-123"
      }
    }
  ]
}
```

Response:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "subject-handle", "valueString": "patient-broker-a-123" },
    { "name": "authority-count", "valueInteger": 2 }
  ]
}
```

**Rules:**

- When `authority-count` reaches zero, the subject is no longer active. Notifications stop.
- No separate watch-inspection API is required. Each peer maintains its own local authority registry keyed by `subject-handle` and `authority-identifier`.

### 6.5 Peer notification: new-care-relationship-exists

When a source network detects a new care relationship for a watched subject, it sends a `new-care-relationship-exists` event on the peer channel.

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-03-23T17:05:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-3",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 21,
        "notificationEvent": [
          {
            "eventNumber": 21,
            "timestamp": "2026-03-23T17:04:50Z",
            "focus": {
              "reference": "urn:uuid:peer-event-1",
              "type": "Parameters"
            }
          }
        ],
        "subscription": {
          "reference": "https://broker.sw-care.example.org/fhir/Subscription/sub-peer-1"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/peer-network-events"
      }
    },
    {
      "fullUrl": "urn:uuid:peer-event-1",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "kind", "valueCode": "new-care-relationship-exists" },
          { "name": "subject-handle", "valueString": "patient-broker-a-123" },
          {
            "name": "source-id",
            "valueIdentifier": {
              "system": "https://cms.gov/fhir/sid/source-id",
              "value": "urn:source:mercy-phoenix"
            }
          },
          {
            "name": "network-id",
            "valueIdentifier": {
              "system": "https://cms.gov/fhir/sid/network-id",
              "value": "urn:network:sw-care"
            }
          },
          { "name": "initial-since", "valueInstant": "2026-03-23T17:04:50Z" }
        ]
      }
    }
  ]
}
```

**Peer-only fields:**

| Field | Purpose |
|-------|---------|
| `kind` | Event type. Currently only `new-care-relationship-exists`; reserved for future event types. |
| `subject-handle` | Receiver-assigned patient handle, echoed from the attach request |

### 6.6 Aggregation rules

- A peer pair uses one multiplexed subscription.
- Multiple authorities with the same `subject-handle` represent the same patient. The sender echoes the handle in notifications without needing to match demographics across attachments.
- A sending peer SHALL emit at most one `new-care-relationship-exists` event per newly relevant source per `subject-handle`, unless source details or `initial-since` materially change.
- A sending peer SHALL stop all notifications for a `subject-handle` when its authority count reaches zero.
- A receiving peer SHALL maintain its own local authority registry. It SHALL NOT require the sender to repeat authority details in every notification.
- If 100 clients at the receiving broker all care about the same patient, they share one `subject-handle`, and the peer link carries one event, not 100.

### 6.7 Translation to client notifications

When translating a peer `new-care-relationship-exists` event into a client `new-care-relationship` notification:

- Keep `source-id`, `network-id`, and `initial-since` if present and useful.
- Strip `subject-handle` and peer-side authority details.

The client sees the same notification shape regardless of whether the Home Broker learned about the source locally or from a peer.

---

## 7. Scope

### In scope

- Client-facing `new-care-relationship` topic and notification shape
- Authorization-time patient identity resolution
- Source feed endpoint contract (`patient-data-feed`, read-back, catch-up)
- Multiplexed peer subscription and `peer-network-events` topic
- `$attach-authority` and `$detach-authority` operations
- Peer `new-care-relationship-exists` notification shape

### Out of scope

- Discovery/RLS transport and internal details
- Patient-matching algorithms used by peers
- Full trust-framework and token choreography at each endpoint
- Broad FHIR API access beyond the minimal source feed contract
- How networks learn about events internally (ADT, polling, FHIR subscriptions from providers)
- Payment, contracting, and business terms between networks

### Important nuance

Discovery transport is out of scope, but the requirement that networks document a path from relationship notification to `feed-endpoint` is in scope. The mechanism is unspecified; its existence is required.

---

## 8. Conformance Summary

**Home Broker:**

- SHALL support the `new-care-relationship` topic
- SHALL send notifications that are actionable through the network's documented discovery flow
- MAY include `source-id`, `network-id`, and `initial-since`; if included, these SHALL correlate to the network's RLS output or documented source lookup
- SHALL ensure authorized clients can determine the canonical source-resolution result through a documented approach

**Source feed endpoint:**

- SHALL support token-authenticated requests
- SHALL support the `patient-data-feed` topic with `id-only` notifications
- SHALL support `read` on `Encounter` and `Appointment`
- SHALL support catch-up search from a given time
- SHALL return a source-scoped patient context in the token response
- When hosted by a Broker on behalf of a provider, SHALL be provider-specific and SHALL expose this same contract

**Peer Broker:**

- SHALL support one multiplexed peer subscription per peer pair
- SHALL support `$attach-authority` and `$detach-authority`
- SHALL aggregate authorities by `subject-handle`
- SHALL stop peer notifications when authority count reaches zero
- SHALL use the `peer-network-events` notification shapes defined here
