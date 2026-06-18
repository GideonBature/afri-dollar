import type { Request, Response, NextFunction } from 'express';

import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ERROR_CODES,
  errorMiddleware,
} from '../../middleware/error.middleware';

const mockRes = () => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const req = {} as Request;
const next = jest.fn() as NextFunction;

describe('Error Classes', () => {
  it('AppError sets statusCode, code, isOperational', () => {
    const err = new AppError('test', 400, 'AUTH_001');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('AUTH_001');
    expect(err.isOperational).toBe(true);
    expect(err.message).toBe('test');
    expect(err instanceof Error).toBe(true);
  });

  it('AuthenticationError defaults to 401', () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err instanceof AppError).toBe(true);
  });

  it('AuthorizationError defaults to 403', () => {
    expect(new AuthorizationError().statusCode).toBe(403);
  });

  it('NotFoundError defaults to 404', () => {
    expect(new NotFoundError().statusCode).toBe(404);
  });

  it('ValidationError defaults to 422', () => {
    expect(new ValidationError().statusCode).toBe(422);
  });
});

describe('ERROR_CODES', () => {
  it('contains all required codes', () => {
    const required = [
      'AUTH_001', 'AUTH_002', 'AUTH_003',
      'WALLET_001', 'WALLET_002',
      'TXN_001', 'TXN_002',
      'FX_001', 'COMPLIANCE_001', 'SERVER_001',
    ];
    for (const code of required) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });
});

describe('errorMiddleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles AppError with correct status and format', () => {
    const res = mockRes();
    const err = new AppError('Wallet not found', 404, 'WALLET_001');
    errorMiddleware(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'WALLET_001', message: 'Wallet not found' },
    });
  });

  it('handles AuthenticationError', () => {
    const res = mockRes();
    errorMiddleware(new AuthenticationError('Invalid credentials', 'AUTH_001'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it('handles AuthorizationError', () => {
    const res = mockRes();
    errorMiddleware(new AuthorizationError(), req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('handles NotFoundError', () => {
    const res = mockRes();
    errorMiddleware(new NotFoundError(), req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('handles ValidationError', () => {
    const res = mockRes();
    errorMiddleware(new ValidationError(), req, res, next);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('handles unexpected errors as 500 without exposing internals', () => {
    const res = mockRes();
    const err = new Error('Database exploded');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorMiddleware(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'SERVER_001', message: ERROR_CODES.SERVER_001 },
    });
    // Sensitive message not leaked
    const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(jsonCall)).not.toContain('Database exploded');

    consoleSpy.mockRestore();
  });

  it('response always has success: false', () => {
    const res = mockRes();
    errorMiddleware(new AppError('any', 400, 'AUTH_001'), req, res, next);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
  });
});
