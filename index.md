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

A client subscribes once at its home Broker to learn about new sources of care data. When notified, the client uses the `feed-endpoint` if provided in the notification, or discovers it through the network's existing RLS, and subscribes there for ongoing encounter and appointment data. Whether the source feed endpoint is provider-operated or broker-hosted, the client does the same thing. Peer Brokers signal each other about watched patients across network boundaries, multiplexing many local interests behind one peer subscription so cross-network signaling scales without per-client fan-out.

### 1.1 Three planes

| Plane | Purpose | Surface |
|-------|---------|---------|
| **Control** | Signal that a new source is relevant | Home Broker → Client |
| **Data** | Ongoing encounter and appointment feed | Source feed endpoint → Client |
| **Peer** | Cross-network relationship signaling | Broker ↔ Broker |

### 1.2 End-to-end flow (client perspective)

![End-to-end flow — client perspective](images/end-to-end-flow.svg)

> This diagram shows the client-facing flow. The Home Broker may learn about new sources locally or via the peer plane (§5); the client experience is the same either way.

1. Client authorizes at its Home Broker. The token response includes a broker-scoped `patient` context.
2. Client creates a `new-care-relationship` subscription at the Home Broker, filtered to that patient.
3. The Home Broker ensures it has peer subscriptions with all relevant peer Brokers (§5.1), attaching an authority for this patient on each (§5.3). If peer subscriptions already exist, the Home Broker multiplexes onto them.
4. A patient visits a provider. The provider's network detects the new care relationship internally (ADT, FHIR event, polling — mechanism is network-internal).
5. If the provider is in the Home Network, the Home Broker learns about it directly. If the provider is in a peer network, the peer Broker signals the Home Broker via the `peer-network-events` subscription (§5.5).
6. Home Broker sends the client a `new-care-relationship` notification with a `client-action` of `subscribe` (includes `feed-endpoint`) or `rediscover` (client must run the network's discovery flow). The notification may also include `source-organization`.
7. The client follows `client-action`: if `subscribe`, proceed to authorization at the `feed-endpoint`; if `rediscover`, run the network's documented discovery flow, passing `discovery-hint` unchanged if present.
8. Client authorizes at the source feed endpoint. The token response includes a source-scoped `patient` context.
9. Client creates a `patient-data-feed` subscription at the source feed endpoint, filtered to that patient.
10. Client performs a catch-up query using its own lookback window to pick up the triggering encounter and any other recent activity.
11. All subsequent encounters and appointments at that source arrive via the subscription. The Home Broker is not in the data path.

---

## 2. Terms

**Home Broker.** The Broker where the client has its relationship subscription. It notifies the client when new sources become relevant. It may learn about sources locally or from peer Brokers. It is not necessarily where ongoing clinical data is read.

**Source.** A real care source the client may choose to follow. Identified minimally by stable identifiers. Richer detail (organization name, practitioner roles, etc.) comes from RLS, not from the notification.

**Source feed endpoint (`feed-endpoint`).** A FHIR base URL that supports the minimal data-plane contract defined in this spec (§4.5). May be provided directly in the relationship notification, or discovered via the network's out-of-band RLS. It may be hosted by the provider itself or by the provider's network Broker on the provider's behalf. The client does the same thing in both cases.

**Subject handle.** (Peer model.) A caller-assigned identifier for a patient on a peer link. The broker that calls `$attach-authority` creates the handle and supplies it with each attachment. The sending peer echoes it in notifications so the receiver can route events to the right local patient without per-authority lookup. Multiple authorities for the same patient use the same handle.

**Authority attachment.** (Peer model.) One local reason for keeping a subject active on a peer link. Each has a stable identifier.

---

## 3. Topics

| Topic | Plane | Delivered by | Delivered to | Focus | Content | Purpose |
|-------|-------|-------------|-------------|-------|---------|---------|
| `https://cms.gov/fhir/SubscriptionTopic/new-care-relationship` | Control | Home Broker | Client | `Parameters` | `full-resource` | Signal that a new source is relevant |
| `http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed` | Data | Source feed endpoint | Client | `Encounter` or `Appointment` | `id-only` | Ongoing encounter and appointment notifications |
| `https://cms.gov/fhir/SubscriptionTopic/peer-network-events` | Peer | Peer Broker | Peer Broker | `Parameters` | `full-resource` | Cross-network relationship signaling |

**Filter parameters:**

These are topic-defined filter parameters used in the Subscriptions R5 Backport `backport-filter-criteria` extension, not native FHIR search on the focus resource type.

| Topic | Filter | Value | Notes |
|-------|--------|-------|-------|
| `new-care-relationship` | `patient` | Broker-scoped patient id from token response | Required; expressed as `Parameters?patient={id}` |
| `patient-data-feed` | `patient` | Source-scoped patient id from token response | Required; applied per resource type (`Encounter?patient=`, `Appointment?patient=`) |
| `peer-network-events` | — | — | No filters; multiplexed across all watched subjects |

This spec defines a constrained use of the [US Core Patient Data Feed](https://www.hl7.org/fhir/us/core/patient-data-feed.html) topic. Endpoints SHALL support Encounter and MAY support Appointment; see §4.5.

---

## 4. Client-Facing Model

### 4.1 Authorization and patient identity

Patient identity is resolved during authorization at every endpoint. The token response includes the patient context the client uses at that endpoint.

- At the Home Broker, the token response includes a broker-scoped patient id (e.g., `"patient": "broker-123"`). The client uses this in its `new-care-relationship` subscription filter.
- At a source feed endpoint, the token response includes a source-scoped patient id (e.g., `"patient": "source-456"`). The client uses this in its `patient-data-feed` subscription filter.

In both cases the token returns a bare resource id, not a relative reference. This is standard SMART on FHIR behavior — the `patient` parameter in the token response is a bare id. No separate patient-resolution API is needed.

### 4.2 Home Broker subscription

The subscription follows the [Subscriptions R5 Backport IG](http://hl7.org/fhir/uv/subscriptions-backport/) format, filtered to the patient id from the token response (`broker-123`):

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Notify on new care relationships",
  "criteria": "https://cms.gov/fhir/SubscriptionTopic/new-care-relationship",
  "_criteria": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Parameters?patient=broker-123"
      }
    ]
  },
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://app.example.org/fhir/notifications",
    "payload": "application/fhir+json",
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
          "valueCode": "full-resource"
        }
      ]
    }
  }
}
```

### 4.3 Relationship notification

When a new source becomes relevant for the patient, the Home Broker sends a notification. The focus is a `Parameters` resource that always includes `client-action`, telling the client what to do next.

Every `new-care-relationship` notification SHALL include `client-action`. Defined values:

- **`subscribe`** — `feed-endpoint` is present; the client authorizes and subscribes there.
- **`rediscover`** — `feed-endpoint` is not present; the client runs the network's documented discovery flow.

**Example: `subscribe`** — the broker knows the feed endpoint:

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
          { "name": "client-action", "valueCode": "subscribe" },
          {
            "name": "feed-endpoint",
            "valueUrl": "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix"
          },
          {
            "name": "source-organization",
            "resource": {
              "resourceType": "Organization",
              "identifier": [
                {
                  "system": "http://hl7.org/fhir/sid/us-npi",
                  "value": "1234567890"
                }
              ],
              "name": "Mercy Hospital Phoenix"
            }
          }
        ]
      }
    }
  ]
}
```

**Example: `rediscover`** — the broker directs the client to run discovery:

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
          { "name": "client-action", "valueCode": "rediscover" },
          { "name": "discovery-hint", "valueString": "opaque-short-lived-token" },
          {
            "name": "source-organization",
            "resource": {
              "resourceType": "Organization",
              "identifier": [
                {
                  "system": "http://hl7.org/fhir/sid/us-npi",
                  "value": "1234567890"
                }
              ],
              "name": "Mercy Hospital Phoenix"
            }
          }
        ]
      }
    }
  ]
}
```

**Notification fields:**

| Field | Type | Optionality | Purpose |
|-------|------|-------------|---------|
| `client-action` | `valueCode` | SHALL | `subscribe` or `rediscover`. Tells the client what to do next. |
| `feed-endpoint` | `valueUrl` | SHALL if `subscribe` | FHIR base URL where the client subscribes for `patient-data-feed`. |
| `discovery-hint` | `valueString` | MAY (only with `rediscover`) | Opaque value the client passes unchanged into the network's discovery flow. |
| `source-organization` | `resource` (Organization) | MAY | Minimal Organization identifying the source of care. Useful when `feed-endpoint` is withheld, or when a broker-proxied URL obscures the true source. |

**Rules:**

- If `client-action` is `subscribe`, `feed-endpoint` SHALL be present and SHALL be a valid, subscribable source feed endpoint.
- If `client-action` is `rediscover`, `feed-endpoint` SHALL NOT be present.
- If `discovery-hint` is present, `client-action` SHALL be `rediscover`. The client SHALL pass `discovery-hint` unchanged into the network's documented discovery flow.
- If `source-organization` is included, its identifiers SHALL correlate correctly to the network's existing RLS output. The Organization resource may be minimal (e.g., just `identifier` and `name`).
- Unknown `client-action` values are not conformant.

### 4.4 Discovery

When `client-action` is `rediscover`, the client runs the network's documented discovery flow to obtain a `feed-endpoint`. Discovery is intentionally network-specific; a network's flow may wrap existing XCPD, RLS, or other directory APIs. This spec defines only the client-visible action.

The requirements are:

- The network SHALL document a discovery flow that yields a `feed-endpoint`.
- If `discovery-hint` is present, the client SHALL pass it unchanged into the discovery flow.
- If `source-organization` is included, the discovery flow SHALL recognize the same identifiers.
- Discovery implementations may use full refresh, app-specific policy evaluation, hint-scoped lookup, or other methods.

### 4.5 Source feed endpoint contract

Every source feed endpoint SHALL support:

- Token-authenticated FHIR requests
- `Subscription` create, read, and delete for the `patient-data-feed` topic
- `id-only` notifications with absolute resource URLs
- `read` on supported resource types
- Catch-up search: endpoints SHOULD support `patient` + `_lastUpdated` as search parameters on Encounter (and Appointment if supported), so clients can query for recent activity using their own lookback window

**Encounter** support is required. Every endpoint SHALL support Encounter subscription filters, `id-only` Encounter notifications, `read` on Encounter, and Encounter catch-up search.

**Appointment** support is optional. An endpoint MAY also support Appointment with the same capabilities (subscription filters, `id-only` notifications, `read`, catch-up search). Endpoints SHALL document whether Appointment is supported. Consistent with US Core guidance, endpoints may adjust or reject unsupported subscription filters.

This contract is intentionally narrow. It does not require broad FHIR API access beyond the feed and read-back needed here.

The authorization flow at this endpoint SHALL return a source-scoped patient context in the token response (§4.1). The client uses this for subscription filters and catch-up queries.

When a network Broker hosts a `feed-endpoint` on behalf of a provider, that endpoint SHALL be provider-specific and SHALL expose this same contract.

### 4.6 Source feed subscription

After resolving the source and authorizing at the source feed endpoint, the client creates a subscription filtered to the patient context from the token response. The subscription follows the [Subscriptions R5 Backport IG](http://hl7.org/fhir/uv/subscriptions-backport/) format. This example shows HealthApp subscribing at Valley Clinic (direct):

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Notify on encounter and appointment events",
  "criteria": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed",
  "_criteria": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Encounter?patient=source-456"
      },
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Appointment?patient=source-456"
      }
    ]
  },
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://app.example.org/fhir/source-notifications/valley-clinic",
    "payload": "application/fhir+json",
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
          "valueCode": "id-only"
        }
      ]
    }
  }
}
```

`source-456` is the bare patient id from the token response at this endpoint (§4.1). This example shows an endpoint that supports both Encounter and Appointment. If the endpoint does not support Appointment, the client omits that filter (or the endpoint adjusts it per US Core guidance).

### 4.7 Source feed notification

Continuing the Valley Clinic (direct) example. The notification uses the same `subscription-notification` bundle format as §4.3, with a `SubscriptionStatus` first entry. Because the subscription is `id-only`, there is no sibling focus entry — the focus reference points directly to the absolute Encounter URL:

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
        "topic": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed"
      }
    }
  ]
}
```

The client reads back the resource from the absolute URL in `focus.reference`, which is at the same endpoint it subscribed to. For a broker-hosted source like Mercy Hospital Phoenix, the URLs would be at the SW Care Broker's proxy (`broker.sw-care.example.org/fhir/sources/mercy-phoenix/...`) but the interaction is identical.

---

## 5. Peer Model

### 5.1 One multiplexed peer subscription

Each peer pair uses one long-lived `Subscription` for the `peer-network-events` topic. This single subscription carries notifications for all watched subjects between the two Brokers.

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Peer network event notifications",
  "criteria": "https://cms.gov/fhir/SubscriptionTopic/peer-network-events",
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://broker.az-health.example.org/fhir/peer-notifications",
    "payload": "application/fhir+json",
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
          "valueCode": "full-resource"
        }
      ]
    }
  }
}
```

The peer does not create one subscription per watched patient or per downstream client.

### 5.2 Peer API surface

| Operation | Purpose |
|-----------|---------|
| `POST /Subscription` | Create the multiplexed peer subscription |
| `GET /Subscription/{id}` | Read the peer subscription |
| `DELETE /Subscription/{id}` | Terminate the peer subscription |
| `POST /Subscription/{id}/$attach-authority` | Add one authority attachment |
| `POST /Subscription/{id}/$detach-authority` | Remove one authority attachment |

Notification delivery uses standard `subscription-notification` bundles to `Subscription.endpoint`.

These operations may be managed out-of-band, but the implementation SHALL preserve the same logical semantics: one multiplexed stream, per-authority attach/detach, and the notification shapes defined below.

### 5.3 Attaching an authority

An authority attachment tells a peer: "watch for this patient." The requesting broker supplies a `subject-handle` that it has already resolved locally — the sending peer echoes this handle in notifications without needing to coalesce across attachments.

The attach request carries the `subject-handle`, patient demographics for cross-network matching, a stable `authority-id`, and an optional `supporting-artifact` (e.g., a permission ticket). Multiple authorities with the same `subject-handle` are treated as the same patient — the sender does not need to match demographics across attachments to determine this. The response confirms the handle and returns an `authority-count`. Attaching a duplicate `authority-id` is a no-op.

### 5.4 Detaching an authority

Detach removes one authority by its `authority-id`. The response returns the updated `authority-count`. When the count reaches zero, the subject is no longer active and notifications stop. Detaching an unknown or already-removed `authority-id` returns success with the current count. No separate watch-inspection API is required — each peer maintains its own local authority registry keyed by `subject-handle` and `authority-id`.

See [authority-api.md](authority-api.md) for the full `$attach-authority` and `$detach-authority` request/response definitions, field tables, and rules.

### 5.5 Peer notification: new-care-relationship

When a source network detects a new care relationship for a watched subject, it sends a `new-care-relationship` event on the peer subscription.

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
          { "name": "kind", "valueCode": "new-care-relationship" },
          { "name": "subject-handle", "valueString": "patient-broker-a-123" },
          {
            "name": "source-organization",
            "resource": {
              "resourceType": "Organization",
              "identifier": [
                {
                  "system": "http://hl7.org/fhir/sid/us-npi",
                  "value": "1234567890"
                }
              ],
              "name": "Mercy Hospital Phoenix"
            }
          },
          {
            "name": "feed-endpoint",
            "valueUrl": "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix"
          }
        ]
      }
    }
  ]
}
```

**Peer notification fields:**

| Field | Type | Optionality | Purpose |
|-------|------|-------------|---------|
| `kind` | `valueCode` | SHALL | Event type: `new-care-relationship` (§5.5) or `visit-event` (§5.6). |
| `subject-handle` | `valueString` | SHALL | Caller-assigned patient handle from the attach request; the sending peer echoes it so the receiver can route notifications to the right local patient |
| `source-organization` | `resource` (Organization) | SHOULD | Minimal Organization identifying the source of care, same as in client notifications (§4.3) |
| `feed-endpoint` | `valueUrl` | SHOULD | FHIR base URL where the client can subscribe for `patient-data-feed` |

### 5.6 Peer notification: visit-event

A sending peer MAY send `visit-event` notifications to forward Encounter and/or Appointment resources, along with the source's FHIR Endpoint(s). A `visit-event` may accompany a `new-care-relationship` (for the triggering encounter) or be sent independently for subsequent visits at sources with an already-established relationship. A `visit-event` does not replace `new-care-relationship` — new sources still require a relationship event. See [visit-event.md](visit-event.md) for the full message definition.

### 5.7 Aggregation rules

- A peer pair uses one multiplexed subscription.
- Multiple authorities with the same `subject-handle` represent the same patient. The sender echoes the handle in notifications without needing to match demographics across attachments.
- A sending peer SHOULD emit at most one `new-care-relationship` event per newly relevant source per `subject-handle`.
- A sending peer MAY send `visit-event` notifications for any visit at a watched source — whether or not the source is new (§5.6).
- A sending peer SHALL stop all notifications for a `subject-handle` when its authority count reaches zero.
- A receiving peer SHALL maintain its own local authority registry. It SHALL NOT require the sender to repeat authority details in every notification.
- If 100 clients at the receiving broker all care about the same patient, they share one `subject-handle`, and the peer link carries one event, not 100.

### 5.8 Translation to client notifications

When translating a peer `new-care-relationship` event into a client `new-care-relationship` notification, the receiving broker:

- Sets `client-action` to `subscribe` if it can resolve a `feed-endpoint`, or `rediscover` otherwise.
- Forwards `source-organization` and `feed-endpoint` if present and useful.
- MAY add `discovery-hint` when `client-action` is `rediscover`.
- Strips `kind`, `subject-handle`, and any other peer-internal fields.

A `visit-event` that accompanies a `new-care-relationship` may enrich the client notification. A standalone `visit-event` for an already-established source does not generate a client notification — it is for broker-internal use only. See [visit-event.md](visit-event.md).

The client sees the same notification shape regardless of whether the Home Broker learned about the source locally or from a peer.

---

## 6. Scope

### In scope

- Client-facing `new-care-relationship` topic and notification shape
- Authorization-time patient identity resolution
- Source feed endpoint contract (`patient-data-feed`, read-back, catch-up)
- Multiplexed peer subscription and `peer-network-events` topic
- `$attach-authority` and `$detach-authority` operations
- Peer `new-care-relationship` notification shape (plus optional `visit-event`; see [visit-event.md](visit-event.md))

### Out of scope

- Discovery/RLS transport and internal details
- Patient-matching algorithms used by peers
- Full trust-framework and token choreography at each endpoint
- Broad FHIR API access beyond the minimal source feed contract
- How networks learn about events internally (ADT, polling, FHIR subscriptions from providers)
- Payment, contracting, and business terms between networks

---

## 7. Conformance Summary

**Home Broker:**

- SHALL support the `new-care-relationship` topic
- SHALL include `client-action` in every `new-care-relationship` notification
- If `client-action` is `subscribe`, SHALL include a valid `feed-endpoint`
- If `client-action` is `rediscover`, SHALL NOT include `feed-endpoint`; SHALL document a discovery flow that yields one
- MAY include `source-organization`; if included, its identifiers SHALL be accurate

**Source feed endpoint:**

- SHALL support token-authenticated requests
- SHALL support the `patient-data-feed` topic with `id-only` notifications
- SHALL support Encounter (subscription filters, notifications, read, catch-up search)
- MAY support Appointment with the same capabilities; SHALL document whether Appointment is supported
- SHALL return a source-scoped patient context in the token response
- When hosted by a Broker on behalf of a provider, SHALL be provider-specific and SHALL expose this same contract

**Peer Broker:**

- SHALL support one multiplexed peer subscription per peer pair
- SHALL support `$attach-authority` and `$detach-authority`
- SHALL aggregate authorities by `subject-handle`
- SHALL stop peer notifications when authority count reaches zero
- SHALL use the `peer-network-events` notification shapes defined here
- MAY support `visit-event` notifications; if supported, SHOULD include at least one of `encounter` or `appointment`
