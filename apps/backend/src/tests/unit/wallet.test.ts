/* eslint-disable */
import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { AuditService } from '../../services/audit.service';
import { AuthService } from '../../services/auth.service';
import { StellarService } from '../../services/stellar.service';
import { WalletService } from '../../services/wallet.service';
import { WebhookService } from '../../services/webhook.service';
import { encrypt } from '../../utils/crypto';

const mockPublicKey = 'GABC1234567890123456789012345678901234567890123456789012';
const mockSecretKey = 'SABC1234567890123456789012345678901234567890123456789012';

jest.mock('../../services/webhook.service', () => ({
  WebhookService: {
    emitEvent: jest.fn(),
  },
}));

jest.mock('../../services/audit.service', () => ({
  AuditService: {
    log: jest.fn(),
  },
}));

jest.mock('../../services/auth.service', () => ({
  AuthService: {
    verifyPassword: jest.fn(),
  },
}));

const mockLoadAccount = jest.fn();
const mockTransactionsForAccount = jest.fn();

jest.mock('../../services/stellar.service', () => ({
  StellarService: {
    fundTestnetAccount: jest.fn(),
    getHorizonServer: jest.fn(() => ({
      loadAccount: mockLoadAccount,
      transactions: jest.fn(() => ({
        forAccount: mockTransactionsForAccount,
      })),
    })),
    getAccountTransactions: jest.fn(),
  },
}));

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    wallet: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    random: jest.fn(),
  },
  Config: {
    setTimeout: jest.fn(),
  },
  Horizon: {
    Server: jest.fn(),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn(),
}));

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockWalletCreate = prisma.wallet.create as jest.Mock;
const mockWalletFindMany = prisma.wallet.findMany as jest.Mock;
const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockWalletCount = prisma.wallet.count as jest.Mock;
const mockWalletUpdate = prisma.wallet.update as jest.Mock;
const mockFundTestnetAccount = StellarService.fundTestnetAccount as jest.Mock;
const mockGetAccountTransactions = StellarService.getAccountTransactions as jest.Mock;
const mockAuthVerifyPassword = AuthService.verifyPassword as jest.Mock;

describe('WalletService', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!';
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDIS_URL;
    WalletService.clearCacheForTesting();

    (Keypair.random as jest.Mock).mockReturnValue({
      publicKey: () => mockPublicKey,
      secret: () => mockSecretKey,
    });

    (encrypt as jest.Mock).mockReturnValue('encrypted:secret:key');
  });

  describe('createWallet', () => {
    it('should generate keypair, encrypt secret, fund testnet and persist wallet', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      mockWalletCreate.mockResolvedValue({
        id: 'wallet-1',
        publicKey: mockPublicKey,
        secretKeyEncrypted: 'encrypted:secret:key',
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      mockFundTestnetAccount.mockResolvedValue(undefined);

      const result = await WalletService.createWallet({
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
      });

      expect(Keypair.random).toHaveBeenCalledTimes(1);
      expect(encrypt).toHaveBeenCalledWith(mockSecretKey);
      expect(mockFundTestnetAccount).toHaveBeenCalledWith(mockPublicKey);
      expect(mockWalletCreate).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          publicKey: mockPublicKey,
          secretKeyEncrypted: 'encrypted:secret:key',
          walletType: 'business',
          network: 'testnet',
          isActive: true,
        },
      });
      expect(WebhookService.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'wallet.created', userId: 'user-1' })
      );
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'wallet.created', resourceId: 'wallet-1' })
      );
      expect(result).toMatchObject({
        id: 'wallet-1',
        publicKey: mockPublicKey,
        secretKey: mockSecretKey,
        status: 'active',
      });
    });

    it('should skip friendbot funding for mainnet wallets', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-2',
        email: 'test@example.com',
      });
      mockWalletCreate.mockResolvedValue({
        id: 'wallet-2',
        publicKey: mockPublicKey,
        secretKeyEncrypted: 'encrypted:secret:key',
        userId: 'user-2',
        walletType: 'treasury',
        network: 'mainnet',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await WalletService.createWallet({
        userId: 'user-2',
        walletType: 'treasury',
        network: 'mainnet',
      });

      expect(mockFundTestnetAccount).not.toHaveBeenCalled();
      expect(result.id).toBe('wallet-2');
    });

    it('should throw when user does not exist', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(
        WalletService.createWallet({
          userId: 'nonexistent',
          walletType: 'payroll',
          network: 'testnet',
        })
      ).rejects.toThrow('User not found');

      expect(Keypair.random).not.toHaveBeenCalled();
      expect(mockWalletCreate).not.toHaveBeenCalled();
    });
  });

  describe('listWallets', () => {
    it('should return paginated wallets for the user with filters', async () => {
      const now = new Date();
      mockWalletFindMany.mockResolvedValue([
        {
          id: 'wallet-1',
          userId: 'user-1',
          walletType: 'business',
          network: 'testnet',
          publicKey: 'GABC1',
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      mockWalletCount.mockResolvedValue(1);

      const result = await WalletService.listWallets({
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
        page: 1,
        limit: 10,
      });

      expect(mockWalletFindMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          isActive: true,
          walletType: 'business',
          network: 'testnet',
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: 'wallet-1',
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
        publicKey: 'GABC1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      expect(result.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });
  });

  describe('getWalletById', () => {
    it('should return wallet details and cached/DB last-known balance', async () => {
      const now = new Date();
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
        publicKey: 'GABC1',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        balances: [{ assetCode: 'XLM', balance: '100.50' }],
      });

      const result = await WalletService.getWalletById('wallet-1', 'user-1');

      expect(result).toEqual({
        id: 'wallet-1',
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
        publicKey: 'GABC1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastKnownBalance: '100.50',
      });
    });

    it('should throw 404 when wallet is not found or not owned by user', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'other-user',
        isActive: true,
      });

      await expect(WalletService.getWalletById('wallet-1', 'user-1')).rejects.toMatchObject({
        status: 404,
        message: 'Wallet not found',
      });
    });

    it('should throw 404 when wallet is inactive / archived', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        isActive: false,
      });

      await expect(WalletService.getWalletById('wallet-1', 'user-1')).rejects.toMatchObject({
        status: 404,
        message: 'Wallet not found',
      });
    });
  });

  describe('getWalletBalances', () => {
    it('should fetch real-time balances from Horizon and cache them', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'native',
            balance: '250.0000000',
            buying_liabilities: '0.0000000',
            selling_liabilities: '0.0000000',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            balance: '50.0000000',
            limit: '10000.0000000',
          },
        ],
      });

      const balances = await WalletService.getWalletBalances('wallet-1', 'user-1');

      expect(balances).toEqual([
        {
          asset_type: 'native',
          balance: '250.0000000',
          buying_liabilities: '0.0000000',
          selling_liabilities: '0.0000000',
        },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          balance: '50.0000000',
          limit: '10000.0000000',
        },
      ]);
    });

    it('should return cached balances without querying Horizon on cache hit', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-cache-test',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'native',
            balance: '300.0000000',
          },
        ],
      });

      // First call: cache miss
      const balancesFirst = await WalletService.getWalletBalances('wallet-cache-test', 'user-1');
      expect(balancesFirst).toEqual([{ asset_type: 'native', balance: '300.0000000' }]);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call: cache hit
      const balancesSecond = await WalletService.getWalletBalances('wallet-cache-test', 'user-1');
      expect(balancesSecond).toEqual([{ asset_type: 'native', balance: '300.0000000' }]);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1); // loadAccount was not called again
    });

    it('should gracefully handle 404 from Horizon by returning empty balances', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockLoadAccount.mockRejectedValue({
        response: { status: 404 },
      });

      const balances = await WalletService.getWalletBalances('wallet-1', 'user-1');
      expect(balances).toEqual([]);
    });

    it('should throw 404 when wallet does not exist', async () => {
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(WalletService.getWalletBalances('wallet-none', 'user-1')).rejects.toMatchObject({
        status: 404,
        message: 'Wallet not found',
      });
    });
  });

  describe('getWalletTransactions', () => {
    it('should fetch and normalize transactions from Horizon', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockGetAccountTransactions.mockResolvedValue([
        {
          id: 'tx-1',
          created_at: '2026-01-01T12:00:00Z',
          type: 'payment',
          successful: true,
          fee_charged: 100,
          memo: 'test memo',
          memo_type: 'text',
          paging_token: '12345',
          amount: '50.0000000',
          asset: 'XLM',
          counterparty: 'GBXYZ123',
        },
        {
          id: 'tx-2',
          created_at: '2026-01-02T12:00:00Z',
          type: 'create_account',
          successful: true,
          fee_charged: 100,
          paging_token: '12346',
          amount: '10000.0000000',
          asset: 'native',
          from: 'GBFRIENDBOT',
        },
      ]);

      const txs = await WalletService.getWalletTransactions('wallet-1', 'user-1', {
        limit: 20,
      });

      expect(txs).toHaveLength(2);
      expect(txs[0]).toEqual({
        id: 'tx-1',
        createdAt: new Date('2026-01-01T12:00:00Z'),
        type: 'payment',
        successful: true,
        feeCharged: '100',
        memo: 'test memo',
        memoType: 'text',
        paging_token: '12345',
        amount: '50.0000000',
        asset: 'XLM',
        counterparty: 'GBXYZ123',
      });
      expect(txs[1]).toEqual({
        id: 'tx-2',
        createdAt: new Date('2026-01-02T12:00:00Z'),
        type: 'create_account',
        successful: true,
        feeCharged: '100',
        paging_token: '12346',
        amount: '10000.0000000',
        asset: 'native',
        counterparty: 'GBFRIENDBOT',
      });
    });

    it('should gracefully return empty array when account not found on Horizon', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockGetAccountTransactions.mockRejectedValue({
        response: { status: 404 },
      });

      const txs = await WalletService.getWalletTransactions('wallet-1', 'user-1');
      expect(txs).toEqual([]);
    });
  });

  describe('deleteWallet', () => {
    it('should throw 400 when password verification fails', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed_password',
      });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        isActive: true,
      });
      mockAuthVerifyPassword.mockResolvedValue(false);

      await expect(
        WalletService.deleteWallet('wallet-1', 'user-1', { password: 'wrongpassword' })
      ).rejects.toMatchObject({
        status: 400,
        message: 'Invalid password confirmation',
      });
    });

    it('should return 404 before verifying a password for an unavailable wallet', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hashed_password' });
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(
        WalletService.deleteWallet('wallet-none', 'user-1', { password: 'wrongpassword' })
      ).rejects.toMatchObject({ status: 404, message: 'Wallet not found' });

      expect(mockAuthVerifyPassword).not.toHaveBeenCalled();
    });

    it('should map Horizon balance failures to a fixed 502 error', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hashed_password' });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockLoadAccount.mockRejectedValue(new Error('connect ECONNREFUSED horizon.internal:8000'));

      await expect(WalletService.getWalletBalances('wallet-1', 'user-1')).rejects.toMatchObject({
        status: 502,
        message: 'Failed to fetch account balances from Stellar',
      });
    });

    it('should map Horizon transaction failures to a fixed 502 error', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });
      mockGetAccountTransactions.mockRejectedValue(
        new Error('horizon.internal:8000 leaked detail')
      );

      await expect(WalletService.getWalletTransactions('wallet-1', 'user-1')).rejects.toMatchObject(
        {
          status: 502,
          message: 'Failed to fetch account transactions',
        }
      );
    });

    it('should map Horizon delete balance failures to a fixed 502 error', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hashed_password' });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockLoadAccount.mockRejectedValue(new Error('horizon.internal:8000 leaked detail'));

      await expect(
        WalletService.deleteWallet('wallet-1', 'user-1', { password: 'correctpassword' })
      ).rejects.toMatchObject({
        status: 502,
        message: 'Failed to verify wallet balance on Stellar',
      });
    });

    it('should throw 400 WALLET_HAS_BALANCE when wallet has non-zero transferable native balance on Horizon', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed_password',
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '10.5000000',
          },
        ],
      });

      await expect(
        WalletService.deleteWallet('wallet-1', 'user-1', { password: 'correctpassword' })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('WALLET_HAS_BALANCE'),
      });

      expect(mockWalletUpdate).not.toHaveBeenCalled();
    });

    it('should throw 400 WALLET_HAS_BALANCE when wallet has non-native token balance on Horizon', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed_password',
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        subentry_count: 1,
        balances: [
          {
            asset_type: 'native',
            balance: '1.5000000', // equals base reserve (2+1)*0.5 = 1.5
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            balance: '25.0000000',
          },
        ],
      });

      await expect(
        WalletService.deleteWallet('wallet-1', 'user-1', { password: 'correctpassword' })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('WALLET_HAS_BALANCE'),
      });

      expect(mockWalletUpdate).not.toHaveBeenCalled();
    });

    it('should soft-delete wallet when native balance equals base reserve (1.0 XLM) and password matches', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed_password',
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        walletType: 'business',
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '1.0000000',
          },
        ],
      });

      mockWalletUpdate.mockResolvedValue({
        id: 'wallet-1',
        isActive: false,
      });

      await WalletService.deleteWallet('wallet-1', 'user-1', { password: 'correctpassword' });

      expect(mockWalletUpdate).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { isActive: false },
      });
      expect(WebhookService.emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'wallet.archived' })
      );
    });

    it('should allow soft-delete when account is 404 / unfunded on Horizon', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed_password',
      });
      mockAuthVerifyPassword.mockResolvedValue(true);
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: mockPublicKey,
        walletType: 'business',
        isActive: true,
      });

      mockLoadAccount.mockRejectedValue({
        response: { status: 404 },
      });

      mockWalletUpdate.mockResolvedValue({
        id: 'wallet-1',
        isActive: false,
      });

      await WalletService.deleteWallet('wallet-1', 'user-1', { password: 'correctpassword' });

      expect(mockWalletUpdate).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { isActive: false },
      });
    });
  });
});
