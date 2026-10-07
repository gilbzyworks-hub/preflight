// Every program ID and known-address list used by the token checks lives here, with where it came from.
// Nothing here is a wallet or credential; these are public on-chain addresses. Each entry is re-checked
// on-chain (exists + executable) by scripts/spike-solana.mts. Last verified: see `verifiedAt`.
export const CONFIG_VERIFIED_AT = "2026-10-07";

// ---- Token programs ----
// Source: https://www.solana-program.com/docs/token-2022/extensions ("Program ID: Tokenz...") and the
// classic SPL Token program, confirmed on-chain by the spike (owner of every classic mint).
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// ---- Burn addresses ----
// Source: anza-xyz/solana-sdk sdk-ids ("incinerator": address for burning lamports). It is documented as a
// lamport burn address; sending tokens to it is a convention, so matches are labelled "burn address (convention)".
// The system program ID as a token-account owner is likewise unrecoverable by convention.
export const BURN_ADDRESSES: Record<string, string> = {
  "1nc1nerator11111111111111111111111111111111": "Incinerator",
  "11111111111111111111111111111111": "System program (unrecoverable owner)",
};

// ---- DEX / AMM programs: an off-curve owner controlled by one of these is a pool vault authority ----
// Sources: Raydium https://docs.raydium.io/reference/program-addresses ; Orca
// https://docs.orca.so/developers/architecture/whirlpool-parameters ; pump.fun official IDLs
// https://github.com/pump-fun/pump-public-docs (idl/pump.json, idl/pump_amm.json, "address" field) ;
// Meteora https://docs.meteora.ag (program IDs page; not reachable by the fetch tool, so confirmed on-chain only).
export const DEX_PROGRAMS: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h": "Raydium Stable AMM",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpools",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap AMM",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "Meteora DAMM v2",
};

// ---- Lock / vesting programs: labelled and excluded from "adjusted" holders ----
// Sources: https://developers.streamflow.finance/docs/resources/program-ids ; https://developers.jup.ag/docs/lock
export const LOCK_PROGRAMS: Record<string, string> = {
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": "Streamflow",
  "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn": "Jupiter Lock",
};

// ---- Token-2022 mint extensions as emitted by RPC jsonParsed (agave account-decoder UiExtension, camelCase) ----
// Source: https://github.com/anza-xyz/agave/blob/master/account-decoder/src/parse_token_extension.rs
// Extension descriptions: https://www.solana-program.com/docs/token-2022/extensions
export const KNOWN_BENIGN_EXTENSIONS = new Set([
  "metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer", "tokenGroup", "tokenGroupMember",
  "immutableOwner", "memoTransfer", "cpiGuard", "transferFeeAmount", "transferHookAccount",
  "nonTransferableAccount", "pausableAccount", "confidentialTransferAccount", "confidentialTransferFeeAmount",
]);

// ---- Vault-authority PDAs of pool programs ----
// Some pools keep reserves in token accounts owned by a program-wide PDA that has no account data, so the "owner's
// program" lookup cannot see it. These are derived at runtime from the verified program IDs above and these seeds
// (official source: raydium-io/raydium-amm processor.rs AUTHORITY_AMM; raydium-io/raydium-cp-swap lib.rs AUTH_SEED;
// MeteoraAg/damm-v2 constants.rs POOL_AUTHORITY_PREFIX). Each seed is only trusted after the spike matched it
// against real vault owners on-chain (see scripts/spike-solana.mts, "authority check").
export const DEX_AUTHORITY_SEEDS: { program: string; seed: string; label: string }[] = [
  { program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", seed: "amm authority", label: "Raydium AMM v4" },
  { program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", seed: "vault_and_lp_mint_auth_seed", label: "Raydium CPMM" },
  { program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", seed: "pool_authority", label: "Meteora DAMM v2" },
];

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// ---- pump.fun bonding curve (creator lookup) ----
// Source: official IDL https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
//   PDA: seeds ["bonding-curve", mint] under the pump program; account = 8-byte discriminator
//   [23,183,248,55,96,216,172,96], then 5 x u64, bool `complete`, then `creator` (pubkey) at byte offset 49.
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_BONDING_CURVE_SEED = "bonding-curve";
export const PUMP_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
export const PUMP_CURVE_CREATOR_OFFSET = 49;
