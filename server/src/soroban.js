import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CircuitBreaker, SorobanUnavailableError } from './circuit-breaker.js';

export { SorobanUnavailableError };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pool of long-lived worker processes that execute Stellar CLI commands.
 *
 * Keeps `size` worker processes alive so repeated invocations avoid the
 * overhead of spawning a new OS process per call. Workers are restarted
 * automatically if they exit unexpectedly.
 *
 * Pool size is controlled via the `SOROBAN_POOL_SIZE` environment variable
 * (default: 4).
 */
class SubprocessPool {
  #workers = [];
  #queue = [];
  #draining = false;
  #drainResolvers = [];
  #stellarCli;
  #size;

  constructor({ size = 4, stellarCli = 'stellar' } = {}) {
    this.#size = size;
    this.#stellarCli = stellarCli;
  }

  /** Spawn all worker processes. Call before the HTTP server starts listening. */
  start() {
    for (let i = 0; i < this.#size; i++) {
      this.#spawnWorker();
    }
  }

  #spawnWorker() {
    const workerPath = path.join(__dirname, 'soroban-worker.js');
    const proc = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const worker = { proc, busy: false, resolve: null, reject: null };

    createInterface({ input: proc.stdout, terminal: false }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      const { resolve, reject } = worker;
      worker.busy = false;
      worker.resolve = null;
      worker.reject = null;

      if (msg.ok) resolve(msg.output);
      else reject(new Error(msg.error));

      if (this.#draining && this.#queue.length === 0 && this.#workers.every(w => !w.busy)) {
        for (const w of this.#workers) w.proc.stdin.end();
        for (const r of this.#drainResolvers) r();
        this.#drainResolvers = [];
      } else {
        this.#dispatch();
      }
    });

    proc.on('exit', () => {
      this.#workers = this.#workers.filter(w => w !== worker);
      if (worker.reject) {
        worker.reject(new Error('worker process exited unexpectedly'));
        worker.resolve = null;
        worker.reject = null;
      }
      if (!this.#draining) {
        this.#spawnWorker();
      }
    });

    this.#workers.push(worker);
    this.#dispatch();
  }

  #dispatch() {
    if (this.#queue.length === 0) return;
    const free = this.#workers.find(w => !w.busy);
    if (!free) return;
    const { commandArgs, resolve, reject } = this.#queue.shift();
    free.busy = true;
    free.resolve = resolve;
    free.reject = reject;
    free.proc.stdin.write(JSON.stringify({ stellarCli: this.#stellarCli, args: commandArgs }) + '\n');
  }

  /**
   * Dispatch a command to a free worker (or queue it until one is available).
   *
   * @param {string[]} commandArgs Args to pass to the Stellar CLI worker.
   * @returns {Promise<string>} stdout from the CLI invocation.
   */
  invoke(commandArgs) {
    if (this.#draining) {
      return Promise.reject(new Error('Pool is draining — no new invocations accepted'));
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ commandArgs, resolve, reject });
      this.#dispatch();
    });
  }

  /**
   * Wait for all in-flight and queued calls to complete, then shut down workers.
   *
   * @returns {Promise<void>}
   */
  drain() {
    this.#draining = true;
    if (this.#queue.length === 0 && this.#workers.every(w => !w.busy)) {
      for (const w of this.#workers) w.proc.stdin.end();
      return Promise.resolve();
    }
    return new Promise(resolve => this.#drainResolvers.push(resolve));
  }
}

export class SorobanClient {
  constructor(config, metrics) {
    this.config = config;
    this.metrics = metrics;
    this.pool = new SubprocessPool({
      size: config.poolSize ?? 4,
      stellarCli: config.stellarCli,
    });
    this.pool.start();
    this.circuitBreaker = new CircuitBreaker();
  }

  async invoke(contractId, method, args = []) {
    if (!contractId) throw new Error('Contract ID is not configured');
    if (!this.config.sourceAccount) throw new Error('STELLAR_SOURCE_ACCOUNT or STELLAR_SECRET_KEY is required');
    const commandArgs = [
      'contract',
      'invoke',
      '--id', contractId,
      '--source', this.config.sourceAccount,
      '--network', this.config.network,
      '--rpc-url', this.config.rpcUrl,
      '--',
      method,
      ...args,
    ];
    const started = performance.now();
    try {
      const output = await this.circuitBreaker.call(() => this.pool.invoke(commandArgs));
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
      return output;
    } catch (error) {
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
      throw error;
    }
  }

  async pingAllContracts() {
    const entries = Object.entries(this.config.contracts);
    const results = await Promise.allSettled(entries.map(([name, id]) => this.invoke(id, 'ping').then(() => [name, true])));
    const contracts = Object.fromEntries(entries.map(([name]) => [name, false]));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const [name, ok] = result.value;
        contracts[name] = ok;
      }
    }
    return contracts;
  }

  async getIssuers() {
    const raw = await this.invoke(this.config.contracts.credential, 'get_issuers');
    return parseAddressList(raw);
  }

  async addIssuer(issuer) {
    return this.invoke(this.config.contracts.credential, 'add_issuer', ['--issuer', issuer]);
  }

  async removeIssuer(issuer) {
    return this.invoke(this.config.contracts.credential, 'remove_issuer', ['--issuer', issuer]);
  }

  async getEvents(startLedger) {
    const started = performance.now();
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: {
          startLedger,
          filters: [{ type: 'contract' }],
          limit: 200,
        },
      };
      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`RPC getEvents failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message ?? 'RPC getEvents failed');
      return payload.result?.events ?? [];
    } finally {
      this.metrics?.observeRpcLatency((performance.now() - started) / 1000);
    }
  }

  /** Gracefully drain the worker pool before shutdown. */
  drain() {
    return this.pool.drain();
  }
}

function parseAddressList(raw) {
  const matches = raw.match(/G[A-Z0-9]{55}/g);
  return matches ? [...new Set(matches)] : [];
}
