import { Router } from 'express';

import { WalletController } from '../controllers/wallet.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  ipPreAuthRateLimiter,
  sensitiveRateLimiter,
  generalRateLimiter,
} from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validation.middleware';
import { createWalletSchema, deleteWalletSchema } from '../utils/validation';

const walletRouter = Router();

// Apply IP rate limiting before authentication so unauthenticated requests are limited
walletRouter.use(ipPreAuthRateLimiter);
walletRouter.use(authMiddleware);

/**
 * POST /api/v1/wallet
 * Creates a new Stellar wallet
 */
walletRouter.post('/', sensitiveRateLimiter, validate(createWalletSchema), (req, res, next) => {
  WalletController.create(req, res).catch(next);
});

/**
 * POST /api/v1/wallet/create (backward compatibility)
 */
walletRouter.post(
  '/create',
  sensitiveRateLimiter,
  validate(createWalletSchema),
  (req, res, next) => {
    WalletController.create(req, res).catch(next);
  }
);

/**
 * GET /api/v1/wallet
 * Returns all active wallets for the authenticated user (paginated)
 */
walletRouter.get('/', generalRateLimiter, (req, res, next) => {
  WalletController.list(req, res).catch(next);
});

/**
 * GET /api/v1/wallet/:id/balances
 * Fetches real-time balances from Stellar Horizon (cached 30s)
 */
walletRouter.get('/:id/balances', generalRateLimiter, (req, res, next) => {
  WalletController.getBalances(req, res).catch(next);
});

/**
 * GET /api/v1/wallet/:id/transactions
 * Fetches paginated transaction history from Stellar Horizon
 */
walletRouter.get('/:id/transactions', generalRateLimiter, (req, res, next) => {
  WalletController.getTransactions(req, res).catch(next);
});

/**
 * GET /api/v1/wallet/:id
 * Returns a single wallet by ID
 */
walletRouter.get('/:id', generalRateLimiter, (req, res, next) => {
  WalletController.getById(req, res).catch(next);
});

/**
 * DELETE /api/v1/wallet/:id
 * Soft-deletes a wallet if real-time balance is zero
 */
walletRouter.delete(
  '/:id',
  sensitiveRateLimiter,
  validate(deleteWalletSchema),
  (req, res, next) => {
    WalletController.delete(req, res).catch(next);
  }
);

export default walletRouter;
