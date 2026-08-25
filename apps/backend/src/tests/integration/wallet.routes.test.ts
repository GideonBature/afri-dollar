/* eslint-disable */
import type { Server } from 'http';

import prisma from '../../config/database';
import { WalletService } from '../../services/wallet.service';

jest.mock('../../middleware/auth.middleware', () => ({
  ...jest.requireActual('../../middleware/auth.middleware'),
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'user-1', email: 'user@example.com', role: 'USER', iat: 0, exp: 0 };
    next();
  },
}));

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
    verifyPassword: jest.fn().mockResolvedValue(true),
  },
}));

const mockLoadAccount = jest.fn();

jest.mock('../../services/stellar.service', () => ({
  StellarService: {
    fundTestnetAccount: jest.fn().mockResolvedValue(undefined),
    getHorizonServer: jest.fn(() => ({
      loadAccount: mockLoadAccount,
    })),
    getAccountTransactions: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../config/database', () => {
  const mockFn = () => jest.fn();
  const client: Record<string, unknown> = {
    user: {
      findUnique: mockFn(),
    },
    wallet: {
      create: mockFn(),
      findMany: mockFn(),
      findUnique: mockFn(),
      update: mockFn(),
      count: mockFn(),
    },
    $connect: mockFn(),
    $disconnect: mockFn(),
  };
  return { __esModule: true, default: client };
});

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockWalletCreate = prisma.wallet.create as jest.Mock;
const mockWalletFindMany = prisma.wallet.findMany as jest.Mock;
const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockWalletCount = prisma.wallet.count as jest.Mock;
const mockWalletUpdate = prisma.wallet.update as jest.Mock;

describe('Wallet routes (integration)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!';
    const { app } = await import('../../index');
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address && typeof address === 'object') {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    delete process.env.ENCRYPTION_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDIS_URL;
    WalletService.clearCacheForTesting();
  });

  describe('POST /api/v1/wallet', () => {
    it('should create wallet with 201', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });
      mockWalletCreate.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC1234567890123456789012345678901234567890123456789012',
        secretKeyEncrypted: 'enc',
        walletType: 'business',
        network: 'testnet',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletType: 'business', network: 'testnet' }),
      });

      expect(response.status).toBe(201);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('wallet-1');
    });

    it('should reject invalid walletType with 400', async () => {
      const response = await fetch(`${baseUrl}/api/v1/wallet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletType: 'invalid' }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe('GET /api/v1/wallet', () => {
    it('should return paginated wallets with 200', async () => {
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

      const response = await fetch(`${baseUrl}/api/v1/wallet?page=1&limit=20`);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.pagination.total).toBe(1);
    });
  });

  describe('GET /api/v1/wallet/:id', () => {
    it('should return wallet by ID with 200', async () => {
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
        balances: [],
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1`);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('wallet-1');
    });

    it('should return 404 for nonexistent wallet', async () => {
      mockWalletFindUnique.mockResolvedValue(null);

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-none`);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/wallet/:id/balances', () => {
    it('should return wallet balances with 200', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC1',
        isActive: true,
      });

      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1/balances`);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
    });
  });

  describe('GET /api/v1/wallet/:id/transactions', () => {
    it('should return transactions with 200', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC1',
        isActive: true,
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1/transactions?limit=10`);

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });

  describe('DELETE /api/v1/wallet/:id', () => {
    it('should soft delete wallet when balance is zero', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC1',
        walletType: 'business',
        isActive: true,
      });
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '0.0000000' }],
        subentry_count: 0,
      });
      mockWalletUpdate.mockResolvedValue({ id: 'wallet-1', isActive: false });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'correctpassword' }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.message).toBe('Wallet archived successfully');
    });

    it('should return 404 when wallet belongs to another user', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-other',
        userId: 'user-2',
        publicKey: 'GABC2',
        walletType: 'business',
        isActive: true,
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-other`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'correctpassword' }),
      });

      expect(response.status).toBe(404);
    });

    it('should return 400 when password is missing', async () => {
      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it('should return 400 when wallet has non-zero spendable balance', async () => {
      mockUserFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'hash' });
      mockWalletFindUnique.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC1',
        walletType: 'business',
        isActive: true,
      });
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
        subentry_count: 0,
      });

      const response = await fetch(`${baseUrl}/api/v1/wallet/wallet-1`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'correctpassword' }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });
});
