// Who is making a request. Behind Cloudflare Access every request carries a
// signed JWT (Cf-Access-Jwt-Assertion). Flock verifies its signature against
// the team's published keys and checks the audience, so another container on
// the Docker network cannot claim to be an admin by setting a header.
//
// With no Access settings (running on a laptop, loopback only) the identity is
// the configured local actor, exactly as before.

import { createPublicKey, createVerify } from "node:crypto";

export class AuthError extends Error {}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function createKeyCache({ teamDomain, fetchImpl = fetch, ttlMs = 60 * 60 * 1000 }) {
  let keys = null;
  let fetchedAt = 0;
  async function load(force = false) {
    if (!force && keys && Date.now() - fetchedAt < ttlMs) return keys;
    const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new AuthError(`could not load Access signing keys (HTTP ${res.status})`);
    const body = await res.json();
    keys = new Map((body.keys || []).map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })]));
    fetchedAt = Date.now();
    return keys;
  }
  return {
    async get(kid) {
      let k = (await load()).get(kid);
      if (!k) k = (await load(true)).get(kid); // keys rotate; refetch once
      return k || null;
    }
  };
}

export async function verifyAccessJwt(token, { keyCache, audience, teamDomain, now = Date.now() }) {
  if (!token || typeof token !== "string") throw new AuthError("not signed in through Cloudflare Access");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed Access token");
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (header.alg !== "RS256") throw new AuthError("unexpected Access token algorithm");

  const key = await keyCache.get(header.kid);
  if (!key) throw new AuthError("Access token signed by an unknown key");
  const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new AuthError("Access token signature is invalid");

  const auds = [].concat(claims.aud || []);
  if (!auds.includes(audience)) throw new AuthError("Access token is for a different application");
  if (claims.iss && claims.iss !== `https://${teamDomain}`) throw new AuthError("Access token issuer mismatch");
  if (typeof claims.exp === "number" && claims.exp * 1000 < now - 30_000) throw new AuthError("Access token expired");
  if (!claims.email) throw new AuthError("Access token has no email");
  return String(claims.email).toLowerCase();
}

// Returns { email, isAdmin, source }.
export function createIdentity({ access, admins = [], localActor = "admin", fetchImpl } = {}) {
  const adminSet = new Set(admins.map((a) => a.toLowerCase()));
  if (!access || !access.teamDomain || !access.audience) {
    return {
      mode: "local",
      async identify() {
        return { email: localActor, isAdmin: true, source: "local" };
      }
    };
  }
  const keyCache = createKeyCache({ teamDomain: access.teamDomain, fetchImpl });
  return {
    mode: "access",
    async identify(req) {
      const token = req.headers["cf-access-jwt-assertion"];
      const email = await verifyAccessJwt(token, { keyCache, audience: access.audience, teamDomain: access.teamDomain });
      return { email, isAdmin: adminSet.has(email), source: "cloudflare-access" };
    }
  };
}
