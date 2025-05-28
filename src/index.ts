import debug from 'debug';
import {
  item,
  validateCli,
  setConnect,
  setServiceAccount,
  Item as OpJsItem,
  ValueField as OpJsValueField, // Specific type for fields with a value
} from '@1password/op-js';

// Optional: Helper function to configure op-js authentication if needed.
// By default, op-js tries CLI (system auth) -> Connect env vars -> Service Account env var.
// This function could be called by the user in their cypress.config.js if they want to explicitly set auth.
// For this plugin, we'll rely on the default behavior or environment variables.
export function configureOpAuth(authConfig: {
  connectHost?: string;
  connectToken?: string;
  serviceAccountToken?: string;
}) {
  const log = debug('cyop:configure');
  if (authConfig.connectHost && authConfig.connectToken) {
    setConnect(authConfig.connectHost, authConfig.connectToken);
    log('Configured to use 1Password Connect.');
  } else if (authConfig.serviceAccountToken) {
    setServiceAccount(authConfig.serviceAccountToken);
    log('Configured to use 1Password Service Account.');
  }
}

// Performance and validation constants
const OP_PROTOCOL_PREFIX = 'op://';
const OP_PROTOCOL_LENGTH = OP_PROTOCOL_PREFIX.length;
const MIN_PATH_PARTS = 1;
const MAX_PATH_PARTS = 3;
const SECTION_FIELD_SEPARATOR = '.';
const ERROR_PREFIX = '[cypress-1password]';
const DEFAULT_FAIL_ON_ERROR = true;
const SPECIAL_URL_FIELDS = ['url', 'website'];

// Pre-compiled regex for better performance
const placeholderRegex = new RegExp(
  `{{\\s{0,20}(${OP_PROTOCOL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]+?)\\s{0,20}}}`,
  'g'
); // Updated to allow spaces in ${OP_PROTOCOL_PREFIX} paths while preventing ReDoS

// Type definitions and interfaces
export interface CyOpPluginOptions {
  /**
   * If true, the plugin will throw an error if a secret cannot be resolved.
   * If false, it will log a warning and continue, leaving the environment variable unchanged or the placeholder unreplaced.
   * @default true
   */
  failOnError?: boolean;
}

interface CyOpResolvedSecretIdentifier {
  vaultNames: string[]; // Changed from vaultName to support multiple vaults
  itemName: string;
  fieldSpecifier: string;
  originalPath: string;
}

// Define types for cached items
type CyOpCachedItemEntry =
  | OpJsItem
  | {
      error: any;
      vaultName: string;
      itemName: string;
      originalPath: string;
    };

// Utility functions
function isErrorEntry(entry: CyOpCachedItemEntry): entry is {
  error: any;
  vaultName: string;
  itemName: string;
  originalPath: string;
} {
  return (entry as any).error !== undefined;
}

/**
 * Parses vault environment variable which can be:
 * - A string with comma-separated vault names/IDs
 * - An array of vault names/IDs (when passed from Cypress env)
 *
 * @param vaultEnv - The vault environment variable value
 * @returns Array of vault names/IDs in the order they should be tried
 */
function parseVaultEnvironment(
  vaultEnv: string | string[] | undefined
): string[] {
  if (!vaultEnv) {
    return [];
  }

  if (Array.isArray(vaultEnv)) {
    return vaultEnv
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
  }

  if (typeof vaultEnv === 'string') {
    return vaultEnv
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  return [];
}

/**
 * Resolves a 1Password secret path into its component parts (vault, item, field).
 * Supports full paths (op://vault/item/field) and partial paths using CYOP_VAULT and CYOP_ITEM.
 * CYOP_VAULT can be a comma-separated list or array of vault names/IDs to check in order.
 *
 * @param originalOpPath - The original op:// path to resolve
 * @param log - Debug logger instance
 * @param cypressEnv - Cypress environment variables (optional)
 * @returns Resolved secret identifier or null if path is invalid
 */
function resolveSecretPath(
  originalOpPath: string,
  log: debug.Debugger,
  cypressEnv?: Record<string, any>
): CyOpResolvedSecretIdentifier | null {
  const vaultFromCypressEnv = cypressEnv?.CYOP_VAULT;
  const itemFromCypressEnv = cypressEnv?.CYOP_ITEM;

  const vaultEnv =
    vaultFromCypressEnv !== undefined
      ? vaultFromCypressEnv
      : process.env.CYOP_VAULT;
  const itemEnv =
    typeof itemFromCypressEnv === 'string'
      ? itemFromCypressEnv
      : process.env.CYOP_ITEM;

  log(
    `Resolving op path: "${originalOpPath}" (CYOP_VAULT: "${JSON.stringify(vaultEnv)}", CYOP_ITEM: "${itemEnv}")`
  );

  if (!originalOpPath || !originalOpPath.startsWith(OP_PROTOCOL_PREFIX)) {
    console.warn(
      `${ERROR_PREFIX} Invalid path: "${originalOpPath}". Must be an ${OP_PROTOCOL_PREFIX} URI.`
    );
    return null;
  }

  const pathContent = originalOpPath.substring(OP_PROTOCOL_LENGTH);
  if (!pathContent) {
    console.warn(
      `${ERROR_PREFIX} Invalid path: "${originalOpPath}". Empty after "${OP_PROTOCOL_PREFIX}".`
    );
    return null;
  }
  const pathParts = pathContent.split('/');

  let vaultNames: string[] = [];
  let itemName: string | undefined;
  let fieldSpecifier: string | undefined;

  if (
    pathParts.length === MAX_PATH_PARTS &&
    pathParts.every((p) => p.length > 0)
  ) {
    vaultNames = [pathParts[0]];
    itemName = pathParts[1];
    fieldSpecifier = pathParts[2];
    log(
      `Path "${originalOpPath}" -> Full path. Vault="${vaultNames[0]}", Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === 2 && pathParts.every((p) => p.length > 0)) {
    const parsedVaults = parseVaultEnvironment(vaultEnv);
    if (parsedVaults.length === 0) {
      console.warn(
        `${ERROR_PREFIX} CYOP_VAULT missing for partial path "${originalOpPath}" (${OP_PROTOCOL_PREFIX}item/field).`
      );
      return null;
    }
    vaultNames = parsedVaults;
    itemName = pathParts[0];
    fieldSpecifier = pathParts[1];
    log(
      `Path "${originalOpPath}" -> Partial path (item/field). Vaults="${vaultNames.join(', ')}" (from CYOP_VAULT), Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === MIN_PATH_PARTS && pathParts[0].length > 0) {
    const parsedVaults = parseVaultEnvironment(vaultEnv);
    if (parsedVaults.length === 0 || !itemEnv) {
      console.warn(
        `${ERROR_PREFIX} CYOP_VAULT and/or CYOP_ITEM missing for partial path "${originalOpPath}" (${OP_PROTOCOL_PREFIX}field).`
      );
      return null;
    }
    vaultNames = parsedVaults;
    itemName = itemEnv;
    fieldSpecifier = pathParts[0];
    log(
      `Path "${originalOpPath}" -> Partial path (field). Vaults="${vaultNames.join(', ')}" (from CYOP_VAULT), Item="${itemName}" (from CYOP_ITEM), Field="${fieldSpecifier}".`
    );
  } else {
    console.warn(
      `${ERROR_PREFIX} Path "${originalOpPath}" has unsupported segment structure: [${pathParts.join(
        ', '
      )}]`
    );
    return null;
  }

  if (vaultNames.length === 0 || !itemName || !fieldSpecifier) {
    // This case should ideally be caught by the specific checks above.
    console.warn(
      `${ERROR_PREFIX} Could not fully determine vault, item, and field for "${originalOpPath}".`
    );
    return null;
  }

  return {
    vaultNames,
    itemName,
    fieldSpecifier,
    originalPath: originalOpPath,
  };
}

/**
 * Retrieves and finds a secret value from 1Password using the resolved identifier.
 * Utilizes caching to avoid redundant API calls and handles both successful items and errors.
 * Tries multiple vaults in the order specified until the item is found.
 *
 * @param resolvedIdentifier - The resolved secret path components
 * @param log - Debug logger instance
 * @param itemCache - Cache array for storing fetched items and errors
 * @param pluginOptions - Plugin configuration options
 * @returns The secret value or undefined if not found/error occurred
 */
async function getAndFindSecretValue(
  resolvedIdentifier: CyOpResolvedSecretIdentifier,
  log: debug.Debugger,
  itemCache: CyOpCachedItemEntry[],
  pluginOptions?: CyOpPluginOptions
): Promise<string | undefined> {
  const failOnError = pluginOptions?.failOnError ?? DEFAULT_FAIL_ON_ERROR;
  const { vaultNames, itemName, fieldSpecifier, originalPath } =
    resolvedIdentifier;

  // 1. Check cache by iterating through cached items
  for (const cachedEntry of itemCache) {
    if (isErrorEntry(cachedEntry)) {
      // For error entries, we need to check if the current request would result in the same item.get call
      // The error was cached with the exact vaultName and itemName that were passed to item.get
      // So we need to check if the current request would resolve to the same parameters
      if (
        vaultNames.includes(cachedEntry.vaultName) &&
        cachedEntry.itemName === itemName
      ) {
        log(
          `Using cached error for item "${itemName}" (vault "${cachedEntry.vaultName}") for path "${originalPath}".`
        );
        const message = `Previously failed to fetch item "${itemName}" (vault "${cachedEntry.vaultName}") for path "${cachedEntry.originalPath}". Error: ${cachedEntry.error.message}`;
        if (failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
        console.warn(`${ERROR_PREFIX} ${message}`);
        return undefined;
      }
    } else {
      // It's an OpJsItem
      const cachedItem = cachedEntry;
      // Check if any of the vault names match the cached item's vault
      const vaultMatch = vaultNames.some(
        (vaultName) =>
          cachedItem.vault.id === vaultName ||
          cachedItem.vault.name?.toLowerCase() === vaultName.toLowerCase()
      );
      // Match item by ID or title (case-insensitive for title)
      const itemMatch =
        cachedItem.id === itemName ||
        cachedItem.title?.toLowerCase() === itemName.toLowerCase();

      if (vaultMatch && itemMatch) {
        log(
          `Using cached item "${cachedItem.title}" (ID: ${cachedItem.id}, vault "${cachedItem.vault.name}") for path "${originalPath}".`
        );
        const secretValue = findFieldValue(cachedItem, fieldSpecifier, log);
        if (secretValue !== null && secretValue !== undefined) {
          log(`Success: Found value for "${originalPath}" from cached item.`);
          return secretValue;
        } else {
          const message = `Field "${fieldSpecifier}" not found or value is null/undefined in cached item "${cachedItem.title}" (ID: ${cachedItem.id}, path "${originalPath}").`;
          if (failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
          console.warn(`${ERROR_PREFIX} ${message}`);
          return undefined;
        }
      }
    }
  }

  // 2. Try each vault in order until we find the item or exhaust all vaults
  const errors: Array<{ vaultName: string; error: any }> = [];

  for (const vaultName of vaultNames) {
    log(
      `Fetching item "${itemName}" (vault "${vaultName}") for path "${originalPath}" (not found in cache).`
    );

    try {
      const fetchedItemData: OpJsItem | OpJsValueField | OpJsValueField[] =
        await item.get(itemName, {
          vault: vaultName,
        });

      if (!('fields' in fetchedItemData) || Array.isArray(fetchedItemData)) {
        const message = `Data for item "${itemName}" (vault "${vaultName}", path "${originalPath}") not in expected OpJsItem format.`;
        const error = new Error(message);
        errors.push({ vaultName, error });
        // Cache the failure
        itemCache.push({
          error,
          vaultName,
          itemName,
          originalPath,
        });
        continue; // Try next vault
      }

      const fetchedItemDataAsItem = fetchedItemData as OpJsItem;
      log(
        `Successfully fetched item "${fetchedItemDataAsItem.title}" (ID: ${fetchedItemDataAsItem.id}, Vault: ${fetchedItemDataAsItem.vault.name}).`
      );

      // Cache the successfully fetched item
      itemCache.push(fetchedItemDataAsItem);

      const secretValue = findFieldValue(
        fetchedItemDataAsItem,
        fieldSpecifier,
        log
      );

      if (secretValue !== null && secretValue !== undefined) {
        log(`Success: Found value for "${originalPath}".`);
        return secretValue;
      } else {
        const message = `Field "${fieldSpecifier}" not found or value is null/undefined in item "${fetchedItemDataAsItem.title}" (ID: ${fetchedItemDataAsItem.id}, path "${originalPath}").`;
        if (failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
        console.warn(`${ERROR_PREFIX} ${message}`);
        return undefined;
      }
    } catch (error: any) {
      log(
        `Failed to fetch item "${itemName}" (vault "${vaultName}") for path "${originalPath}". Error: ${error.message}`
      );
      errors.push({ vaultName, error });

      // Cache the failure
      itemCache.push({
        error,
        vaultName,
        itemName,
        originalPath,
      });

      // Continue to try next vault unless this is the last one
      if (vaultName === vaultNames[vaultNames.length - 1]) {
        // This was the last vault, handle the error
        let errorMessage = error.message;
        // Check if it's an error from op-js which might have stderr
        if (error.stderr) errorMessage += `\nStderr: ${error.stderr}`;

        // If the error message is already prefixed (e.g., from a previous throw in this function or findFieldValue),
        // and failOnError is true, rethrow it. If failOnError is false, log it (it's already prefixed).
        if (error.message && error.message.startsWith(ERROR_PREFIX)) {
          if (failOnError) throw error; // Rethrow the already formatted error
          console.warn(error.message); // Log the already formatted warning
          return undefined;
        }

        // For other errors (e.g., network issues, op-js internal errors not caught above)
        let fullErrorMessage: string;
        if (vaultNames.length === 1) {
          // Single vault - use original error format for backward compatibility
          fullErrorMessage = `Failed to load secret for path "${originalPath}" (Item: "${itemName}", Vault: "${vaultNames[0]}"): ${errorMessage}`;
        } else {
          // Multiple vaults - use new format
          const vaultsList = vaultNames.join(', ');
          fullErrorMessage = `Failed to load secret for path "${originalPath}" (Item: "${itemName}") after trying all vaults [${vaultsList}]. Last error: ${errorMessage}`;
        }
        if (failOnError) throw new Error(`${ERROR_PREFIX} ${fullErrorMessage}`);
        console.error(`${ERROR_PREFIX} ${fullErrorMessage}`); // Use console.error for unexpected errors
        return undefined;
      }
    }
  }

  // If we get here, no vault had the item (shouldn't happen due to the logic above, but safety net)
  const vaultsList = vaultNames.join(', ');
  const message = `Item "${itemName}" not found in any of the specified vaults [${vaultsList}] for path "${originalPath}".`;
  if (failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
  console.warn(`${ERROR_PREFIX} ${message}`);
  return undefined;
}

/**
 * Optimized helper to find a specific field value from a 1Password item.
 * Supports direct field matching, section.field format, and special URL fields.
 * Uses pre-computed lookup maps for improved performance.
 *
 * @param itemObject - The 1Password item to search in
 * @param fieldSpecifier - The field name/ID or section.field specifier
 * @param log - Debug logger instance
 * @returns The field value or undefined if not found
 */
function findFieldValue(
  itemObject: OpJsItem, // Expect OpJsItem directly
  fieldSpecifier: string,
  log: debug.Debugger // Added for logging
): string | undefined {
  const fieldSpecifierLower = fieldSpecifier.toLowerCase();
  if (
    !SPECIAL_URL_FIELDS.includes(fieldSpecifier) &&
    (!itemObject.fields || itemObject.fields.length === 0)
  ) {
    log(`Item "${itemObject.title}" (ID: ${itemObject.id}) has no fields.`);
    return undefined;
  }

  const fields = itemObject.fields ?? [];

  log(
    `Searching for field "${fieldSpecifier}" in item "${itemObject.title}" (ID: ${itemObject.id}).`
  );

  // Performance optimization: Pre-compute field lookups for faster access
  // Create lookup maps for label and ID based searches
  const fieldByLabel = new Map<string, OpJsValueField>();
  const fieldById = new Map<string, OpJsValueField>();
  const fieldBySectionAndLabel = new Map<string, OpJsValueField>();
  const fieldBySectionAndId = new Map<string, OpJsValueField>();

  for (const field of fields) {
    const fieldAsValueField = field as OpJsValueField;
    const currentFieldLabel = field.label?.toLowerCase();
    const currentFieldId = field.id?.toLowerCase();
    const currentFieldSectionLabel = field.section?.label?.toLowerCase();
    const currentFieldSectionId = field.section?.id?.toLowerCase();

    if (currentFieldLabel) {
      fieldByLabel.set(currentFieldLabel, fieldAsValueField);
    }
    if (currentFieldId) {
      fieldById.set(currentFieldId, fieldAsValueField);
    }

    // Create section.field lookup keys
    if (currentFieldSectionLabel && currentFieldLabel) {
      fieldBySectionAndLabel.set(
        `${currentFieldSectionLabel}${SECTION_FIELD_SEPARATOR}${currentFieldLabel}`,
        fieldAsValueField
      );
    }
    if (currentFieldSectionId && currentFieldLabel) {
      fieldBySectionAndLabel.set(
        `${currentFieldSectionId}${SECTION_FIELD_SEPARATOR}${currentFieldLabel}`,
        fieldAsValueField
      );
    }
    if (currentFieldSectionLabel && currentFieldId) {
      fieldBySectionAndId.set(
        `${currentFieldSectionLabel}${SECTION_FIELD_SEPARATOR}${currentFieldId}`,
        fieldAsValueField
      );
    }
    if (currentFieldSectionId && currentFieldId) {
      fieldBySectionAndId.set(
        `${currentFieldSectionId}${SECTION_FIELD_SEPARATOR}${currentFieldId}`,
        fieldAsValueField
      );
    }
  }

  // Attempt 1: Direct match using lookup maps
  let matchedField =
    fieldByLabel.get(fieldSpecifierLower) || fieldById.get(fieldSpecifierLower);
  if (matchedField) {
    log(
      `Direct match for "${fieldSpecifier}" found. Value ${
        typeof matchedField.value !== 'undefined' ? 'found' : 'absent'
      }.`
    );
    return matchedField.value;
  }
  log(`No direct match for "${fieldSpecifier}".`);

  // Attempt 2: Section.Field match using pre-computed lookup
  const parts = fieldSpecifier.split(SECTION_FIELD_SEPARATOR);
  if (parts.length > 1) {
    const targetFieldName = parts.pop()?.toLowerCase();
    const targetSectionName = parts.join(SECTION_FIELD_SEPARATOR).toLowerCase();

    if (targetFieldName && targetSectionName && targetSectionName.length > 0) {
      log(
        `Attempting section.field match: Section="${targetSectionName}", Field="${targetFieldName}".`
      );

      const sectionFieldKey = `${targetSectionName}${SECTION_FIELD_SEPARATOR}${targetFieldName}`;
      matchedField =
        fieldBySectionAndLabel.get(sectionFieldKey) ||
        fieldBySectionAndId.get(sectionFieldKey);

      if (matchedField) {
        log(
          `Section.field match for "${fieldSpecifier}" found. Value ${
            typeof matchedField.value !== 'undefined' ? 'found' : 'absent'
          }.`
        );
        return matchedField.value;
      }

      log(
        `No section.field match for Section="${targetSectionName}", Field="${targetFieldName}".`
      );
    } else {
      log(
        `Skipped section.field match for "${fieldSpecifier}"; invalid section/field parts after split.`
      );
    }
  } else {
    log(`Skipped section.field match for "${fieldSpecifier}"; no '.' found.`);
  }

  // Attempt 3: Special handling for 'url' or 'website'
  if (SPECIAL_URL_FIELDS.includes(fieldSpecifierLower)) {
    log(`Attempting URL/website match for "${fieldSpecifierLower}".`);
    if (
      itemObject.urls &&
      Array.isArray(itemObject.urls) &&
      itemObject.urls.length > 0
    ) {
      const primaryUrl = itemObject.urls.find((u) => u.primary === true);
      if (primaryUrl && primaryUrl.href) {
        log(`Found primary URL: ${primaryUrl.href}`);
        return primaryUrl.href;
      }
      if (itemObject.urls[0] && itemObject.urls[0].href) {
        log(`Found first URL: ${itemObject.urls[0].href}`);
        return itemObject.urls[0].href;
      }
      log(`No usable href in item.urls for "${fieldSpecifierLower}".`);
    } else {
      log(`No item.urls for "${fieldSpecifierLower}".`);
    }
  }

  log(
    `Field "${fieldSpecifier}" not found in item "${itemObject.title}" (ID: ${itemObject.id}) after all attempts.`
  );
  return undefined;
}

/**
 * Replaces 1Password placeholders ({{op://...}}) in a string with resolved secret values.
 * Uses local caching to avoid duplicate API calls for identical paths within the same string.
 *
 * @param originalString - The string containing placeholders to replace
 * @param cypressEnv - Cypress environment variables (optional)
 * @param itemCache - Cache array for storing fetched items and errors
 * @param pluginOptions - Plugin configuration options
 * @returns String with placeholders replaced by secret values
 */
async function replacePlaceholders(
  originalString: string,
  cypressEnv: Record<string, any> | undefined, // Made cypressEnv explicitly potentially undefined
  itemCache: CyOpCachedItemEntry[], // Added itemCache parameter
  pluginOptions?: CyOpPluginOptions
): Promise<string> {
  const log = debug('cyop:replace');
  let resultString = originalString;
  let match;
  const failOnError = pluginOptions?.failOnError ?? DEFAULT_FAIL_ON_ERROR; // For top-level issues in this function

  // Use a Map to avoid re-fetching the same secret multiple times if it appears in multiple placeholders
  const resolvedSecretsCache = new Map<string, string | undefined>();

  // Create a list of all replacements to be made
  const replacements = [];
  placeholderRegex.lastIndex = 0;
  while ((match = placeholderRegex.exec(originalString)) !== null) {
    replacements.push({
      placeholder: match[0],
      opPath: match[1],
    });
  }

  if (replacements.length > 0) {
    log(
      `Found ${
        replacements.length
      } placeholder(s) in string: "${originalString.substring(0, 50)}..."`
    );
  }

  for (const { placeholder, opPath } of replacements) {
    let secretValue: string | undefined;

    if (resolvedSecretsCache.has(opPath)) {
      secretValue = resolvedSecretsCache.get(opPath);
      log(
        `Using cached value for "${opPath}" in placeholder "${placeholder}".`
      );
    } else {
      const resolvedIdentifier = resolveSecretPath(opPath, log, cypressEnv);
      if (!resolvedIdentifier) {
        // resolveSecretPath already logs a console.warn
        // If failOnError is true, we should throw here as the path itself is invalid.
        if (failOnError) {
          throw new Error(
            `${ERROR_PREFIX} Cannot resolve path for placeholder "${placeholder}" (path: "${opPath}").`
          );
        }
        // If not failing on error, we cache 'undefined' to avoid re-processing, and skip replacement.
        resolvedSecretsCache.set(opPath, undefined);
        continue;
      }

      // getAndFindSecretValue handles its own logging and failOnError for fetching/finding issues
      secretValue = await getAndFindSecretValue(
        resolvedIdentifier,
        log,
        itemCache, // Pass itemCache
        pluginOptions
      );
      resolvedSecretsCache.set(opPath, secretValue); // Cache result, even if undefined
    }

    if (secretValue !== null && secretValue !== undefined) {
      resultString = resultString.replace(placeholder, secretValue);
      log(`Replaced placeholder "${placeholder}" with resolved secret.`);
    } else {
      // If secretValue is undefined here, it means either:
      // 1. getAndFindSecretValue returned undefined (and failOnError was false, so it logged a warning)
      // 2. resolvedIdentifier was null (and failOnError was false, so resolveSecretPath logged a warning)
      // In either case, if failOnError is false, we just log that the placeholder was not replaced.
      if (!failOnError) {
        log(
          `Placeholder "${placeholder}" (path "${opPath}") could not be resolved to a value. Placeholder not replaced.`
        );
      }
      // If failOnError is true, an error would have been thrown by getAndFindSecretValue or by the resolveSecretPath check above.
    }
  }
  return resultString;
}

/**
 * Main function to load 1Password secrets into Cypress environment variables.
 * Processes both direct op:// paths and placeholder strings containing {{op://...}}.
 * Implements comprehensive caching to optimize performance for repeated secret access.
 *
 * @param config - Cypress plugin configuration options
 * @param pluginOptions - Plugin-specific configuration options
 * @returns Updated Cypress configuration with resolved secrets
 */
export async function loadOpSecrets(
  config: Cypress.PluginConfigOptions,
  pluginOptions?: CyOpPluginOptions
): Promise<Cypress.PluginConfigOptions> {
  const log = debug('cyop:load');
  const itemCache: CyOpCachedItemEntry[] = []; // Initialize item cache as an array

  if (!config || typeof config !== 'object') {
    return config; // No config to process
  }
  const updatedConfig = { ...config };
  if (!updatedConfig.env) {
    return config; // No env vars to process
  }
  const failOnError = pluginOptions?.failOnError ?? DEFAULT_FAIL_ON_ERROR; // For top-level issues in this function

  try {
    await validateCli();
    log('1Password CLI validated.');
  } catch (error: any) {
    console.error(
      `${ERROR_PREFIX} 1Password CLI validation failed. Plugin will not load secrets. Error: ${error.message}`
    );
    return config; // Critical setup error, return original config
  }

  log('Processing Cypress environment variables for 1Password secrets...');

  for (const envVarName in updatedConfig.env) {
    if (Object.prototype.hasOwnProperty.call(updatedConfig.env, envVarName)) {
      let originalValue = updatedConfig.env[envVarName];

      if (typeof originalValue === 'string') {
        originalValue = originalValue.trim();
        if (originalValue.startsWith(OP_PROTOCOL_PREFIX)) {
          const opPath = originalValue;
          log(
            `Processing direct ${OP_PROTOCOL_PREFIX} path for env var "${envVarName}": "${opPath}"`
          );

          const resolvedIdentifier = resolveSecretPath(
            opPath,
            log,
            updatedConfig.env
          );
          if (!resolvedIdentifier) {
            // resolveSecretPath already logs a console.warn
            // If failOnError is true, we should throw here as the path itself is invalid.
            if (failOnError) {
              throw new Error(
                `${ERROR_PREFIX} Cannot resolve path for env var "${envVarName}" (path: "${opPath}").`
              );
            }
            continue; // Skip this env var if path resolution failed and not throwing
          }

          // getAndFindSecretValue handles its own logging and failOnError for fetching/finding issues
          const secretValue = await getAndFindSecretValue(
            resolvedIdentifier,
            log,
            itemCache, // Pass itemCache
            pluginOptions
          );

          if (secretValue !== null && secretValue !== undefined) {
            updatedConfig.env[envVarName] = secretValue;
            log(
              `Env var "${envVarName}" updated with secret from "${opPath}".`
            );
          } else {
            // If secretValue is undefined here, it means getAndFindSecretValue returned undefined
            // (and failOnError was false, so it logged a warning).
            // If failOnError is false, we log that the env var was not updated.
            if (!failOnError) {
              log(
                `Env var "${envVarName}" (path "${opPath}") could not be resolved to a value. Variable not updated.`
              );
            }
            // If failOnError is true, an error would have been thrown by getAndFindSecretValue.
          }
        } else if (placeholderRegex.exec(originalValue) !== null) {
          log(
            `Processing string with placeholders for env var "${envVarName}".`
          );
          // replacePlaceholders calls getAndFindSecretValue internally and handles its own logging/failOnError per placeholder.
          // If replacePlaceholders encounters an issue and failOnError is true, it will throw.
          try {
            updatedConfig.env[envVarName] = await replacePlaceholders(
              originalValue,
              updatedConfig.env,
              itemCache, // Pass itemCache
              pluginOptions
            );
            log(
              `Env var "${envVarName}" updated after placeholder replacement.`
            );
          } catch (error: any) {
            // If replacePlaceholders throws (because failOnError is true for an issue within it),
            // we need to decide if loadOpSecrets itself should continue or rethrow.
            // For now, if failOnError is true at this level, we rethrow.
            if (failOnError) throw error;
            // If failOnError is false at this level, the error from replacePlaceholders (if it threw)
            // would have been caught if its internal failOnError was also true. If its internal was false,
            // it would have logged. So, if we reach here and failOnError is false, we just log the problem.
            console.warn(
              `${ERROR_PREFIX} Error processing placeholders for env var "${envVarName}": ${error.message}. Variable may be partially updated or unchanged.`
            );
          }
        }
      }
    }
  }
  log('Finished processing Cypress environment variables.');
  return updatedConfig;
}

export default async (
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  pluginOptions?: CyOpPluginOptions // Added pluginOptions
): Promise<Cypress.PluginConfigOptions> => {
  const log = debug('cyop:core');
  log(
    'Initializing to load secrets from environment variables. ' +
      `It will look for values starting with '${OP_PROTOCOL_PREFIX}' or containing '{{${OP_PROTOCOL_PREFIX}...}}' placeholders.`
  );

  // The op-js library handles the authentication flow automatically.
  return loadOpSecrets(config, pluginOptions); // Pass pluginOptions
};
