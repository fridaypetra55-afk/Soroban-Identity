import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
} from "@stellar/stellar-sdk";
import type { SorobanIdentityConfig, ReputationRecord, ScoreHistoryEntry } from "./types";
import { executeTransaction, TxOptions } from "./transaction";
import {
  encodeAddress,
  encodeI64,
  encodeU32,
  encodeString,
  decodeReputationRecord,
  decodeScoreHistory,
  decodeBoolean,
} from "./codec";

export type { ReputationRecord, ScoreHistoryEntry };

export class ReputationClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.reputationId);
  }

  /** Get the reputation record for a subject. */
  async getReputation(callerAddress: string, subjectAddress: string): Promise<ReputationRecord> {
    const account = await this.server.getAccount(callerAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("get_reputation", encodeAddress(subjectAddress))
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return decodeReputationRecord(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }

  /**
   * Get score submission history for a subject from a specific reporter.
   *
   * @param callerAddress   - Stellar address used to build the transaction.
   * @param subjectAddress  - The subject whose history is being queried.
   * @param reporterAddress - The reporter whose submissions to retrieve.
   * @param offset          - Number of entries to skip (default: 0).
   * @param limit           - Maximum entries to return (default: 20, contract cap: 100).
   */
  async getScoreHistory(
    callerAddress: string,
    subjectAddress: string,
    reporterAddress: string,
    offset = 0,
    limit = 20
  ): Promise<ScoreHistoryEntry[]> {
    const account = await this.server.getAccount(callerAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_history",
          encodeAddress(subjectAddress),
          encodeAddress(reporterAddress),
          encodeU32(offset),
          encodeU32(limit)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return decodeScoreHistory(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }

  /** Check if a subject passes the sybil threshold. */
  async passesSybilCheck(
    callerAddress: string,
    subjectAddress: string,
    minScore: number,
    minReporters: number
  ): Promise<boolean> {
    const account = await this.server.getAccount(callerAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "passes_sybil_check",
          encodeAddress(subjectAddress),
          encodeI64(minScore),
          encodeU32(minReporters)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return decodeBoolean(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }

  /** Submit a score delta. Caller must be a registered reporter. */
  async submitScore(
    reporterKeypair: Keypair,
    subjectAddress: string,
    delta: number,
    reason: string,
    txOptions?: TxOptions
  ): Promise<void> {
    const account = await this.server.getAccount(reporterKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "submit_score",
          encodeAddress(reporterKeypair.publicKey()),
          encodeAddress(subjectAddress),
          encodeI64(delta),
          encodeString(reason)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    await executeTransaction(
      this.server,
      tx,
      (t) => t.sign(reporterKeypair),
      txOptions
    );
  }
}
