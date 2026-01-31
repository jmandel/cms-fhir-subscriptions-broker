// Mock JWT / token helpers — no external deps
// Permission Ticket support per SMART Permission Tickets spec

const MOCK_SECRET = "demo-secret-key";

export function createMockToken(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })
  );
  const sig = btoa("mock-signature");
  return `${header}.${payload}.${sig}`;
}

export function decodeMockToken(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

// --- Permission Tickets ---

export interface PatientDemographics {
  name: string;       // "Alice M Rodriguez"
  birthDate: string;  // "1987-04-12"
}

export interface PermissionTicketPayload {
  iss: string;
  sub: string;  // client ID
  aud: string;  // network/audience
  ticket_context: {
    subject: {
      type: "match";
      traits: {
        resourceType: "Patient";
        name: Array<{ family: string; given: string[] }>;
        birthDate: string;
      };
    };
    capability: {
      scopes: string[];
    };
  };
  iat: number;
  exp: number;
}

/** Create a signed permission ticket JWT (mock signature) */
export function createPermissionTicket(
  patient: PatientDemographics,
  clientId: string,
  scopes: string[] = ["patient/Encounter.rs"],
): string {
  const nameParts = patient.name.split(" ");
  const family = nameParts.pop()!;
  const given = nameParts;

  const header = { alg: "ES256", kid: "demo-idp-key-1" };
  const payload: PermissionTicketPayload = {
    iss: "https://identity-provider.example.org",
    sub: clientId,
    aud: "https://cms-network.example.org",
    ticket_context: {
      subject: {
        type: "match",
        traits: {
          resourceType: "Patient",
          name: [{ family, given }],
          birthDate: patient.birthDate,
        },
      },
      capability: {
        scopes,
      },
    },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const h = btoa(JSON.stringify(header));
  const p = btoa(JSON.stringify(payload));
  const sig = btoa("mock-es256-signature");
  return `${h}.${p}.${sig}`;
}

/** Create a client assertion JWT that embeds a permission ticket */
export function createClientAssertion(
  clientId: string,
  audience: string,
  permissionTicket: string,
): string {
  const header = { alg: "ES256", kid: "demo-client-key-1" };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: `assertion-${Date.now()}`,
    permission_ticket: permissionTicket,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  const h = btoa(JSON.stringify(header));
  const p = btoa(JSON.stringify(payload));
  const sig = btoa("mock-client-assertion-sig");
  return `${h}.${p}.${sig}`;
}

/** Extract permission ticket from a client assertion */
export function extractPermissionTicket(clientAssertion: string): PermissionTicketPayload | null {
  const assertionPayload = decodeMockToken(clientAssertion) as any;
  if (!assertionPayload?.permission_ticket) return null;
  return decodeMockToken(assertionPayload.permission_ticket) as PermissionTicketPayload | null;
}

/** Match patient demographics from a ticket against a registry entry */
export function matchDemographics(
  ticketTraits: PermissionTicketPayload["ticket_context"]["subject"]["traits"],
  registeredName: string,
  registeredBirthDate: string,
): boolean {
  // Match birthDate exactly
  if (ticketTraits.birthDate !== registeredBirthDate) return false;

  // Match name: compare family + given
  const ticketName = ticketTraits.name[0];
  if (!ticketName) return false;

  const regParts = registeredName.split(" ");
  const regFamily = regParts.pop()!;
  const regGiven = regParts;

  if (ticketName.family.toLowerCase() !== regFamily.toLowerCase()) return false;

  // Check at least first given name matches
  if (ticketName.given.length === 0 || regGiven.length === 0) return false;
  if (ticketName.given[0].toLowerCase() !== regGiven[0].toLowerCase()) return false;

  return true;
}
