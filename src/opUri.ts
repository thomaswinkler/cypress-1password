import {
  OP_PROTOCOL_PREFIX,
  OP_PROTOCOL_LENGTH,
  MIN_PATH_PARTS,
  MAX_PATH_PARTS,
} from './constants';

import debug from 'debug';
const log = debug('cyop:uri');

/**
 * Represents the parsed components of an op:// URI.
 */
export interface OpUri {
  /** The vault name (optional) */
  vault?: string;
  /** The item name (optional) */
  item?: string;
  /** The field name (optional) */
  field?: string;
  /** The target URL from query parameters (optional) */
  url?: string;
}

/**
 * Parses an op:// URI into its component parts.
 * Supports various formats: op://vault/item/field, op://vault/item, op://item/field, op://field
 * Also supports query parameters like ?target_url=encoded_url
 *
 * @param opUri - The op:// URI to parse
 * @param isSession - Whether this is a session URI (op://vault/item format)
 * @returns Object with parsed components or null if invalid
 */
export function parseOpUri(opUri: string, isSession: boolean): OpUri | null {
  if (!opUri || !opUri.startsWith(OP_PROTOCOL_PREFIX)) {
    log(
      `Invalid op:// URI format: "${opUri}". Must start with ${OP_PROTOCOL_PREFIX}`
    );
    return null;
  }

  const pathContent = opUri.substring(OP_PROTOCOL_LENGTH);
  if (!pathContent) {
    log(`Invalid op:// URI: "${opUri}". Empty after ${OP_PROTOCOL_PREFIX}`);
    return null;
  }

  // Separate path from query parameters
  const [pathOnly, queryString] = pathContent.split('?', 2);

  let pathParts: (string | undefined)[] = pathOnly.split('/');
  const isValid =
    pathParts.length >= MIN_PATH_PARTS &&
    pathParts.length <= MAX_PATH_PARTS &&
    pathParts.every((p) => (p?.trim()?.length ?? 0) > 0);

  if (!isValid) {
    log(
      `Invalid op:// URI format: "${opUri}". Path parts: [${pathParts.join(', ')}]`
    );
    return null;
  }

  // Handle different path lengths based on whether it's a session URI
  if (pathParts.length === 1) {
    pathParts = [undefined, undefined, pathParts[0]]; // Handle single field case (op://field)
  } else if (pathParts.length === 2 && !isSession) {
    pathParts = [undefined, pathParts[0], pathParts[1]]; // Handle item/field case (op://item/field)
  } else if (pathParts.length === 2 && isSession) {
    pathParts = [pathParts[0], pathParts[1], undefined]; // Handle session URI case (op://vault/item)
  }

  const [vault, item, field] = pathParts;

  // Parse query parameters
  let url: string | undefined;
  if (queryString) {
    const params = new URLSearchParams(queryString);
    const targetUrl = params.get('target_url');
    if (targetUrl) {
      try {
        // URL decode the target_url parameter
        const decodedUrl = decodeURIComponent(targetUrl);

        // Make it absolute if it doesn't have a scheme
        if (decodedUrl && !decodedUrl.includes('://')) {
          url = `https://${decodedUrl}`;
        } else {
          url = decodedUrl;
        }
      } catch (error) {
        log(
          `Failed to decode target_url parameter: "${targetUrl}". Error: ${error}`
        );
      }
    }
  }

  return {
    ...(vault && { vault: vault.trim() }),
    ...(item && { item: item.trim() }),
    ...(field && { field: field.trim() }),
    ...(url && { url }),
  };
}

// Export constants for use by other modules
export { OP_PROTOCOL_PREFIX, OP_PROTOCOL_LENGTH };
