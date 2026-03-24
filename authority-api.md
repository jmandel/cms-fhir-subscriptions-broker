# Authority Attach/Detach API

**Parent spec:** [index.md](index.md) §5.3–5.4

## $attach-authority

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
      "name": "authority-id",
      "valueString": "auth-123"
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

### Request fields

| Field | Type | Purpose |
|-------|------|---------|
| `subject-handle` | `valueString` | Caller-assigned patient handle. The requesting broker creates this and reuses it for all authorities for the same local patient on the same peer link. |
| `subject` | `resource` (Patient) | Patient demographics for cross-network matching |
| `authority-id` | `valueString` | Stable ID for this authority attachment. Unique within the requesting broker's registry for this peer link. `$detach-authority` references the same value. |
| `supporting-artifact` | `part` | Optional typed artifact (e.g., permission ticket) |

### Response fields

| Field | Type | Purpose |
|-------|------|---------|
| `subject-handle` | `valueString` | Echoed from the request as confirmation |
| `authority-count` | `valueInteger` | How many authorities are behind this subject-handle |

### Rules

- Multiple authorities with the same `subject-handle` are treated as the same patient. The sender does not need to match demographics across attachments to determine this.
- The sender uses the supplied demographics to match incoming events, and echoes the `subject-handle` in notifications.
- `supporting-artifact` is optional and opaque unless a peer pair agrees on meaning out of band.

## $detach-authority

`POST [peer-base]/Subscription/{id}/$detach-authority`

```json
{
  "resourceType": "Parameters",
  "parameter": [
    {
      "name": "authority-id",
      "valueString": "auth-123"
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

### Rules

- When `authority-count` reaches zero, the subject is no longer active. Notifications stop.
- No separate watch-inspection API is required. Each peer maintains its own local authority registry keyed by `subject-handle` and `authority-id`.
