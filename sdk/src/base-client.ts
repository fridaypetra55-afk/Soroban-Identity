import { SorobanRpc } from "@stellar/stellar-sdk";
import type { SorobanIdentityConfig } from "./types";

const serverCache = new Map<string, SorobanRpc.Server>();

export function getOrCreateServer(rpcUrl: string): SorobanRpc.Server {
  if (!serverCache.has(rpcUrl)) {
    serverCache.set(rpcUrl, new SorobanRpc.Server(rpcUrl));
  }
  return serverCache.get(rpcUrl)!;
}

export function clearServerCache(): void {
  serverCache.clear();
}

export abstract class BaseClient {
  protected server: SorobanRpc.Server;
  protected contract: Contract;
  protected config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig, contractId: string) {
    this.config = config;
    this.server = getOrCreateServer(config.rpcUrl);
    this.contract = new Contract(contractId);
  }
}