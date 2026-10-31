import { SignJWT, generateKeyPair, exportSPKI, KeyInput } from 'jose';

let rs256PrivateKey: KeyInput | null = null;

export async function createTestToken(userId: string): Promise<string> {
  const alg = process.env.JWT_ALGORITHM === 'RS256' ? 'RS256' : 'HS256';

  if (alg === 'RS256') {
    if (!rs256PrivateKey) {
      const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
      rs256PrivateKey = privateKey;
      const spki = await exportSPKI(publicKey);
      process.env.JWT_SECRET = spki;
    }
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(userId)
      .sign(rs256PrivateKey);
  } else {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-local-jwt-secret-not-for-production-use');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .sign(secret);
  }
}