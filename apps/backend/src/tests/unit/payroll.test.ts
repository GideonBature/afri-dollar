/* eslint-disable */
import { Account, Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { PayrollService } from '../../services/payroll.service';
import { encrypt } from '../../utils/crypto';

// Setup Stellar Horizon mocks using global variables to avoid hoisting initialization issues
jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  const mockLoadAccount = jest.fn();
  const mockSubmitTransaction = jest.fn();

  (global as Record<string, unknown>).__mockLoadAccount = mockLoadAccount;
  (global as Record<string, unknown>).__mockSubmitTransaction = mockSubmitTransaction;

  return {
    ...original,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
      Memo: original.Horizon.Memo,
    },
  };
});

const mockLoadAccount = (global as Record<string, unknown>).__mockLoadAccount as jest.Mock;
const mockSubmitTransaction = (global as Record<string, unknown>)
  .__mockSubmitTransaction as jest.Mock;

// Mock Prisma client
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    wallet: {
      findUnique: jest.fn(),
    },
    payrollBatch: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payrollItem: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

// Typed prisma mock helpers to satisfy ESLint unbound-method rules
const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockPayrollBatchCreate = prisma.payrollBatch.create as jest.Mock;
const mockPayrollBatchFindUnique = prisma.payrollBatch.findUnique as jest.Mock;
const mockPayrollBatchUpdate = prisma.payrollBatch.update as jest.Mock;
const mockPayrollBatchUpdateMany = prisma.payrollBatch.updateMany as jest.Mock;
const mockPayrollItemCreate = prisma.payrollItem.create as jest.Mock;
const mockPayrollItemUpdate = prisma.payrollItem.update as jest.Mock;
const mockPayrollItemUpdateMany = prisma.payrollItem.updateMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;

describe('PayrollService', () => {
  const mockWalletId = 'wallet-id-123';
  const testKeypair = Keypair.random();
  const mockPublicKey = testKeypair.publicKey();
  const mockSecretKey = testKeypair.secret();
  let mockSecretEncrypted: string;
  const mockAssetIssuer = Keypair.random().publicKey();

  let originalEncryptionKey: string | undefined;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-octets-long-for-jest';
    mockSecretEncrypted = encrypt(mockSecretKey);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createPayrollBatch', () => {
    it('should create a batch successfully when the wallet exists', async () => {
      const mockWallet = { id: mockWalletId, publicKey: mockPublicKey };
      mockWalletFindUnique.mockResolvedValue(mockWallet);

      const mockBatch = {
        id: 'batch-123',
        name: 'June Payroll',
        walletId: mockWalletId,
        status: 'pending',
      };
      mockPayrollBatchCreate.mockResolvedValue(mockBatch);

      const result = await PayrollService.createPayrollBatch(
        { name: 'June Payroll', description: 'June payouts', walletId: mockWalletId },
        'user-1'
      );

      expect(mockWalletFindUnique).toHaveBeenCalledWith({ where: { id: mockWalletId } });
      expect(mockPayrollBatchCreate).toHaveBeenCalledWith({
        data: {
          name: 'June Payroll',
          description: 'June payouts',
          walletId: mockWalletId,
          status: 'pending',
        },
      });
      expect(mockAuditLogCreate).toHaveBeenCalled();
      expect(result).toEqual(mockBatch);
    });

    it('should throw an error when the wallet does not exist', async () => {
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(
        PayrollService.createPayrollBatch({ name: 'June Payroll', walletId: 'invalid-wallet' })
      ).rejects.toThrow('Wallet not found');

      expect(mockPayrollBatchCreate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_create_failed',
            success: false,
          }),
        })
      );
    });
  });

  describe('addPayrollItem', () => {
    it('should add a payroll item successfully to a pending batch', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      const mockItem = {
        id: 'item-1',
        payrollBatchId: 'batch-123',
        recipientAddress: mockPublicKey,
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: mockAssetIssuer,
        status: 'pending',
      };
      mockPayrollItemCreate.mockResolvedValue(mockItem);

      const result = await PayrollService.addPayrollItem('batch-123', {
        recipientAddress: mockPublicKey,
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: mockAssetIssuer,
      });

      expect(mockPayrollBatchFindUnique).toHaveBeenCalledWith({ where: { id: 'batch-123' } });
      expect(mockPayrollItemCreate).toHaveBeenCalledWith({
        data: {
          payrollBatchId: 'batch-123',
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
          memo: null,
          status: 'pending',
        },
      });
      expect(result).toEqual(mockItem);
    });

    it('should throw an error if the batch does not exist', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(null);

      await expect(
        PayrollService.addPayrollItem('invalid-batch', {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Payroll batch not found');
    });

    it('should throw an error if the batch is not pending approval', async () => {
      const mockBatch = { id: 'batch-123', status: 'approved' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Cannot add items to a batch that is not pending approval');
    });

    it('should throw an error if recipientAddress is invalid', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: 'invalid-address',
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Invalid Stellar recipient address');
    });

    it('should throw an error if amount is zero or negative', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '-50.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Amount must be a positive number');

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '0.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Amount must be a positive number');

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: 'invalid-num',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Amount must be a positive number');
    });

    it('should throw an error if assetCode is invalid', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'INVALIDASSETCODE12345', // too long
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Asset code must be a non-empty alphanumeric string of 1 to 12 characters');
    });

    it('should throw an error if assetIssuer is missing for non-XLM asset', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
        })
      ).rejects.toThrow('Asset issuer is required for non-XLM assets');
    });

    it('should throw an error if assetIssuer is provided for XLM (native)', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(
        PayrollService.addPayrollItem('batch-123', {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'XLM',
          assetIssuer: mockAssetIssuer,
        })
      ).rejects.toThrow('Asset issuer must not be provided for XLM (native asset)');
    });
  });

  describe('approvePayrollBatch', () => {
    it('should approve a pending batch successfully', async () => {
      const mockBatch = { id: 'batch-123', status: 'pending' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'approved',
      });

      const result = await PayrollService.approvePayrollBatch('batch-123', 'user-1');

      expect(mockPayrollBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-123' },
        data: { status: 'approved' },
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_approve',
            resourceId: 'batch-123',
            success: true,
          }),
        })
      );
      expect(result.status).toBe('approved');
    });

    it('should throw an error if trying to approve a non-pending batch', async () => {
      const mockBatch = { id: 'batch-123', status: 'processing' };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);

      await expect(PayrollService.approvePayrollBatch('batch-123')).rejects.toThrow(
        'Only pending batches can be approved'
      );
    });
  });

  describe('processPayrollBatch', () => {
    let mockBatch: any;

    beforeEach(() => {
      mockBatch = {
        id: 'batch-123',
        name: 'June Payroll',
        status: 'approved',
        wallet: {
          id: mockWalletId,
          publicKey: mockPublicKey,
          secretKeyEncrypted: mockSecretEncrypted,
        },
        items: [
          {
            id: 'item-1',
            recipientAddress: mockPublicKey,
            amount: '50.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
            memo: 'salary1',
            status: 'pending',
          },
          {
            id: 'item-2',
            recipientAddress: mockPublicKey,
            amount: '75.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
            memo: 'salary1',
            status: 'pending',
          },
        ],
      };
    });

    it('should successfully submit batched transactions', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });
      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'completed',
        items: mockBatch.items.map((i: any) => ({
          ...i,
          status: 'completed',
          stellarTxId: 'tx-hash-123',
        })),
      });

      // Mock loadAccount to return a valid Account instance
      const dummyAccount = new Account(mockPublicKey, '100');
      mockLoadAccount.mockResolvedValue(dummyAccount);
      // Mock submitTransaction to succeed
      mockSubmitTransaction.mockResolvedValue({ hash: 'tx-hash-123' });

      const result = await PayrollService.processPayrollBatch('batch-123', 'user-1');

      expect(mockPayrollBatchUpdateMany).toHaveBeenCalledWith({
        where: { id: 'batch-123', status: 'approved' },
        data: { status: 'processing' },
      });

      expect(mockLoadAccount).toHaveBeenCalledWith(mockPublicKey);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(mockPayrollItemUpdate).toHaveBeenCalledTimes(2); // Each item updated to completed
      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.items[0].status).toBe('completed');
    });

    it('should fallback to individual transactions if the batch submission fails', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });

      const completedItem1 = {
        ...mockBatch.items[0],
        status: 'completed',
        stellarTxId: 'tx-single-1',
      };
      const failedItem2 = {
        ...mockBatch.items[1],
        status: 'failed',
        errorMessage: 'Stellar payment failed',
      };

      // Mock update to reflect single updates
      mockPayrollItemUpdate
        .mockResolvedValueOnce(completedItem1)
        .mockResolvedValueOnce(failedItem2);

      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'completed',
        items: [completedItem1, failedItem2],
      });

      // Mock Horizon loadAccount
      const dummyAccount = new Account(mockPublicKey, '100');
      mockLoadAccount.mockResolvedValue(dummyAccount);

      // First call (batch) fails
      mockSubmitTransaction.mockRejectedValueOnce(new Error('Batch failed'));
      // Second call (item 1 single retry) succeeds
      mockSubmitTransaction.mockResolvedValueOnce({ hash: 'tx-single-1' });
      // Third call (item 2 single retry) fails
      const horizonError = new Error('Destination not found') as Error & { response: unknown };
      horizonError.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_no_destination'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValueOnce(horizonError);

      const result = await PayrollService.processPayrollBatch('batch-123', 'user-1');

      expect(mockSubmitTransaction).toHaveBeenCalledTimes(3); // 1 batch + 2 retries
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.items[0].status).toBe('completed');
      expect(result.items[1].status).toBe('failed');
    });

    it('should throw an error if the batch is already being processed', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 0 }); // simulating batch already processing

      await expect(PayrollService.processPayrollBatch('batch-123', 'user-1')).rejects.toThrow(
        'Batch is already being processed'
      );

      expect(mockLoadAccount).not.toHaveBeenCalled();
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
      expect(mockPayrollItemUpdate).not.toHaveBeenCalled();
      expect(mockPayrollItemUpdateMany).not.toHaveBeenCalled();
      expect(mockPayrollBatchUpdate).not.toHaveBeenCalled();
    });

    it('should revert batch status to approved and log failure on decryption error', async () => {
      const mockBatchWithInvalidSecret = {
        ...mockBatch,
        wallet: {
          ...mockBatch.wallet,
          secretKeyEncrypted: 'invalid-encrypted-key-format', // will cause decrypt() to fail
        },
      };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatchWithInvalidSecret);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });

      await expect(PayrollService.processPayrollBatch('batch-123', 'user-1')).rejects.toThrow(
        'Wallet decryption failure'
      );

      expect(mockPayrollBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-123' },
        data: { status: 'approved' },
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_process_failed',
            success: false,
          }),
        })
      );
    });
  });
});
