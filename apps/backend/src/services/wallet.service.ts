import { Keypair } from '@stellar/stellar-sdk';
import { createClient } from 'redis';

import prisma from '../config/database';
import { AppError } from '../types';
import type {
  CreateWalletOptions,
  DeleteWalletRequest,
  ListWalletsOptions,
  PaginatedWallets,
  Wallet,
  WalletBalance,
  WalletNetwork,
  WalletTransaction,
  WalletType,
  WalletWithKeys,
} from '../types';
import type { PaymentRecord } from '../types/transaction.types';
import { encrypt } from '../utils/crypto';

import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { StellarService } from './stellar.service';
import { TransactionService } from './transaction.service';
import { WebhookService } from './webhook.service';

function parseStellarStroops(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  const paddedFrac = frac.padEnd(7, '0').slice(0, 7);
  return BigInt(whole || '0') * 10_000_000n + BigInt(paddedFrac);
}

type RedisClient = ReturnType<typeof createClient>;
let redisClient: RedisClient | null = null;
let redisConnectPromise: Promise<RedisClient | null> | null = null;
let redisConnectionGeneration = 0;
const memoryCache = new Map<string, { value: string; expiresAt: number }>();
const MEMORY_CACHE_MAX_ENTRIES = 5000;

function pruneMemoryCache(): void {
  const now = Date.now();
  for (const [key, item] of memoryCache) {
    if (now > item.expiresAt) memoryCache.delete(key);
  }

  while (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    memoryCache.delete(oldest.value);
  }
}

async function getRedisClient(): Promise<RedisClient | null> {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    const connectionGeneration = ++redisConnectionGeneration;
    redisConnectPromise = (async (): Promise<RedisClient | null> => {
      let client: RedisClient | null = null;
      try {
        client = createClient({ url: process.env.REDIS_URL });
        client.on('error', (err) => {
          console.error('Redis wallet cache error:', err);
          if (redisConnectionGeneration === connectionGeneration) {
            redisConnectionGeneration++;
            if (redisClient === client) redisClient = null;
            redisConnectPromise = null;
          }
          client?.disconnect().catch(() => {});
        });
        await client.connect();
        if (redisConnectionGeneration !== connectionGeneration) {
          client.disconnect().catch(() => {});
          return null;
        }
        redisClient = client;
        return client;
      } catch (error) {
        console.error('Redis wallet cache unavailable, using memory fallback:', error);
        if (client) {
          client.disconnect().catch(() => {});
        }
        if (redisConnectionGeneration === connectionGeneration) {
          redisConnectionGeneration++;
          if (redisClient === client) redisClient = null;
          redisConnectPromise = null;
        }
        return null;
      }
    })();
  }

  return redisConnectPromise;
}

async function getFromCache<T>(key: string): Promise<T | null> {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    }

    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    return JSON.parse(item.value) as T;
  } catch {
    return null;
  }
}

async function setToCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    const redis = await getRedisClient();
    if (redis) {
      await redis.set(key, serialized, { EX: ttlSeconds });
      return;
    }

    pruneMemoryCache();
    memoryCache.set(key, {
      value: serialized,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  } catch (err) {
    console.error('Failed to set wallet cache:', err);
  }
}

async function deleteFromCache(key: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.del(key);
      return;
    }

    memoryCache.delete(key);
  } catch (err) {
    console.error('Failed to delete from wallet cache:', err);
  }
}

function getBalanceCacheKey(walletId: string): string {
  return `wallet:balance:${walletId}`;
}

export const WalletService = {
  /**
   * Invalidate cached balance for a wallet
   */
  async invalidateBalanceCache(walletId: string): Promise<void> {
    await deleteFromCache(getBalanceCacheKey(walletId));
  },

  /**
   * Clears in-memory cache (for testing purposes)
   */
  clearCacheForTesting(): void {
    memoryCache.clear();
  },

  /**
   * Creates a new Stellar wallet, encrypts the secret key, funds via Friendbot if testnet,
   * stores it in the database, emits webhook, and creates audit log.
   */
  async createWallet(options: CreateWalletOptions): Promise<WalletWithKeys> {
    const user = await prisma.user.findUnique({
      where: { id: options.userId },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    const secretKeyEncrypted = encrypt(secretKey);

    if (options.network === 'testnet') {
      await StellarService.fundTestnetAccount(publicKey);
    }

    const wallet = await prisma.wallet.create({
      data: {
        userId: options.userId,
        publicKey,
        secretKeyEncrypted,
        walletType: options.walletType,
        network: options.network,
        isActive: true,
      },
    });

    await WebhookService.emitEvent({
      eventType: 'wallet.created',
      payload: { walletId: wallet.id, walletType: wallet.walletType, network: wallet.network },
      userId: options.userId,
    });

    await AuditService.log({
      action: 'wallet.created',
      resource: 'wallet',
      resourceId: wallet.id,
      userId: options.userId,
      metadata: { walletType: wallet.walletType, network: wallet.network },
    });

    return {
      id: wallet.id,
      userId: wallet.userId,
      walletType: wallet.walletType as WalletType,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      status: wallet.isActive ? 'active' : 'archived',
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
      secretKey,
    };
  },

  async listWallets(options: ListWalletsOptions): Promise<PaginatedWallets> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20;
    const skip = (page - 1) * limit;
    const where: {
      userId: string;
      isActive: boolean;
      walletType?: string;
      network?: string;
    } = { userId: options.userId, isActive: true };

    if (options.walletType) where.walletType = options.walletType;
    if (options.network) where.network = options.network;

    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.wallet.count({ where }),
    ]);

    const data: Wallet[] = wallets.map((wallet) => ({
      id: wallet.id,
      userId: wallet.userId,
      walletType: wallet.walletType as WalletType,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      status: wallet.isActive ? 'active' : 'archived',
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    }));

    return {
      data,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  },

  async getWalletById(walletId: string, userId: string): Promise<Wallet> {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: { balances: true },
    });

    if (!wallet || wallet.userId !== userId || !wallet.isActive) {
      throw new AppError(404, 'Wallet not found');
    }

    let lastKnownBalance: string | undefined;
    const cachedBalances = await getFromCache<WalletBalance[]>(getBalanceCacheKey(walletId));
    const nativeBalance = cachedBalances?.find((balance) => balance.asset_type === 'native');
    if (nativeBalance) lastKnownBalance = nativeBalance.balance;

    if (!lastKnownBalance && wallet.balances.length > 0) {
      const dbNative = wallet.balances.find(
        (balance) => balance.assetCode === 'XLM' || balance.assetCode === 'native'
      );
      if (dbNative) lastKnownBalance = dbNative.balance;
    }

    return {
      id: wallet.id,
      userId: wallet.userId,
      walletType: wallet.walletType as WalletType,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      status: wallet.isActive ? 'active' : 'archived',
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
      lastKnownBalance,
    };
  },

  async getWalletBalances(walletId: string, userId: string): Promise<WalletBalance[]> {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId || !wallet.isActive) {
      throw new AppError(404, 'Wallet not found');
    }

    const cacheKey = getBalanceCacheKey(walletId);
    const cached = await getFromCache<WalletBalance[]>(cacheKey);
    if (cached) return cached;

    let balances: WalletBalance[] = [];
    try {
      const account = await StellarService.getHorizonServer().loadAccount(wallet.publicKey);
      balances = account.balances
        .filter(
          (balance) =>
            balance.asset_type === 'native' ||
            balance.asset_type === 'credit_alphanum4' ||
            balance.asset_type === 'credit_alphanum12'
        )
        .map((balance) => ({
          asset_type: balance.asset_type,
          balance: balance.balance,
          ...('asset_code' in balance && balance.asset_code
            ? { asset_code: balance.asset_code }
            : {}),
          ...('asset_issuer' in balance && balance.asset_issuer
            ? { asset_issuer: balance.asset_issuer }
            : {}),
          ...('buying_liabilities' in balance && balance.buying_liabilities
            ? { buying_liabilities: balance.buying_liabilities }
            : {}),
          ...('selling_liabilities' in balance && balance.selling_liabilities
            ? { selling_liabilities: balance.selling_liabilities }
            : {}),
          ...('limit' in balance && balance.limit ? { limit: balance.limit } : {}),
        }));
    } catch (error: unknown) {
      const response =
        error && typeof error === 'object' ? (error as { response?: unknown }).response : undefined;
      const status =
        response && typeof response === 'object'
          ? (response as { status?: unknown }).status
          : undefined;
      if (status === 404 || (error instanceof AppError && error.status === 404)) {
        balances = [];
      } else {
        console.error('Stellar getWalletBalances error:', error);
        throw new AppError(502, 'Failed to fetch account balances from Stellar');
      }
    }

    await setToCache(cacheKey, balances, 30);
    return balances;
  },

  async getWalletTransactions(
    walletId: string,
    userId: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<WalletTransaction[]> {
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId || !wallet.isActive) {
      throw new AppError(404, 'Wallet not found');
    }

    try {
      const records = await StellarService.getAccountTransactions(wallet.publicKey, options);
      return records.map((record) => {
        const extra = record as unknown as Record<string, unknown>;
        const result: WalletTransaction = {
          id: record.id,
          createdAt: new Date(record.created_at),
          type: typeof extra.type === 'string' ? extra.type : 'payment',
          successful: Boolean(record.successful),
          feeCharged: record.fee_charged !== undefined ? String(record.fee_charged) : undefined,
          memo: typeof record.memo === 'string' ? record.memo : undefined,
          memoType: typeof record.memo_type === 'string' ? record.memo_type : undefined,
          paging_token: record.paging_token,
        };
        if (typeof extra.amount === 'string' || typeof extra.amount === 'number') {
          result.amount = String(extra.amount);
        }
        if (typeof extra.asset === 'string') result.asset = extra.asset;
        else if (typeof extra.asset_code === 'string') result.asset = extra.asset_code;
        if (typeof extra.counterparty === 'string') result.counterparty = extra.counterparty;
        else if (typeof extra.to === 'string') result.counterparty = extra.to;
        else if (typeof extra.from === 'string') result.counterparty = extra.from;
        return result;
      });
    } catch (error: unknown) {
      const response =
        error && typeof error === 'object' ? (error as { response?: unknown }).response : undefined;
      const status =
        response && typeof response === 'object'
          ? (response as { status?: unknown }).status
          : undefined;
      if (status === 404) return [];
      if (error instanceof AppError) throw error;
      console.error('Stellar getWalletTransactions error:', error);
      throw new AppError(502, 'Failed to fetch account transactions');
    }
  },

  async deleteWallet(
    walletId: string,
    userId: string,
    confirmation: DeleteWalletRequest
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, 'User not found');

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.userId !== userId || !wallet.isActive) {
      throw new AppError(404, 'Wallet not found');
    }
    if (!confirmation.password) throw new AppError(400, 'Password confirmation is required');
    if (!user.passwordHash) throw new AppError(400, 'User password is not set');
    if (!(await AuthService.verifyPassword(confirmation.password, user.passwordHash))) {
      throw new AppError(400, 'Invalid password confirmation');
    }

    try {
      const account = await StellarService.getHorizonServer().loadAccount(wallet.publicKey);
      const subentries = Number(
        (account as unknown as Record<string, unknown>).subentry_count ?? 0
      );
      const minReserveStroops = BigInt(2 + subentries) * 5_000_000n;
      const hasSpendableBalance = account.balances.some((balance) => {
        const amount = parseStellarStroops(balance.balance);
        return balance.asset_type === 'native' ? amount > minReserveStroops : amount > 0n;
      });
      if (hasSpendableBalance) {
        throw new AppError(
          400,
          'WALLET_HAS_BALANCE: Wallet has a non-zero balance. Please transfer all funds before deleting.'
        );
      }
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      const response =
        error && typeof error === 'object' ? (error as { response?: unknown }).response : undefined;
      const status =
        response && typeof response === 'object'
          ? (response as { status?: unknown }).status
          : undefined;
      if (status !== 404) {
        console.error('Stellar verify balance error in deleteWallet:', error);
        throw new AppError(502, 'Failed to verify wallet balance on Stellar');
      }
    }

    await prisma.wallet.update({ where: { id: walletId }, data: { isActive: false } });
    await WalletService.invalidateBalanceCache(walletId);
    await WebhookService.emitEvent({
      eventType: 'wallet.archived',
      payload: { walletId: wallet.id, publicKey: wallet.publicKey },
      userId,
    });
    await AuditService.log({
      action: 'wallet.archived',
      resource: 'wallet',
      resourceId: wallet.id,
      userId,
      metadata: { publicKey: wallet.publicKey, walletType: wallet.walletType },
    });
  },

  /**
   * Sends funds directly from a wallet the user owns, moving real value on
   * Stellar via TransactionService (build → sign → submit → track).
   */
  async sendFromWallet(
    walletId: string,
    userId: string,
    params: {
      destination: string;
      amount: string;
      assetCode: string;
      assetIssuer?: string;
      memo?: string;
    }
  ): Promise<PaymentRecord> {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new AppError(404, 'Wallet not found');
    }
    if (wallet.userId !== userId) {
      throw new AppError(403, 'Wallet does not belong to user');
    }

    return TransactionService.buildAndSubmitPayment({
      sourceWalletId: wallet.id,
      userId,
      destination: params.destination,
      amount: params.amount,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      memo: params.memo,
    });
  },
};
