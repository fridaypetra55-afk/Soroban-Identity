export { IdentityClient } from "./identity";
export { CredentialClient } from "./credentials";
export { ReputationClient } from "./reputation";
export type {
  DidDocument,
  Credential,
  CredentialType,
  VerifyResult,
  VerifyFailReason,
  SorobanIdentityConfig,
  ReputationRecord,
  ScoreHistoryEntry,
} from "./types";
export { executeTransaction } from "./transaction";
export type { TxOptions } from "./transaction";

// Testnet defaults — fill contract IDs after deployment
export const TESTNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  identityRegistryId: "",
  credentialManagerId: "",
  reputationId: "",
};

// Mainnet defaults — fill contract IDs after deployment
export const MAINNET_CONFIG: SorobanIdentityConfig = {
  rpcUrl: "https://soroban-mainnet.stellar.org",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  identityRegistryId: "",
  credentialManagerId: "",
  reputationId: "",
};
