import { usageError } from './errors.js';

/**
 * Node names follow the contract: trimmed, 1–255 characters, no "/" or "\\"
 * because those are path separators in the Drive tree.
 */
export default function sanitizeName(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') throw usageError('Node names must not be empty.');
  if (value.length > 255) throw usageError('Node names must be at most 255 characters.');
  if (value.includes('/') || value.includes('\\')) {
    throw usageError('Node names must not contain "/" or "\\": "' + value + '".');
  }
  if (value === '.' || value === '..') throw usageError('"." and ".." are not valid node names.');
  return value;
}
