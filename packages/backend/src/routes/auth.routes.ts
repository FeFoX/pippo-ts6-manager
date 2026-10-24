import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword } from '../utils/validate-password.js';
import { hashRefreshToken, newRefreshToken } from '../utils/refresh-token.js';

export const authRoutes: Router = Router();

// Unknown and disabled users are checked against this, so every login costs one bcrypt
// comparison and the response time does not tell which usernames exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(nanoid(32), 12);

const refreshExpiresAt = () => new Date(Date.now() + config.refreshTokenTtlMs);

const meRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

authRoutes.post('/login', async (req: Request, res: Response, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError(400, 'Username and password required');

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { username } });

    const valid = await bcrypt.compare(String(password), user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.enabled || !valid) throw new AppError(401, 'Invalid credentials');

    const payload = { id: user.id, username: user.username, role: user.role };
    const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);
    const { token: refreshToken, hash } = newRefreshToken();
    const family = nanoid();

    await prisma.refreshToken.create({
      data: { token: hash, userId: user.id, expiresAt: refreshExpiresAt(), family },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (err) { next(err); }
});

authRoutes.post('/refresh', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const prisma = req.app.locals.prisma;
    const presented = hashRefreshToken(String(refreshToken));
    const stored = await prisma.refreshToken.findUnique({
      where: { token: presented },
      include: { user: true },
    });

    if (!stored) {
      // H5: Token not found — check if it was already used (reuse detection)
      const replaced = await prisma.refreshToken.findFirst({
        where: { replacedBy: presented },
      });
      if (replaced) {
        // Reuse detected! Revoke entire token family
        console.warn(`[SECURITY] Refresh token reuse detected for user ${replaced.userId}. Revoking all tokens.`);
        await prisma.refreshToken.deleteMany({ where: { userId: replaced.userId } });
      }
      throw new AppError(401, 'Invalid refresh token');
    }

    if (stored.expiresAt < new Date() || !stored.user.enabled) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new AppError(401, 'Invalid refresh token');
    }

    // Rotate: mark old token as replaced, create new one in same family
    const rotated = newRefreshToken();

    // Concurrent refresh (multi-tab) can delete this row between findUnique and update.
    const marked = await prisma.refreshToken.updateMany({
      where: { id: stored.id },
      data: { replacedBy: rotated.hash },
    });
    if (marked.count === 0) {
      throw new AppError(401, 'Invalid refresh token');
    }

    await prisma.refreshToken.create({
      data: { token: rotated.hash, userId: stored.userId, expiresAt: refreshExpiresAt(), family: stored.family },
    });

    // Delete old token after creating new one (ignore if already gone)
    await prisma.refreshToken.deleteMany({ where: { id: stored.id } });

    const payload = { id: stored.user.id, username: stored.user.username, role: stored.user.role };
    const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);

    res.json({ accessToken, refreshToken: rotated.token });
  } catch (err) { next(err); }
});

authRoutes.post('/logout', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const prisma = req.app.locals.prisma;
      await prisma.refreshToken.deleteMany({ where: { token: hashRefreshToken(String(refreshToken)) } });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

authRoutes.get('/me', meRateLimiter, authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (err) { next(err); }
});

authRoutes.put('/password', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw new AppError(400, 'Both passwords required');

    const pwError = validatePassword(newPassword);
    if (pwError) throw new AppError(400, pwError);

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all refresh tokens on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    res.status(204).send();
  } catch (err) { next(err); }
});
