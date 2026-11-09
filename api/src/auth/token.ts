import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Attendee tokens (design doc section 6).
 *
 * Algorithm: HS256 JWT (HMAC-SHA256), signed and verified with `jose`.
 * Key: TOKEN_SIGNING_KEY, mounted from a Kubernetes Secret. Never committed.
 * Claims: `sub` (attendee ID), `iat`, `exp`, `iss`, `aud`. Nothing else: no
 * name, interests, consent or entitlements. Entitlements are looked up
 * server-side on every use, which is what makes revocation work.
 *
 * Reuse (e.g. QR access, task #11): create one TokenService and call
 * `sign(id, { audience: "access", ttlSeconds: 60 })` /
 * `verify(token, { audience: "access" })` so session and QR tokens cannot be
 * swapped for one another.
 */
export const TOKEN_ALG = "HS256";
export const TOKEN_ISSUER = "conference-companion";
export const DEFAULT_AUDIENCE = "attendee";
/** Session token lifetime. Attendee data itself expires after 24h. */
export const DEFAULT_TOKEN_TTL_SECONDS = 8 * 60 * 60;
/** HS256 wants at least a 256-bit key. */
export const MIN_PRODUCTION_KEY_LENGTH = 32;

/** Placeholder values that must never sign tokens in production. */
const INSECURE_KEYS = new Set(["change-me", "dev-only-insecure-key", "changeme", "secret"]);

export class TokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenConfigError";
  }
}

export class TokenError extends Error {
  constructor(readonly reason: "malformed" | "expired" | "invalid") {
    super(`token ${reason}`);
    this.name = "TokenError";
  }
}

/**
 * Throws unless the key is usable. Always rejects an empty key; with
 * NODE_ENV=production also rejects known placeholders and short keys.
 * The key itself is never included in the error message.
 */
export function assertSigningKey(key: string | undefined, nodeEnv: string | undefined): asserts key is string {
  if (!key || key.trim() === "") {
    throw new TokenConfigError("TOKEN_SIGNING_KEY is not set");
  }
  if (nodeEnv === "production") {
    if (INSECURE_KEYS.has(key.trim().toLowerCase())) {
      throw new TokenConfigError("TOKEN_SIGNING_KEY is a placeholder value; set a real key from the Kubernetes Secret");
    }
    if (key.length < MIN_PRODUCTION_KEY_LENGTH) {
      throw new TokenConfigError(`TOKEN_SIGNING_KEY must be at least ${MIN_PRODUCTION_KEY_LENGTH} characters in production`);
    }
  }
}

export interface SignOptions {
  audience?: string;
  ttlSeconds?: number;
}

export interface VerifyOptions {
  audience?: string;
}

export interface SignedToken {
  token: string;
  expiresAt: string; // ISO 8601
}

export interface TokenService {
  sign(attendeeId: string, opts?: SignOptions): Promise<SignedToken>;
  /** Returns the attendee ID (`sub`). Throws TokenError on any failure. */
  verify(token: string, opts?: VerifyOptions): Promise<string>;
}

export interface TokenServiceOptions {
  key: string;
  nodeEnv?: string;
  /** Override the clock, for tests. Returns ms since epoch. */
  now?: () => number;
}

/** Refuses to construct (and therefore to sign) with a missing or insecure key. */
export function createTokenService(opts: TokenServiceOptions): TokenService {
  assertSigningKey(opts.key, opts.nodeEnv);
  const secret = new TextEncoder().encode(opts.key);
  const now = opts.now ?? Date.now;

  return {
    async sign(attendeeId, { audience = DEFAULT_AUDIENCE, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS } = {}) {
      if (!attendeeId) throw new TokenError("invalid");
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new TokenConfigError("ttlSeconds must be a positive integer");
      const iat = Math.floor(now() / 1000);
      const exp = iat + ttlSeconds;
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: TOKEN_ALG, typ: "JWT" })
        .setSubject(attendeeId)
        .setIssuer(TOKEN_ISSUER)
        .setAudience(audience)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(secret);
      return { token, expiresAt: new Date(exp * 1000).toISOString() };
    },

    async verify(token, { audience = DEFAULT_AUDIENCE } = {}) {
      if (typeof token !== "string" || token.split(".").length !== 3) throw new TokenError("malformed");
      try {
        const { payload } = await jwtVerify(token, secret, {
          algorithms: [TOKEN_ALG],
          issuer: TOKEN_ISSUER,
          audience,
          currentDate: new Date(now()),
        });
        if (typeof payload.sub !== "string" || payload.sub === "") throw new TokenError("invalid");
        return payload.sub;
      } catch (err) {
        if (err instanceof TokenError) throw err;
        if (err instanceof joseErrors.JWTExpired) throw new TokenError("expired");
        throw new TokenError("invalid");
      }
    },
  };
}

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

/**
 * Returns the attendee ID from a valid Bearer token, or sends 401 and returns
 * null. Never logs or echoes the token or the attendee ID.
 */
export async function requireAttendee(
  tokens: TokenService,
  req: FastifyRequest,
  reply: FastifyReply,
  opts?: VerifyOptions,
): Promise<string | null> {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    await reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized", message: "missing bearer token" });
    return null;
  }
  try {
    return await tokens.verify(token, opts);
  } catch (err) {
    const reason = err instanceof TokenError ? err.reason : "invalid";
    await reply
      .code(401)
      .header("www-authenticate", `Bearer error="invalid_token"`)
      .send({ error: "unauthorized", message: `token ${reason}` });
    return null;
  }
}
