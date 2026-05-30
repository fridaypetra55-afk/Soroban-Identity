import { createContext, useContext, ReactNode } from "react";
import { WalletState } from "../hooks/useWallet";

interface WalletContextProps {
  wallet: WalletState & {
    connect: (walletType?: string) => void;
    disconnect: () => void;
    signTransaction: (xdr: string) => Promise<string>;
  };
}

const WalletContext = createContext<WalletContextProps | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  // Importing here to avoid circular dependency issues
  const { useWallet } = require("../hooks/useWallet");
  const wallet = useWallet();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWalletContext() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletContext must be used inside WalletProvider");
  return ctx;
}