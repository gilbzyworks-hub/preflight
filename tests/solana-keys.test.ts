import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { base58Decode, base58Encode, findProgramAddress, isOnCurve } from "@shared/solana-keys.ts";

describe("solana-keys matches @solana/web3.js", () => {
  it("base58 round-trips, including leading zero bytes", () => {
    for (const s of ["11111111111111111111111111111111", "1nc1nerator11111111111111111111111111111111", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      expect(base58Encode(base58Decode(s))).toBe(s);
      expect(base58Decode(s)).toEqual(new PublicKey(s).toBytes());
    }
  });

  it("on-curve test agrees on random wallets and random hashes", () => {
    for (let i = 0; i < 60; i++) {
      const kp = Keypair.generate().publicKey.toBytes();
      expect(isOnCurve(kp)).toBe(true);
      const rnd = crypto.getRandomValues(new Uint8Array(32));
      expect(isOnCurve(rnd)).toBe(PublicKey.isOnCurve(rnd));
    }
  });

  it("PDA derivation matches web3.js (string, pubkey and bump seeds)", async () => {
    const program = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const cases: [(Uint8Array | string)[], string][] = [
      [["amm authority"], program],
      [["bonding-curve", base58Decode(mint)], "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
    ];
    for (const [seeds, pid] of cases) {
      const ours = await findProgramAddress(seeds, pid);
      const [theirs, bump] = PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.from(s))), new PublicKey(pid));
      expect(ours.address).toBe(theirs.toBase58());
      expect(ours.bump).toBe(bump);
    }
  });
});
