import crypto from 'crypto';

/**
 * Refresh tokens are 64 random bytes, so only a SHA-256 of each is stored: someone who can read
 * the database (a backup, a copied volume) cannot use the rows to sign in. A fast hash is enough
 * for random tokens; password hashing would only slow every refresh down.
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse JWT_REFRESH_EXPIRY ("30m", "12h", "7d", "2w"). A unit is required: jsonwebtoken reads a
 * bare number in a string as milliseconds, which is never what was meant for a session length.
 */
export function parseRefreshExpiry(raw: string): number {
  const match = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(raw);
  const ms = match ? Number(match[1]) * UNIT_MS[match[2].toLowerCase()] : 0;
  if (!ms) {
    throw new Error(`JWT_REFRESH_EXPIRY=${raw} is not a duration; use a number with s, m, h, d or w, e.g. "7d".`);
  }
  return ms;
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** A new token for the client and the hash to store for it. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(64).toString('hex');
  return { token, hash: hashRefreshToken(token) };
}

/** Hashes are 64 hex characters; rows written before hashing hold the 128-character token itself. */
export async function purgeUnhashedRefreshTokens(prisma: {
  $executeRawUnsafe(query: string): Promise<number>;
}): Promise<number> {
  return prisma.$executeRawUnsafe('DELETE FROM "RefreshToken" WHERE length("token") <> 64');
}
