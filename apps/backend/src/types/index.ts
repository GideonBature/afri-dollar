/**
 * Type Definitions
 * Contains shared TypeScript types for the backend
 */
import type { User } from '@prisma/client';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type RegisterRequest = {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type RefreshTokenRequest = {
  refreshToken: string;
};

export type AuthResponse = {
  success: boolean;
  data: {
    user: Omit<User, 'passwordHash'>;
    tokens: AuthTokens;
  };
};

export type TokenRefreshResponse = {
  success: boolean;
  data: {
    accessToken: string;
    refreshToken: string;
  };
};

export type UserResponse = {
  success: boolean;
  data: Omit<User, 'passwordHash'>;
};

export type JwtPayload = {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
};
