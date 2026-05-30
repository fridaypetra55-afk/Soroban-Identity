export class ContractError extends Error {
  readonly code: number;

  constructor(code: number, errorMap: Record<number, string>) {
    super(errorMap[code] ?? `Contract error code ${code}`);
    this.name = 'ContractError';
    this.code = code;
  }

  static extract(errMsg: string, errorMap: Record<number, string>): ContractError | null {
    const match = errMsg.match(/#(\d+)/);
    if (!match) return null;
    return new ContractError(parseInt(match[1], 10), errorMap);
  }
}
