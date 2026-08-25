/* eslint-disable */
import type { Response } from 'express';

import { WalletController } from '../../controllers/wallet.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { WalletService } from '../../services/wallet.service';
import { AppError } from '../../types';

jest.mock('../../services/wallet.service');

const mockCreateWallet = WalletService.createWallet as jest.Mock;
const mockListWallets = WalletService.listWallets as jest.Mock;
const mockGetWalletById = WalletService.getWalletById as jest.Mock;
const mockGetWalletBalances = WalletService.getWalletBalances as jest.Mock;
const mockGetWalletTransactions = WalletService.getWalletTransactions as jest.Mock;
const mockDeleteWallet = WalletService.deleteWallet as jest.Mock;

describe('WalletController', () => {
  let mockReq: Partial<AuthRequest>;
  let mockRes: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      user: {
        userId: 'user-1',
        email: 'user@example.com',
        role: 'USER',
        iat: 0,
        exp: 0,
      },
      body: {},
      params: {},
      query: {},
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
    };
  });

  describe('create', () => {
    it('should create wallet and respond 201', async () => {
      mockReq.body = { walletType: 'business', network: 'testnet' };
      mockCreateWallet.mockResolvedValue({
        id: 'wallet-1',
        publicKey: 'GABC...',
        secretKey: 'SABC...',
      });

      await WalletController.create(mockReq as AuthRequest, mockRes as Response);

      expect(mockCreateWallet).toHaveBeenCalledWith({
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
      });
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          id: 'wallet-1',
          publicKey: 'GABC...',
          secretKey: 'SABC...',
        },
      });
    });

    it('should handle validation error with 400', async () => {
      mockReq.body = { walletType: 'invalid_type' };

      await WalletController.create(mockReq as AuthRequest, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Validation error' },
        })
      );
    });

    it('should return 401 when unauthenticated', async () => {
      mockReq.user = undefined;

      await WalletController.create(mockReq as AuthRequest, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  describe('list', () => {
    it('should return paginated wallets with 200', async () => {
      mockReq.query = { page: '1', limit: '10' };
      mockListWallets.mockResolvedValue({
        data: [{ id: 'wallet-1' }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });

      await WalletController.list(mockReq as AuthRequest, mockRes as Response);

      expect(mockListWallets).toHaveBeenCalledWith({
        userId: 'user-1',
        page: 1,
        limit: 10,
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: [{ id: 'wallet-1' }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
    });
  });

  describe('getById', () => {
    it('should return single wallet with 200', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockGetWalletById.mockResolvedValue({ id: 'wallet-1', publicKey: 'GABC...' });

      await WalletController.getById(mockReq as AuthRequest, mockRes as Response);

      expect(mockGetWalletById).toHaveBeenCalledWith('wallet-1', 'user-1');
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: { id: 'wallet-1', publicKey: 'GABC...' },
      });
    });

    it('should return 404 when wallet not found', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockGetWalletById.mockRejectedValue(new AppError(404, 'Wallet not found'));

      await WalletController.getById(mockReq as AuthRequest, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: { code: 'WALLET_ERROR', message: 'Wallet not found' },
      });
    });
  });

  describe('getBalances', () => {
    it('should return balances with 200', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockGetWalletBalances.mockResolvedValue([{ asset_type: 'native', balance: '100' }]);

      await WalletController.getBalances(mockReq as AuthRequest, mockRes as Response);

      expect(mockGetWalletBalances).toHaveBeenCalledWith('wallet-1', 'user-1');
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: [{ asset_type: 'native', balance: '100' }],
      });
    });
  });

  describe('getTransactions', () => {
    it('should return transactions with 200', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockReq.query = { limit: '10' };
      mockGetWalletTransactions.mockResolvedValue([{ id: 'tx-1' }]);

      await WalletController.getTransactions(mockReq as AuthRequest, mockRes as Response);

      expect(mockGetWalletTransactions).toHaveBeenCalledWith('wallet-1', 'user-1', {
        limit: 10,
        cursor: undefined,
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: [{ id: 'tx-1' }],
      });
    });
  });

  describe('delete', () => {
    it('should delete/archive wallet with 200', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockReq.body = { password: 'secretpassword' };
      mockDeleteWallet.mockResolvedValue(undefined);

      await WalletController.delete(mockReq as AuthRequest, mockRes as Response);

      expect(mockDeleteWallet).toHaveBeenCalledWith('wallet-1', 'user-1', {
        password: 'secretpassword',
      });
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        message: 'Wallet archived successfully',
      });
    });

    it('should return 400 when validation fails', async () => {
      mockReq.params = { id: 'wallet-1' };
      mockReq.body = {}; // missing password/twoFactorToken

      await WalletController.delete(mockReq as AuthRequest, mockRes as Response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Validation error' },
        })
      );
    });
  });
});
