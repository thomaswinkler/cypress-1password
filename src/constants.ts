// Protocol and URI constants
export const OP_PROTOCOL_PREFIX = 'op://';
export const OP_PROTOCOL_LENGTH = OP_PROTOCOL_PREFIX.length;
export const MIN_PATH_PARTS = 1;
export const MAX_PATH_PARTS = 3;

// Field and section separators
export const SECTION_FIELD_SEPARATOR = '.';

// Error handling constants
export const ERROR_PREFIX = '[cypress-1password]';
export const DEFAULT_FAIL_ON_ERROR = true;

// Special field handling
export const SPECIAL_URL_FIELDS = ['url', 'website'];

// Pre-compiled regex for better performance
export const placeholderRegex = new RegExp(
  `{{\\s{0,20}(${OP_PROTOCOL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]+?)\\s{0,20}}}`,
  'g'
);
