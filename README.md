# CMS Aligned Networks: Split Control + Data Plane Subscriptions

**CMS Interoperability Framework — Subscriptions Workgroup** | *Draft for Discussion*

A client subscribes once at a Home Broker to learn about new sources of care data (control plane), then subscribes directly at each source feed endpoint for ongoing encounter and appointment notifications (data plane). Peer Brokers signal each other across network boundaries so cross-network discovery scales without per-client fan-out.

## Documents

- **[Specification](index.md)** — Main spec: topics, client model, peer model, conformance
- **[Authority API](authority-api.md)** — `$attach-authority` and `$detach-authority` wire formats
- **[Visit Event](visit-event.md)** — Optional `visit-event` peer notification for forwarding Encounter/Appointment resources
- **[Demo](demo/)** — Interactive single-page demo (`bun run demo/server.ts`)
