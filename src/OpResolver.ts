import debug from 'debug';
import {
  item,
  validateCli,
  setConnect,
  setServiceAccount,
  Item as OpJsItem,
  ValueField as OpJsValueField,
} from '@1password/op-js';
import { parseOpUri, OP_PROTOCOL_PREFIX, type OpUri } from './opUri';
import {
  SECTION_FIELD_SEPARATOR,
  ERROR_PREFIX,
  DEFAULT_FAIL_ON_ERROR,
  SPECIAL_URL_FIELDS,
  placeholderRegex,
} from './constants';

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
  vaultNames: string[];
  itemName: string;
  fieldSpecifier: string;
  originalPath: string;
  url?: string;
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
 * 1Password Secret Resolver class that handles all secret resolution operations.
 * Uses instance variables to reduce parameter passing and improve maintainability.
 */
export class OpResolver {
  private itemCache: CyOpCachedItemEntry[] = [];
  private resolvedSecretsCache = new Map<string, string | undefined>();
  private log: debug.Debugger;
  private cypressEnv?: Record<string, any>;
  private pluginOptions?: CyOpPluginOptions;
  private failOnError: boolean;

  constructor(
    cypressEnv?: Record<string, any>,
    pluginOptions?: CyOpPluginOptions
  ) {
    this.log = debug('cyop:resolver');
    this.cypressEnv = cypressEnv;
    this.pluginOptions = pluginOptions;
    this.failOnError = pluginOptions?.failOnError ?? DEFAULT_FAIL_ON_ERROR;
  }

  /**
   * Parses vault environment variable which can be:
   * - A string with comma-separated vault names/IDs
   * - An array of vault names/IDs (when passed from Cypress env)
   */
  private parseVaultEnvironment(
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
   * Parses an op:// URI into its component parts.
   * Supports various formats: op://vault/item/field, op://vault/item, op://item/field, op://field
   * Also supports query parameters like ?target_url=encoded_url
   */
  private parseOpUri(opUri: string, isSession: boolean): OpUri | null {
    return parseOpUri(opUri, isSession);
  }

  /**
   * Resolves a 1Password secret path into its component parts (vault, item, field).
   * Supports full paths (op://vault/item/field) and partial paths using CYOP_VAULT and CYOP_ITEM.
   * Also supports session URIs from C8Y_SESSION or CYOP_SESSION (op://vault/item format).
   */
  private resolveSecretPath(
    originalOpPath: string
  ): CyOpResolvedSecretIdentifier | null {
    const vaultFromCypressEnv = this.cypressEnv?.CYOP_VAULT;
    const itemFromCypressEnv = this.cypressEnv?.CYOP_ITEM;
    const sessionFromCypressEnv =
      this.cypressEnv?.CYOP_SESSION || this.cypressEnv?.C8Y_SESSION;

    let vaultEnv =
      vaultFromCypressEnv !== undefined
        ? vaultFromCypressEnv
        : process.env.CYOP_VAULT;
    let itemEnv =
      typeof itemFromCypressEnv === 'string'
        ? itemFromCypressEnv
        : process.env.CYOP_ITEM;
    const sessionEnv =
      typeof sessionFromCypressEnv === 'string'
        ? sessionFromCypressEnv
        : (process.env.CYOP_SESSION ?? process.env.C8Y_SESSION);

    let sessionUrl: string | undefined = undefined;
    let vaultSource = 'none';
    let itemSource = 'none';

    if (sessionEnv) {
      const sessionOpObject = this.parseOpUri(sessionEnv, true);
      if (sessionOpObject?.vault && sessionOpObject?.item) {
        // Session has both vault and item - use them with strict priority
        vaultEnv = sessionOpObject.vault;
        itemEnv = sessionOpObject.item;
        vaultSource = 'session';
        itemSource = 'session';
        this.log(`Using vault and item from session (strict priority)`);
      } else {
        // Session doesn't have both - use as fallback
        if (!itemEnv && sessionOpObject?.item) {
          itemEnv = sessionOpObject.item;
          itemSource = 'session';
        } else if (itemEnv) {
          itemSource = 'env';
        }
        if (!vaultEnv && sessionOpObject?.vault) {
          vaultEnv = sessionOpObject.vault;
          vaultSource = 'session';
        } else if (vaultEnv) {
          vaultSource = 'env';
        }
      }
      sessionUrl = sessionOpObject?.url;
    } else {
      // No session - check env vars
      if (vaultEnv) vaultSource = 'env';
      if (itemEnv) itemSource = 'env';
    }

    this.log(
      `Resolving "${originalOpPath}" (vault: ${vaultSource}, item: ${itemSource})`
    );

    if (!originalOpPath || !originalOpPath.startsWith(OP_PROTOCOL_PREFIX)) {
      console.warn(
        `${ERROR_PREFIX} Invalid path: "${originalOpPath}". Must be an ${OP_PROTOCOL_PREFIX} URI.`
      );
      return null;
    }

    const opUri = this.parseOpUri(originalOpPath, false);
    if (!opUri) {
      console.warn(`${ERROR_PREFIX} Invalid path: "${originalOpPath}".`);
      return null;
    }

    const vaultNames: string[] | undefined = opUri?.vault
      ? [opUri.vault]
      : this.parseVaultEnvironment(vaultEnv);
    if (!vaultNames || vaultNames.length === 0) {
      console.warn(
        `${ERROR_PREFIX} CYOP_VAULT missing for partial path "${originalOpPath}" (${OP_PROTOCOL_PREFIX}item/field).`
      );
      return null;
    }
    const itemName = opUri?.item ?? itemEnv;
    const fieldSpecifier = opUri?.field;
    let url = sessionUrl; // Start with session URL
    if (opUri?.url) {
      url = opUri.url; // Override with URI URL if available
    }

    if (vaultNames.length === 0 || !itemName || !fieldSpecifier) {
      console.warn(
        `${ERROR_PREFIX} Could not determine vault, item and field for "${originalOpPath}".`
      );
      return null;
    }

    return {
      vaultNames,
      itemName,
      fieldSpecifier,
      originalPath: originalOpPath,
      url,
    };
  }

  /**
   * Optimized helper to find a specific field value from a 1Password item.
   * Supports direct field matching, section.field format, and special URL fields.
   */
  private findFieldValue(
    itemObject: OpJsItem,
    resolvedIdentifier: CyOpResolvedSecretIdentifier
  ): string | undefined {
    const { fieldSpecifier, url } = resolvedIdentifier;
    const fieldSpecifierLower = fieldSpecifier.toLowerCase();

    if (
      !SPECIAL_URL_FIELDS.includes(fieldSpecifier) &&
      (!itemObject.fields || itemObject.fields.length === 0)
    ) {
      this.log(
        `Item "${itemObject.title}" (ID: ${itemObject.id}) has no fields.`
      );
      return undefined;
    }

    const fields = itemObject.fields ?? [];

    this.log(
      `Searching for field "${fieldSpecifier}" in item "${itemObject.title}" (ID: ${itemObject.id}).`
    );

    // Performance optimization: Pre-compute field lookups for faster access
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

    // Special handling for URLs first - highest priority for session URL
    if (url && SPECIAL_URL_FIELDS.includes(fieldSpecifierLower)) {
      this.log(`Using target_url from session: ${url}`);
      return url;
    }

    // Attempt 1: Direct match using lookup maps
    let matchedField =
      fieldByLabel.get(fieldSpecifierLower) ||
      fieldById.get(fieldSpecifierLower);
    if (matchedField) {
      this.log(
        `Direct match for "${fieldSpecifier}" found. Value ${
          typeof matchedField.value !== 'undefined' ? 'found' : 'absent'
        }.`
      );
      return matchedField.value;
    }
    this.log(`No direct match for "${fieldSpecifier}".`);

    // Attempt 2: Section.Field match using pre-computed lookup
    const parts = fieldSpecifier.split(SECTION_FIELD_SEPARATOR);
    if (parts.length > 1) {
      const targetFieldName = parts.pop()?.toLowerCase();
      const targetSectionName = parts
        .join(SECTION_FIELD_SEPARATOR)
        .toLowerCase();

      if (
        targetFieldName &&
        targetSectionName &&
        targetSectionName.length > 0
      ) {
        this.log(
          `Attempting section.field match: Section="${targetSectionName}", Field="${targetFieldName}".`
        );

        const sectionFieldKey = `${targetSectionName}${SECTION_FIELD_SEPARATOR}${targetFieldName}`;
        matchedField =
          fieldBySectionAndLabel.get(sectionFieldKey) ||
          fieldBySectionAndId.get(sectionFieldKey);

        if (matchedField) {
          this.log(
            `Section.field match for "${fieldSpecifier}" found. Value ${
              typeof matchedField.value !== 'undefined' ? 'found' : 'absent'
            }.`
          );
          return matchedField.value;
        }

        this.log(
          `No section.field match for Section="${targetSectionName}", Field="${targetFieldName}".`
        );
      } else {
        this.log(
          `Skipped section.field match for "${fieldSpecifier}"; invalid section/field parts after split.`
        );
      }
    } else {
      this.log(
        `Skipped section.field match for "${fieldSpecifier}"; no '.' found.`
      );
    }

    // Attempt 3: Special handling for 'url' or 'website'
    if (SPECIAL_URL_FIELDS.includes(fieldSpecifierLower)) {
      this.log(`Attempting URL/website match for "${fieldSpecifierLower}".`);
      if (
        itemObject.urls &&
        Array.isArray(itemObject.urls) &&
        itemObject.urls.length > 0
      ) {
        const primaryUrl = itemObject.urls.find((u) => u.primary === true);
        if (primaryUrl && primaryUrl.href) {
          this.log(`Found primary URL: ${primaryUrl.href}`);
          return primaryUrl.href;
        }
        if (itemObject.urls[0] && itemObject.urls[0].href) {
          this.log(`Found first URL: ${itemObject.urls[0].href}`);
          return itemObject.urls[0].href;
        }
        this.log(`No usable href in item.urls for "${fieldSpecifierLower}".`);
      } else {
        this.log(`No item.urls for "${fieldSpecifierLower}".`);
      }
    }

    this.log(
      `Field "${fieldSpecifier}" not found in item "${itemObject.title}" (ID: ${itemObject.id}) after all attempts.`
    );
    return undefined;
  }

  /**
   * Retrieves and finds a secret value from 1Password using the resolved identifier.
   * Utilizes caching to avoid redundant API calls and handles both successful items and errors.
   */
  private async getAndFindSecretValue(
    resolvedIdentifier: CyOpResolvedSecretIdentifier
  ): Promise<string | undefined> {
    const { vaultNames, itemName, fieldSpecifier, originalPath } =
      resolvedIdentifier;

    // 1. Check cache by iterating through cached items
    for (const cachedEntry of this.itemCache) {
      if (isErrorEntry(cachedEntry)) {
        if (
          vaultNames.includes(cachedEntry.vaultName) &&
          cachedEntry.itemName === itemName
        ) {
          this.log(
            `Using cached error for item "${itemName}" (vault "${cachedEntry.vaultName}") for path "${originalPath}".`
          );
          const message = `Previously failed to fetch item "${itemName}" (vault "${cachedEntry.vaultName}") for path "${cachedEntry.originalPath}". Error: ${cachedEntry.error.message}`;
          if (this.failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
          console.warn(`${ERROR_PREFIX} ${message}`);
          return undefined;
        }
      } else {
        const cachedItem = cachedEntry;
        const vaultMatch = vaultNames.some(
          (vaultName) =>
            cachedItem.vault.id === vaultName ||
            cachedItem.vault.name?.toLowerCase() === vaultName.toLowerCase()
        );
        const itemMatch =
          cachedItem.id === itemName ||
          cachedItem.title?.toLowerCase() === itemName.toLowerCase();

        if (vaultMatch && itemMatch) {
          this.log(
            `Using cached item "${cachedItem.title}" (ID: ${cachedItem.id}, vault "${cachedItem.vault.name}") for path "${originalPath}".`
          );
          const secretValue = this.findFieldValue(
            cachedItem,
            resolvedIdentifier
          );
          if (secretValue !== null && secretValue !== undefined) {
            this.log(
              `Success: Found value for "${originalPath}" from cached item.`
            );
            return secretValue;
          } else {
            const message = `Field "${fieldSpecifier}" not found or value is null/undefined in cached item "${cachedItem.title}" (ID: ${cachedItem.id}, path "${originalPath}").`;
            if (this.failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
            console.warn(`${ERROR_PREFIX} ${message}`);
            return undefined;
          }
        }
      }
    }

    // 2. Try each vault in order until we find the item or exhaust all vaults
    const errors: Array<{ vaultName: string; error: any }> = [];

    for (const vaultName of vaultNames) {
      this.log(
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
          this.itemCache.push({
            error,
            vaultName,
            itemName,
            originalPath,
          });
          continue;
        }

        const fetchedItemDataAsItem = fetchedItemData as OpJsItem;
        this.log(
          `Successfully fetched item "${fetchedItemDataAsItem.title}" (ID: ${fetchedItemDataAsItem.id}, Vault: ${fetchedItemDataAsItem.vault.name}).`
        );

        this.itemCache.push(fetchedItemDataAsItem);

        const secretValue = this.findFieldValue(
          fetchedItemDataAsItem,
          resolvedIdentifier
        );

        if (secretValue !== null && secretValue !== undefined) {
          this.log(`Success: Found value for "${originalPath}".`);
          return secretValue;
        } else {
          const message = `Field "${fieldSpecifier}" not found or value is null/undefined in item "${fetchedItemDataAsItem.title}" (ID: ${fetchedItemDataAsItem.id}, path "${originalPath}").`;
          if (this.failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
          console.warn(`${ERROR_PREFIX} ${message}`);
          return undefined;
        }
      } catch (error: any) {
        this.log(
          `Failed to fetch item "${itemName}" (vault "${vaultName}") for path "${originalPath}". Error: ${error.message}`
        );
        errors.push({ vaultName, error });

        this.itemCache.push({
          error,
          vaultName,
          itemName,
          originalPath,
        });

        if (vaultName === vaultNames[vaultNames.length - 1]) {
          let errorMessage = error.message;
          if (error.stderr) errorMessage += `\nStderr: ${error.stderr}`;

          if (error.message && error.message.startsWith(ERROR_PREFIX)) {
            if (this.failOnError) throw error;
            console.warn(error.message);
            return undefined;
          }

          let fullErrorMessage: string;
          if (vaultNames.length === 1) {
            fullErrorMessage = `Failed to load secret for path "${originalPath}" (Item: "${itemName}", Vault: "${vaultNames[0]}"): ${errorMessage}`;
          } else {
            const vaultsList = vaultNames.join(', ');
            fullErrorMessage = `Failed to load secret for path "${originalPath}" (Item: "${itemName}") after trying all vaults [${vaultsList}]. Last error: ${errorMessage}`;
          }
          if (this.failOnError)
            throw new Error(`${ERROR_PREFIX} ${fullErrorMessage}`);
          console.error(`${ERROR_PREFIX} ${fullErrorMessage}`);
          return undefined;
        }
      }
    }

    const vaultsList = vaultNames.join(', ');
    const message = `Item "${itemName}" not found in any of the specified vaults [${vaultsList}] for path "${originalPath}".`;
    if (this.failOnError) throw new Error(`${ERROR_PREFIX} ${message}`);
    console.warn(`${ERROR_PREFIX} ${message}`);
    return undefined;
  }

  /**
   * Replaces 1Password placeholders ({{op://...}}) in a string with resolved secret values.
   */
  async replacePlaceholders(originalString: string): Promise<string> {
    let resultString = originalString;
    let match;

    const replacements = [];
    placeholderRegex.lastIndex = 0;
    while ((match = placeholderRegex.exec(originalString)) !== null) {
      replacements.push({
        placeholder: match[0],
        opPath: match[1],
      });
    }

    if (replacements.length > 0) {
      this.log(
        `Found ${
          replacements.length
        } placeholder(s) in string: "${originalString.substring(0, 50)}..."`
      );
    }

    for (const { placeholder, opPath } of replacements) {
      let secretValue: string | undefined;

      if (this.resolvedSecretsCache.has(opPath)) {
        secretValue = this.resolvedSecretsCache.get(opPath);
        this.log(
          `Using cached value for "${opPath}" in placeholder "${placeholder}".`
        );
      } else {
        const resolvedIdentifier = this.resolveSecretPath(opPath);
        if (!resolvedIdentifier) {
          if (this.failOnError) {
            throw new Error(
              `${ERROR_PREFIX} Cannot resolve path for placeholder "${placeholder}" (path: "${opPath}").`
            );
          }
          this.resolvedSecretsCache.set(opPath, undefined);
          continue;
        }

        secretValue = await this.getAndFindSecretValue(resolvedIdentifier);
        this.resolvedSecretsCache.set(opPath, secretValue);
      }

      if (secretValue !== null && secretValue !== undefined) {
        resultString = resultString.replace(placeholder, secretValue);
        this.log(`Replaced placeholder "${placeholder}" with resolved secret.`);
      } else {
        if (!this.failOnError) {
          this.log(
            `Placeholder "${placeholder}" (path "${opPath}") could not be resolved to a value. Placeholder not replaced.`
          );
        }
      }
    }
    return resultString;
  }

  /**
   * Resolves a single op:// path to its secret value.
   */
  async resolveOpPath(opPath: string): Promise<string | undefined> {
    const resolvedIdentifier = this.resolveSecretPath(opPath);
    if (!resolvedIdentifier) {
      if (this.failOnError) {
        throw new Error(`${ERROR_PREFIX} Cannot resolve path "${opPath}".`);
      }
      return undefined;
    }

    return await this.getAndFindSecretValue(resolvedIdentifier);
  }

  /**
   * Clears all caches for a fresh start.
   */
  clearCaches(): void {
    this.itemCache = [];
    this.resolvedSecretsCache.clear();
    this.log('Cleared all caches.');
  }

  /**
   * Main method to resolve 1Password secrets in Cypress environment variables.
   * This is the new public interface for the OpResolver class.
   */
  async resolve(
    config: Cypress.PluginConfigOptions,
    options?: CyOpPluginOptions
  ): Promise<Cypress.PluginConfigOptions> {
    const log = debug('cyop:resolve');

    if (!config || typeof config !== 'object') {
      return config;
    }
    const updatedConfig = { ...config };
    if (!updatedConfig.env) {
      return config;
    }

    const failOnError = options?.failOnError ?? DEFAULT_FAIL_ON_ERROR;

    try {
      await validateCli();
      log('1Password CLI validated.');
    } catch (error: any) {
      console.error(
        `${ERROR_PREFIX} 1Password CLI validation failed. Plugin will not load secrets. Error: ${error.message}`
      );
      return config;
    }

    log('Processing Cypress environment variables for 1Password secrets...');

    // Update the resolver's configuration with the provided options
    this.pluginOptions = options;
    this.failOnError = failOnError;
    this.cypressEnv = updatedConfig.env;

    for (const envVarName in updatedConfig.env) {
      if (Object.prototype.hasOwnProperty.call(updatedConfig.env, envVarName)) {
        // Skip session URIs - they are not secrets to resolve
        if (envVarName === 'C8Y_SESSION' || envVarName === 'CYOP_SESSION') {
          continue;
        }

        let originalValue = updatedConfig.env[envVarName];

        if (typeof originalValue === 'string') {
          originalValue = originalValue.trim();
          if (originalValue.startsWith(OP_PROTOCOL_PREFIX)) {
            const opPath = originalValue;
            log(
              `Processing direct ${OP_PROTOCOL_PREFIX} path for env var "${envVarName}": "${opPath}"`
            );

            try {
              const secretValue = await this.resolveOpPath(opPath);
              if (secretValue !== null && secretValue !== undefined) {
                updatedConfig.env[envVarName] = secretValue;
                log(
                  `Env var "${envVarName}" updated with secret from "${opPath}".`
                );
              } else {
                if (!failOnError) {
                  log(
                    `Env var "${envVarName}" (path "${opPath}") could not be resolved to a value. Variable not updated.`
                  );
                }
              }
            } catch (error: any) {
              if (failOnError) {
                // Wrap the error with env var context if it doesn't already include it
                if (
                  error.message &&
                  error.message.includes('Cannot resolve path') &&
                  !error.message.includes('env var')
                ) {
                  throw new Error(
                    `${ERROR_PREFIX} Cannot resolve path for env var "${envVarName}" (path: "${opPath}").`
                  );
                } else {
                  throw error;
                }
              }
              console.warn(
                `${ERROR_PREFIX} Error processing env var "${envVarName}": ${error.message}. Variable not updated.`
              );
            }
          } else if (placeholderRegex.exec(originalValue) !== null) {
            log(
              `Processing string with placeholders for env var "${envVarName}".`
            );
            try {
              updatedConfig.env[envVarName] =
                await this.replacePlaceholders(originalValue);
              log(
                `Env var "${envVarName}" updated after placeholder replacement.`
              );
            } catch (error: any) {
              if (failOnError) throw error;
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
}
