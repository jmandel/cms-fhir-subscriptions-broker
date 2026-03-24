# Peer Notification: visit-event

**Parent spec:** [index.md](index.md) §5.6

## Overview

A sending peer MAY send `visit-event` notifications to forward an Encounter or Appointment resource, the source Organization, and optionally the source's FHIR Endpoint(s). This lets the receiving broker act on richer data without a separate lookup.

A `visit-event` may accompany a `new-care-relationship` event (for the triggering encounter at a new source) or be sent independently for subsequent visits at sources with an already-established relationship. It does not replace `new-care-relationship` — new sources still require a relationship event.

## Parameters payload

The notification uses the same `subscription-notification` bundle format as §5.5, differing only in the `Parameters` payload:

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "kind", "valueCode": "visit-event" },
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
      "name": "network-id",
      "valueIdentifier": {
        "system": "https://cms.gov/fhir/sid/network-id",
        "value": "urn:example:network:sw-care"
      }
    },
    {
      "name": "feed-endpoint",
      "valueUrl": "https://broker.sw-care.example.org/fhir/sources/mercy-phoenix"
    },
    {
      "name": "encounter",
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

Shared peer fields (`kind`, `subject-handle`, `source-organization`, `network-id`) follow the same rules as `new-care-relationship`.

| Field | Optionality | Purpose |
|-------|-------------|---------|
| `encounter` | MAY | An Encounter resource from this visit |
| `appointment` | MAY | An Appointment resource from this visit |
| `feed-endpoint` | SHOULD | FHIR base URL for the source's feed endpoint |
| `source-endpoint` | MAY | FHIR Endpoint resource(s) for the source organization; repeatable |

At least one of `encounter` or `appointment` SHOULD be present. Both may be included in the same event.

## Rules

- For a new source, a `new-care-relationship` event SHALL be sent; a `visit-event` MAY accompany it but does not replace it.
- For an already-established source, a `visit-event` MAY be sent independently.
- `encounter`, if present, SHALL be a valid Encounter resource.
- `appointment`, if present, SHALL be a valid Appointment resource.
- `source-endpoint`, if present, SHALL be a valid Endpoint resource associated with the source organization.
- The receiving broker MAY use the forwarded resources to enrich client notifications, pre-populate caches, or skip discovery steps.

## Translation to client notifications

When translating a `visit-event` for client delivery, forward these fields if present:

- `source-organization`
- `network-id`
- `feed-endpoint`
- `source-fhir-base`

Peer-internal fields (`kind`, `subject-handle`) and inline resources (`encounter`, `appointment`, `source-endpoint`) are not forwarded to the client. The receiving broker MAY use the inline resources internally.

The client sees the same `new-care-relationship` notification shape regardless of whether the broker received a `visit-event` from the peer.
