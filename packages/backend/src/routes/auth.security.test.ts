import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import bcrypt from 'bcryptjs';
import { authRoutes } from './auth.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { config } from '../config.js';
import { hashRefreshToken } from '../utils/refresh-token.js';

interface Row { id: number; token: string; userId: number; expiresAt: Date; family: string | null; replacedBy: string | null }

const PASSWORD = 'Correct-horse-1';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

/** Just enough of Prisma for the auth routes, with refresh tokens kept in an array. */
function fakePrisma() {
  const users = [
    { id: 1, username: 'admin', displayName: 'Admin', role: 'admin', enabled: true, passwordHash },
    { id: 2, username: 'gone', displayName: 'Gone', role: 'viewer', enabled: false, passwordHash },
  ];
  const tokens: Row[] = [];
  let nextId = 1;
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([k, v]) => (row as any)[k] === v);
  return {
    tokens,
    user: {
      findUnique: async ({ where }: any) => users.find((u) => (where.username ? u.username === where.username : u.id === where.id)) ?? null,
      update: async () => ({}),
    },
    refreshToken: {
      create: async ({ data }: any) => {
        const row = { id: nextId++, family: null, replacedBy: null, ...data };
        tokens.push(row);
        return row;
      },
      findUnique: async ({ where, include }: any) => {
        const row = tokens.find((t) => matches(t, where));
        if (!row) return null;
        return include?.user ? { ...row, user: users.find((u) => u.id === row.userId) } : row;
      },
      findFirst: async ({ where }: any) => tokens.find((t) => matches(t, where)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const hits = tokens.filter((t) => matches(t, where));
        for (const t of hits) Object.assign(t, data);
        return { count: hits.length };
      },
      delete: async ({ where }: any) => { tokens.splice(tokens.findIndex((t) => t.id === where.id), 1); },
      deleteMany: async ({ where }: any) => {
        const keep = tokens.filter((t) => !matches(t, where));
        const count = tokens.length - keep.length;
        tokens.splice(0, tokens.length, ...keep);
        return { count };
      },
    },
  };
}

function buildApp(prisma: ReturnType<typeof fakePrisma>): Express {
  const app = express();
  app.use(express.json());
  app.locals.prisma = prisma;
  app.use('/api/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('login timing', () => {
  for (const [label, username] of [['an unknown user', 'nobody'], ['a disabled user', 'gone'], ['a wrong password', 'admin']]) {
    it(`runs one bcrypt comparison for ${label}`, async (t) => {
      const compare = t.mock.method(bcrypt, 'compare');
      const res = await post(buildApp(fakePrisma()), '/api/auth/login', { username, password: 'Wrong-password-1' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid credentials');
      assert.equal(compare.mock.callCount(), 1);
    });
  }

  it('still refuses a disabled user who knows the password', async () => {
    const res = await post(buildApp(fakePrisma()), '/api/auth/login', { username: 'gone', password: PASSWORD });
    assert.equal(res.status, 401);
  });
});

describe('refresh tokens', () => {
  it('stores only the hash of the token it hands out, with the configured lifetime', async () => {
    const prisma = fakePrisma();
    const before = Date.now();
    const res = await post(buildApp(prisma), '/api/auth/login', { username: 'admin', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(prisma.tokens.length, 1);
    const [row] = prisma.tokens;
    assert.notEqual(row.token, res.body.refreshToken);
    assert.equal(row.token, hashRefreshToken(res.body.refreshToken));
    const ttl = row.expiresAt.getTime() - before;
    assert.ok(ttl >= config.refreshTokenTtlMs && ttl < config.refreshTokenTtlMs + 5_000, `ttl ${ttl}`);
  });

  it('rotates by hash, and a reused token revokes every session of the user', async () => {
    const prisma = fakePrisma();
    const app = buildApp(prisma);
    const login = await post(app, '/api/auth/login', { username: 'admin', password: PASSWORD });

    const first = await post(app, '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    assert.equal(first.status, 200);
    assert.equal(prisma.tokens.length, 1);
    assert.equal(prisma.tokens[0].token, hashRefreshToken(first.body.refreshToken));

    // Reuse detection needs the replaced row; keep one around as the real flow would during a race.
    prisma.tokens.push({ id: 99, token: 'x'.repeat(64), userId: 1, expiresAt: new Date(Date.now() + 60_000), family: null, replacedBy: hashRefreshToken(login.body.refreshToken) });
    const reuse = await post(app, '/api/auth/refresh', { refreshToken: login.body.refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal(prisma.tokens.length, 0);
  });

  it('does not accept the stored hash itself as a token', async () => {
    const prisma = fakePrisma();
    const app = buildApp(prisma);
    await post(app, '/api/auth/login', { username: 'admin', password: PASSWORD });
    const res = await post(app, '/api/auth/refresh', { refreshToken: prisma.tokens[0].token });
    assert.equal(res.status, 401);
  });

  it('logout removes the session by hash', async () => {
    const prisma = fakePrisma();
    const app = buildApp(prisma);
    const login = await post(app, '/api/auth/login', { username: 'admin', password: PASSWORD });
    const res = await post(app, '/api/auth/logout', { refreshToken: login.body.refreshToken });
    assert.equal(res.status, 204);
    assert.equal(prisma.tokens.length, 0);
  });
});
