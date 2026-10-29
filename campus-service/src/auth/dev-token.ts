/**
 * DEV ONLY — mint an HS256 token for local testing.
 *   npm run dev:token -- u_aanya "Aanya" aanya@iiserkol.ac.in
 * Requires AUTH_DEV_HS256_SECRET and NODE_ENV != production.
 */
import { SignJWT } from 'jose';
import { config } from '../config.js';

export async function mintDevToken(sub: string, extra: Record<string, unknown> = {}, ttlSeconds = 60 * 60 * 24 * 30) {
  if (config.isProd) throw new Error('dev tokens are disabled in production');
  if (!config.auth.devHs256Secret) throw new Error('AUTH_DEV_HS256_SECRET is not set');
  return new SignJWT({ ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(config.auth.devHs256Secret));
}

if (process.argv[1]?.endsWith('dev-token.ts')) {
  const [sub = 'u_dev', name = 'Dev Squirrel', email = 'dev@iiserkol.ac.in'] = process.argv.slice(2);
  mintDevToken(sub, { name, email }).then((t) => console.log(t));
}
