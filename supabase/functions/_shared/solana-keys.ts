// Dependency-free Solana address helpers (base58, ed25519 on-curve test, PDA derivation) so the same code runs in
// the Next.js server and the Deno edge function. Cross-checked against @solana/web3.js in tests/solana-keys.test.ts.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  for (const ch of s) { if (ch === "1") zeros++; else break; }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x === 0) out = "1" + out; else break; }
  return out;
}

const P = (1n << 255n) - 19n;
const D = (((P - 121665n) % P) * modpow(121666n, P - 2n, P)) % P; // -121665/121666

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

/** True when the 32 bytes decode to a point on the ed25519 curve (i.e. could be a wallet's public key). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const t = (u * modpow(v, P - 2n, P)) % P; // x^2
  if (t === 0n) return true;
  return modpow(t, (P - 1n) / 2n, P) === 1n; // Euler's criterion: x^2 has a square root
}

const enc = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));

/** findProgramAddress: highest bump whose hash is off the curve. */
export async function findProgramAddress(seeds: (Uint8Array | string)[], programId: string): Promise<{ address: string; bump: number }> {
  const parts = seeds.map((s) => (typeof s === "string" ? enc.encode(s) : s));
  for (const p of parts) if (p.length > 32) throw new Error("Seed too long");
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const data = new Uint8Array([...parts.flatMap((p) => [...p]), bump, ...program, ...enc.encode("ProgramDerivedAddress")]);
    const hash = await sha256(data);
    if (!isOnCurve(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error("No viable bump");
}

export const isValidAddress = (s: string): boolean => {
  try { return base58Decode(s).length === 32; } catch { return false; }
};
