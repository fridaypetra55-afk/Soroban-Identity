import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
} from "@stellar/stellar-sdk";
import type { DidDocument, SorobanIdentityConfig } from "./types";
import { executeTransaction, TxOptions } from "./transaction";
import {
  encodeAddress,
  encodeMap,
  decodeDidDocument,
  decodeString,
  decodeBoolean,
} from "./codec";

export class IdentityClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.identityRegistryId);
  }

  /**
   * Create a new DID for the given keypair.
   */
  async createDid(
    keypair: Keypair,
    metadata: Record<string, string> = {},
    txOptions?: TxOptions
  ): Promise<string> {
    const account = await this.server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "create_did",
          encodeAddress(keypair.publicKey()),
          encodeMap(metadata)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    try {
      const confirmed = await executeTransaction(
        this.server,
        tx,
        (t) => t.sign(keypair),
        txOptions
      );
      return decodeString(confirmed.returnValue!);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID already exists")) {
        throw new Error(
          `A DID already exists for address ${keypair.publicKey()}. Each address can only have one DID.`
        );
      }
      throw e;
    }
  }

  /**
   * Update metadata on an existing DID.
   */
  async updateDid(
    keypair: Keypair,
    metadata: Record<string, string>,
    txOptions?: TxOptions
  ): Promise<void> {
    const account = await this.server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "update_did",
          encodeAddress(keypair.publicKey()),
          encodeMap(metadata)
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    try {
      await executeTransaction(this.server, tx, (t) => t.sign(keypair), txOptions);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("DID not found")) {
        throw new Error(
          `No DID found for address ${keypair.publicKey()}. Create one first with createDid.`
        );
      }
      if (msg.includes("require_auth") || msg.includes("not authorized")) {
        throw new Error(
          `Address ${keypair.publicKey()} is not the controller of this DID.`
        );
      }
      throw e;
    }
  }

  /**
   * Resolve a DID document by controller address.
   */
  async resolveDid(controllerAddress: string): Promise<DidDocument> {
    const account = await this.server.getAccount(controllerAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("resolve_did", encodeAddress(controllerAddress))
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return decodeDidDocument(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }

  /**
   * Check if an address has an active DID.
   */
  async hasActiveDid(controllerAddress: string): Promise<boolean> {
    const account = await this.server.getAccount(controllerAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call("has_active_did", encodeAddress(controllerAddress))
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) return false;

    return decodeBoolean(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval
    );
  }
}
