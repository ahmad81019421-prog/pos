/**
 * Input validation shared between main and renderer.
 * PRD section 78: All user input must be validated.
 */

import type {
  Currency,
  Language,
  SellingUnit,
} from '@shared/types/index';

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function requireNonEmptyString(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required`, fieldName);
  }
  return value.trim();
}

export function requirePositiveInteger(
  value: unknown,
  fieldName: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(
      `${fieldName} must be a positive integer`,
      fieldName,
    );
  }
  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  fieldName: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${fieldName} must be a non-negative integer`,
      fieldName,
    );
  }
  return value;
}

export function requirePositiveMinorUnits(
  value: unknown,
  fieldName: string,
): number {
  // Allow 0 for some edge cases (e.g. direct final price might be exactly 0? unusual)
  // but reject negative or non-integer
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${fieldName} must be a non-negative integer (minor units)`,
      fieldName,
    );
  }
  return value;
}

export function requireCurrency(value: unknown): Currency {
  if (value !== 'USD' && value !== 'LBP') {
    throw new ValidationError(`Invalid currency: ${value}`);
  }
  return value;
}

export function requireLanguage(value: unknown): Language {
  if (value !== 'en' && value !== 'ar') {
    throw new ValidationError(`Invalid language: ${value}`);
  }
  return value;
}

export function requireSellingUnit(value: unknown): SellingUnit {
  if (value !== 'WEIGHT' && value !== 'PACKAGE' && value !== 'PIECE') {
    throw new ValidationError(`Invalid selling unit: ${value}`);
  }
  return value;
}

export function requireOptionalImage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('Image must be a string');
  }
  // Limit to 1MB to avoid DB bloat
  if (value.length > 1_500_000) {
    throw new ValidationError(
      'Image too large (max ~1MB). Please use a smaller image.',
    );
  }
  if (!value.startsWith('data:image/')) {
    throw new ValidationError('Image must be a data URL');
  }
  return value;
}

export function sanitizeText(value: unknown, maxLen = 500): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

/* ------------------------------------------------------------------ */
/* IPC-boundary helpers (the renderer is never trusted; PRD 53)       */
/* ------------------------------------------------------------------ */

export function requireObject(value: unknown, fieldName = 'Input'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} is invalid`, fieldName);
  }
  return value as Record<string, unknown>;
}

export function requireId(value: unknown, fieldName = 'Id'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${fieldName} is invalid`, fieldName);
  }
  return value;
}

export function optionalId(value: unknown, fieldName = 'Id'): number | undefined {
  return value === undefined || value === null ? undefined : requireId(value, fieldName);
}

export function optionalLimit(value: unknown, def: number, max = 1000): number {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('Limit is invalid');
  }
  return Math.min(value, max);
}

export function optionalBoolean(value: unknown): boolean {
  return value === true;
}

export function optionalString(value: unknown, maxLen = 500, fieldName = 'Text'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${fieldName} must be text`, fieldName);
  if (value.length > maxLen) throw new ValidationError(`${fieldName} is too long`, fieldName);
  return value;
}

export function requireSafeInt(value: unknown, fieldName: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new ValidationError(`${fieldName} is invalid`, fieldName);
  }
  return value;
}

export function requireDateRange(value: unknown): { from: number; to: number } {
  const o = requireObject(value, 'Date range');
  const from = requireSafeInt(o.from, 'From date');
  const to = requireSafeInt(o.to, 'To date');
  if (to < from) throw new ValidationError('The end date is before the start date');
  return { from, to };
}

export function optionalRange(value: unknown): { from?: number; to?: number } {
  if (value === undefined || value === null) return {};
  const o = requireObject(value, 'Options');
  return {
    from: o.from === undefined ? undefined : requireSafeInt(o.from, 'From date'),
    to: o.to === undefined ? undefined : requireSafeInt(o.to, 'To date'),
  };
}
