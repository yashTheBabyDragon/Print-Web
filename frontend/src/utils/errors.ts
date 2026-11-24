import { ApiError } from '../api/client';
import type { Translations } from '../i18n/fr';

export function translateApiError(err: unknown, t: Translations): string {
  if (err instanceof ApiError) {
    if (err.code === 'ACCOUNT_PENDING_APPROVAL') {
      return err.message && err.message !== 'ACCOUNT_PENDING_APPROVAL'
        ? err.message
        : t.errors.ACCOUNT_PENDING_APPROVAL;
    }
    if (err.code && err.code in t.errors) {
      return t.errors[err.code as keyof Translations['errors']];
    }
    const upper = err.message.toUpperCase();
    if (upper.includes('ACCOUNT_PENDING_APPROVAL')) {
      return err.message && err.message !== 'ACCOUNT_PENDING_APPROVAL'
        ? err.message
        : t.errors.ACCOUNT_PENDING_APPROVAL;
    }
    if (upper.includes('ACCOUNT_REJECTED')) return t.errors.ACCOUNT_REJECTED;
    if (upper.includes('TEACHER_REQUIRED')) return t.errors.TEACHER_REQUIRED;
    if (upper.includes('TEACHER_NOT_FOUND')) return t.errors.TEACHER_NOT_FOUND;
    if (upper.includes('INVALID_TEACHER_SELECTION')) return t.errors.INVALID_TEACHER_SELECTION;
    if (upper.includes('SUPER_ADMIN_REQUIRED')) return t.errors.SUPER_ADMIN_REQUIRED;
    if (upper.includes('CLASS_NOT_FOUND')) return t.errors.CLASS_NOT_FOUND;
    if (upper.includes('DA_NOT_WHITELISTED')) return t.errors.DA_NOT_WHITELISTED;
    if (upper.includes('DA_ALREADY_REGISTERED')) return t.errors.DA_ALREADY_REGISTERED;
    if (upper.includes('OUT_OF_BOUNDS')) return t.errors.OUT_OF_BOUNDS;
    if (upper.includes('LIMIT_EXCEEDED')) return t.errors.LIMIT_EXCEEDED;
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return t.errors.networkError;
}
