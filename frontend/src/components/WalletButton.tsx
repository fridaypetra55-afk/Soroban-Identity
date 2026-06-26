import { useWallet } from "../hooks/useWallet";

export default function WalletButton() {
  const { publicKey, connected, connecting, error, connect, disconnect } =
    useWallet();

  const short = (key: string) =>
    `${key.slice(0, 4)}…${key.slice(-4)}`;

  return (
    <div className="wallet-button">
      {connected && publicKey ? (
        <div className="wallet-button--connected">
          <span className="badge badge-green wallet-button__address">{short(publicKey)}</span>
          <button
            className="wallet-button__disconnect"
            onClick={disconnect}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          className="wallet-button__connect"
          onClick={connect}
          disabled={connecting}
        >
          {connecting ? "Connecting…" : "Connect Freighter"}
        </button>
      )}
      {error && (
        <span className="wallet-button__error">{error}</span>
      )}
    </div>
  );
}
