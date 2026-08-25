import type { Response } from 'express';
import { ZodError } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { WalletService } from '../services/wallet.service';
import { AppError } from '../types';
import {
  createWalletSchema,
  listWalletsSchema,
  walletIdParamSchema,
  walletTransactionsQuerySchema,
  deleteWalletSchema,
} from '../utils/validation';

function handleError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation error' },
      details: error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: { code: 'WALLET_ERROR', message: error.message },
    });
    return;
  }

  console.error('Unhandled wallet controller error:', error);

  res.status(500).json({
    success: false,
    error: { code: 'SERVER_ERROR', message: 'Internal server error' },
  });
}

function requireUserId(req: AuthRequest, res: Response): string | null {
  if (!req.user?.userId) {
    res.status(401).json({
      success: false,
      error: { code: 'AUTH_ERROR', message: 'Unauthorized' },
    });
    return null;
  }
  return req.user.userId;
}

export const WalletController = {
  /**
   * POST /api/v1/wallet (and POST /api/v1/wallet/create)
   */
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const body = createWalletSchema.parse(req.body);

      const wallet = await WalletService.createWallet({
        userId,
        walletType: body.walletType,
        network: body.network,
      });

      res.status(201).json({
        success: true,
        data: wallet,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/wallet
   */
  async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const query = listWalletsSchema.parse(req.query);

      const result = await WalletService.listWallets({
        userId,
        walletType: query.walletType,
        network: query.network,
        page: query.page,
        limit: query.limit,
      });

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/wallet/:id
   */
  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const { id } = walletIdParamSchema.parse(req.params);

      const wallet = await WalletService.getWalletById(id, userId);

      res.status(200).json({
        success: true,
        data: wallet,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/wallet/:id/balances
   */
  async getBalances(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const { id } = walletIdParamSchema.parse(req.params);

      const balances = await WalletService.getWalletBalances(id, userId);

      res.status(200).json({
        success: true,
        data: balances,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/wallet/:id/transactions
   */
  async getTransactions(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const { id } = walletIdParamSchema.parse(req.params);
      const query = walletTransactionsQuerySchema.parse(req.query);

      const transactions = await WalletService.getWalletTransactions(id, userId, {
        limit: query.limit,
        cursor: query.cursor,
      });

      res.status(200).json({
        success: true,
        data: transactions,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * DELETE /api/v1/wallet/:id
   */
  async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUserId(req, res);
      if (!userId) return;

      const { id } = walletIdParamSchema.parse(req.params);
      const body = deleteWalletSchema.parse(req.body);

      await WalletService.deleteWallet(id, userId, body);

      res.status(200).json({
        success: true,
        message: 'Wallet archived successfully',
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
