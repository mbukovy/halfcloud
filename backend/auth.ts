import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'halfcloud_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function safeEqual(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export class AuthService {
  private constructor(
    private readonly accessCode: string,
    private readonly signingKey: Buffer,
  ) {}

  static async create() {
    const codeFile = process.env.HALFCLOUD_ACCESS_CODE_FILE ?? '/opt/halfcloud/data/access-code';
    const accessCode = (process.env.HALFCLOUD_ACCESS_CODE ?? (await readFile(codeFile, 'utf8'))).trim();
    if (!accessCode) throw new Error('HalfCloud access code is empty');
    const configuredSecret = process.env.HALFCLOUD_SESSION_SECRET;
    if (configuredSecret !== undefined && configuredSecret.length < 32) {
      throw new Error('HALFCLOUD_SESSION_SECRET must contain at least 32 characters');
    }
    const secret = configuredSecret ?? createHash('sha256').update(`halfcloud:${accessCode}`).digest('hex');
    return new AuthService(accessCode, Buffer.from(secret));
  }

  verifyAccessCode(candidate: unknown) {
    return typeof candidate === 'string' && safeEqual(candidate.trim().toUpperCase(), this.accessCode.toUpperCase());
  }

  setSession(response: Response) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const nonce = randomBytes(12).toString('base64url');
    const payload = `${expires}.${nonce}`;
    const signature = createHmac('sha256', this.signingKey).update(payload).digest('base64url');
    response.cookie(COOKIE_NAME, `${payload}.${signature}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_SECONDS * 1000,
    });
  }

  clearSession(response: Response) {
    response.clearCookie(COOKIE_NAME, { path: '/' });
  }

  isAuthenticated(request: Request) {
    const token = request.cookies?.[COOKIE_NAME];
    if (typeof token !== 'string') return false;
    const [expires, nonce, signature, ...extra] = token.split('.');
    if (!expires || !nonce || !signature || extra.length || Number(expires) < Date.now() / 1000) return false;
    const expected = createHmac('sha256', this.signingKey).update(`${expires}.${nonce}`).digest('base64url');
    return safeEqual(signature, expected);
  }

  middleware = (request: Request, response: Response, next: NextFunction) => {
    if (!this.isAuthenticated(request)) {
      response.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}
