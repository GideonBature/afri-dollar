export type WalletType = 'business' | 'treasury' | 'payroll';
export type WalletNetwork = 'testnet' | 'mainnet';
export type WalletStatus = 'active' | 'archived';

export interface Wallet {
  id: string;
  userId: string;
  walletType: WalletType;
  network: WalletNetwork;
  publicKey: string;
  status: WalletStatus;
  createdAt: Date;
  updatedAt: Date;
  lastKnownBalance?: string;
}

export interface WalletBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  limit?: string;
}

export interface WalletTransaction {
  id: string;
  createdAt: Date;
  type:
    | 'payment'
    | 'create_account'
    | 'account_merge'
    | 'path_payment_strict_receive'
    | 'path_payment_strict_send'
    | string;
  amount?: string;
  asset?: string;
  counterparty?: string;
  memo?: string;
  memoType?: string;
  successful: boolean;
  feeCharged?: string;
  paging_token: string;
}

export interface DeleteWalletRequest {
  password: string;
}

export interface CreateWalletOptions {
  userId: string;
  walletType: WalletType;
  network: WalletNetwork;
}

export interface WalletWithKeys {
  id: string;
  publicKey: string;
  secretKey?: string;
  userId?: string;
  walletType?: WalletType;
  network?: WalletNetwork;
  status?: WalletStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ListWalletsOptions {
  userId: string;
  walletType?: WalletType;
  network?: WalletNetwork;
  page?: number;
  limit?: number;
}

export interface PaginatedWallets {
  data: Wallet[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}
