import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
} from "@stellar/stellar-sdk";
import type { Credential, CredentialType, SorobanIdentityConfig, VerifyResult } from "./types";
import { executeTransaction, TxOptions } from "./transaction";
import {
  encodeAddress,
  encodeMap,
  encodeBytes,
  encodeSymbol,
  encodeU64,
  decodeCredential,
  decodeCredentialId,
  decodeCredentialIdList,
  decodeBoolean,
} from "./codec";

export class CredentialClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.credentialManagerId);
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    expiresAt = 0,
    txOptions?: TxOptions
  ): Promise<string> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());

    const signature = issuerKeypair.sign(
      Buffer.from(JSON.stringify({ subjectAddress, claims }))
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "issue_credential",
          encodeAddress(issuerKeypair.publicKey()),
          encodeAddress(subjectAddress),
          encodeSymbol(credentialType),
          encodeMap(claims),
          encodeBytes(Buffer.from(signature)),
          encodeU64(expiresAt)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const confirmed = await executeTransaction(
      this.server,
      tx,
      (t) => t.sign(issuerKeypair),
      txOptions
    );
    const raw = decodeCredentialId(confirmed.returnValue!);
    return Buffer.from(raw).toString("hex");
  }

  /**
   * Verify a credential is valid (not revoked, not expired).
   * Returns a typed result so callers can distinguish failure reasons.
   */
  async verifyCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<VerifyResult> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("verify_credential", encodeBytes(idBytes))
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(result)) {
      const error: string = (result as { error: string }).error ?? "";
      if (error.includes("credential not found")) {
        return { valid: false, reason: "not_found" };
      }
      return { valid: false, reason: "unknown" };
    }

    const valid = decodeBoolean(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );

    if (valid) return { valid: true };

    try {
      const cred = await this.getCredential(callerAddress, credentialId);
      if (cred.revoked) return { valid: false, reason: "revoked" };
      if (cred.expiresAt > 0 && Date.now() / 1000 > cred.expiresAt) {
        return { valid: false, reason: "expired" };
      }
    } catch {
      return { valid: false, reason: "not_found" };
    }

    return { valid: false, reason: "unknown" };
  }

  /**
   * Get all credentials issued to a subject address.
   */
  async getCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string
  ): Promise<Credential[]> {
    const account = await this.server.getAccount(callerAddress);

    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_subject_credentials",
          encodeAddress(subjectAddress)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const idsResult = await this.server.simulateTransaction(idsTx);
    if (SorobanRpc.Api.isSimulationError(idsResult)) {
      throw new Error(`Simulation failed: ${idsResult.error}`);
    }

    const ids = decodeCredentialIdList(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );

    if (!ids || ids.length === 0) return [];

    return Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString("hex"))
      )
    );
  }

  /**
   * Get a credential by ID.
   */
  async getCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<Credential> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("get_credential", encodeBytes(idBytes))
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return decodeCredential(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }
}
