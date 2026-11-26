import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { en } from '../../i18n/en';
import { fr } from '../../i18n/fr';
import { translateApiError } from '../errors';

describe('translateApiError', () => {
  it('translates known API error codes in EN and FR', () => {
    const err = new ApiError('FilamentAPI disabled', 400, 'FILAMENT_API_DISABLED');
    expect(translateApiError(err, en)).toBe(en.errors.FILAMENT_API_DISABLED);
    expect(translateApiError(err, fr)).toBe(fr.errors.FILAMENT_API_DISABLED);
  });

  it('translates OUT_OF_BOUNDS and LIMIT_EXCEEDED by code or message', () => {
    expect(translateApiError(new ApiError('raw', 400, 'OUT_OF_BOUNDS'), en)).toBe(
      en.errors.OUT_OF_BOUNDS
    );
    expect(translateApiError(new ApiError('LIMIT_EXCEEDED: too heavy', 409), fr)).toBe(
      fr.errors.LIMIT_EXCEEDED
    );
  });

  it('falls back to raw message for unknown ApiError and networkError for non-Error values', () => {
    expect(translateApiError(new ApiError('Custom backend error', 500), en)).toBe(
      'Custom backend error'
    );
    expect(translateApiError('unexpected', en)).toBe(en.errors.networkError);
  });
});
