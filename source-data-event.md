# Peer Notification: source-data-event

**Parent spec:** [index.md](index.md) §6.6

## Overview

A sending peer MAY send a `source-data-event` alongside a `new-care-relationship-exists` event to forward the triggering clinical resource, the source Organization, and optionally the source's FHIR Endpoint(s). This lets the receiving broker act on richer data without a separate lookup.

A `source-data-event` does not replace `new-care-relationship-exists`. The relationship event SHALL always be sent; the data event is an optional supplement. This avoids requiring the receiving broker to infer relationship state from data events.

## Parameters payload

The notification is delivered in the same `subscription-notification` bundle as the `new-care-relationship-exists` event (see §6.5 of the main spec), differing only in the `Parameters` payload:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "kind", "valueCode": "source-data-event" },
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
    {
      "name": "feed-endpoint",
      "valueUrl": "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix"
    },
    {
      "name": "focus-resource",
      "resource": {
        "resourceType": "Encounter",
        "id": "enc-789",
        "status": "in-progress",
        "class": {
          "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          "code": "AMB"
        },
        "subject": { "reference": "Patient/source-456" },
        "period": { "start": "2026-03-23T14:30:00Z" }
      }
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
        "name": "Mercy Hospital Phoenix",
        "address": [{ "state": "AZ", "city": "Phoenix" }]
      }
    },
    {
      "name": "source-endpoint",
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
```

## Fields

Shared peer fields (`kind`, `subject-handle`, `source-id`, `network-id`) follow the same rules as `new-care-relationship-exists`.

| Field | Optionality | Purpose |
|-------|-------------|---------|
| `feed-endpoint` | SHOULD | FHIR base URL for the source's feed endpoint |
| `focus-resource` | SHALL | The triggering Encounter or Appointment |
| `source-organization` | SHALL | The clinical Organization that is the source of care |
| `source-endpoint` | MAY | FHIR Endpoint resource(s) for the source organization; repeatable |

## Rules

- A `source-data-event` SHALL NOT be sent without a corresponding `new-care-relationship-exists` for the same source and `subject-handle`. The relationship event establishes the relationship; the data event supplements it.
- `focus-resource` SHALL be a valid Encounter or Appointment resource.
- `source-organization` SHALL be a valid Organization resource representing the care source.
- `source-endpoint`, if present, SHALL be a valid Endpoint resource associated with the source organization.
- The receiving broker MAY use the forwarded resources to enrich client notifications, pre-populate caches, or skip discovery steps.

## Translation to client notifications

When translating a `source-data-event` for client delivery:

- Strip `subject-handle` and peer-side authority details.
- Strip inline resources (`focus-resource`, `source-organization`, `source-endpoint`). The receiving broker MAY use these internally but SHALL NOT require the client to process them.
- Keep `source-id`, `network-id`, and `feed-endpoint` if present and useful.

The client sees the same `new-care-relationship` notification shape regardless of whether the broker received a `source-data-event` from the peer.
