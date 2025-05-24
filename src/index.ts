import debug from "debug";
import {
  item,
  validateCli,
  setConnect,
  setServiceAccount,
  Item as OpJsItem,
  Field as OpJsField, // Keep for general field properties if needed
  ValueField as OpJsValueField, // Specific type for fields with a value
} from "@1password/op-js";

// Optional: Helper function to configure op-js authentication if needed.
// By default, op-js tries CLI (system auth) -> Connect env vars -> Service Account env var.
// This function could be called by the user in their cypress.config.js if they want to explicitly set auth.
// For this plugin, we'll rely on the default behavior or environment variables.
export function configureOpAuth(authConfig: {
  connectHost?: string;
  connectToken?: string;
  serviceAccountToken?: string;
}) {
  const log = debug("cyop:configure");
  if (authConfig.connectHost && authConfig.connectToken) {
    setConnect(authConfig.connectHost, authConfig.connectToken);
    log("Configured to use 1Password Connect.");
  } else if (authConfig.serviceAccountToken) {
    setServiceAccount(authConfig.serviceAccountToken);
    log("Configured to use 1Password Service Account.");
  }
}

const placeholderRegex = new RegExp(
  "{{\\s{0,20}(op:\\/\\/[^}]+?)\\s{0,20}}}",
  "g"
); // Updated to allow spaces in op:// paths while preventing ReDoS

export interface CyOpPluginOptions {
  /**
   * If true, the plugin will throw an error if a secret cannot be resolved.
   * If false, it will log a warning and continue, leaving the environment variable unchanged or the placeholder unreplaced.
   * @default true
   */
  failOnError?: boolean;
}

interface ResolvedSecretIdentifier {
  vaultName: string;
  itemName: string;
  fieldSpecifier: string;
  originalPath: string;
}

// Define types for cached items
type CachedItemEntry =
  | OpJsItem
  | { error: any; vaultName: string; itemName: string; originalPath: string };

function isErrorEntry(
  entry: CachedItemEntry
): entry is {
  error: any;
  vaultName: string;
  itemName: string;
  originalPath: string;
} {
  return (entry as any).error !== undefined;
}

function resolveSecretPath(
  originalOpPath: string,
  log: debug.Debugger,
  cypressEnv?: Record<string, any>
): ResolvedSecretIdentifier | null {
  const vaultFromCypressEnv = cypressEnv?.CYOP_VAULT;
  const itemFromCypressEnv = cypressEnv?.CYOP_ITEM;

  let vaultEnv =
    typeof vaultFromCypressEnv === "string"
      ? vaultFromCypressEnv
      : process.env.CYOP_VAULT;
  let itemEnv =
    typeof itemFromCypressEnv === "string"
      ? itemFromCypressEnv
      : process.env.CYOP_ITEM;

  log(
    `Resolving op path: "${originalOpPath}" (CYOP_VAULT: "${vaultEnv}", CYOP_ITEM: "${itemEnv}")`
  );

  if (!originalOpPath || !originalOpPath.startsWith("op://")) {
    console.warn(
      `[cypress-1password] Invalid path: "${originalOpPath}". Must be an op:// URI.`
    );
    return null;
  }

  const pathContent = originalOpPath.substring(5);
  if (!pathContent) {
    console.warn(
      `[cypress-1password] Invalid path: "${originalOpPath}". Empty after "op://".`
    );
    return null;
  }
  const pathParts = pathContent.split("/");

  let vaultName: string | undefined;
  let itemName: string | undefined;
  let fieldSpecifier: string | undefined;

  if (pathParts.length === 3 && pathParts.every((p) => p.length > 0)) {
    vaultName = pathParts[0];
    itemName = pathParts[1];
    fieldSpecifier = pathParts[2];
    log(
      `Path "${originalOpPath}" -> Full path. Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === 2 && pathParts.every((p) => p.length > 0)) {
    if (!vaultEnv) {
      console.warn(
        `[cypress-1password] CYOP_VAULT missing for partial path "${originalOpPath}" (op://item/field).`
      );
      return null;
    }
    vaultName = vaultEnv;
    itemName = pathParts[0];
    fieldSpecifier = pathParts[1];
    log(
      `Path "${originalOpPath}" -> Partial path (item/field). Vault="${vaultName}" (from CYOP_VAULT), Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === 1 && pathParts[0].length > 0) {
    if (!vaultEnv || !itemEnv) {
      console.warn(
        `[cypress-1password] CYOP_VAULT and/or CYOP_ITEM missing for partial path "${originalOpPath}" (op://field).`
      );
      return null;
    }
    vaultName = vaultEnv;
    itemName = itemEnv;
    fieldSpecifier = pathParts[0];
    log(
      `Path "${originalOpPath}" -> Partial path (field). Vault="${vaultName}" (from CYOP_VAULT), Item="${itemName}" (from CYOP_ITEM), Field="${fieldSpecifier}".`
    );
  } else {
    console.warn(
      `[cypress-1password] Path "${originalOpPath}" has unsupported segment structure: [${pathParts.join(
        ", "
      )}]`
    );
    return null;
  }

  if (!vaultName || !itemName || !fieldSpecifier) {
    // This case should ideally be caught by the specific checks above.
    console.warn(
      `[cypress-1password] Could not fully determine vault, item, and field for "${originalOpPath}".`
    );
    return null;
  }

  return { vaultName, itemName, fieldSpecifier, originalPath: originalOpPath };
}

async function getAndFindSecretValue(
  resolvedIdentifier: ResolvedSecretIdentifier,
  log: debug.Debugger,
  itemCache: CachedItemEntry[], // Added itemCache parameter
  pluginOptions?: CyOpPluginOptions
): Promise<string | undefined> {
  const failOnError = pluginOptions?.failOnError ?? true;
  const { vaultName, itemName, fieldSpecifier, originalPath } =
    resolvedIdentifier;

  // 1. Check cache by iterating through cached items
  for (const cachedEntry of itemCache) {
    if (isErrorEntry(cachedEntry)) {
      // For error entries, we need to check if the current request would result in the same item.get call
      // The error was cached with the exact vaultName and itemName that were passed to item.get
      // So we need to check if the current request would resolve to the same parameters
      if (
        cachedEntry.vaultName === vaultName &&
        cachedEntry.itemName === itemName
      ) {
        log(
          `Using cached error for item "${itemName}" (vault "${vaultName}") for path "${originalPath}".`
        );
        const message = `Previously failed to fetch item "${itemName}" (vault "${vaultName}") for path "${cachedEntry.originalPath}". Error: ${cachedEntry.error.message}`;
        if (failOnError) throw new Error(`[cypress-1password] ${message}`);
        console.warn(`[cypress-1password] ${message}`);
        return undefined;
      }
    } else {
      // It's an OpJsItem
      const cachedItem = cachedEntry;
      // Match vault by ID or name (case-insensitive for name)
      const vaultMatch =
        cachedItem.vault.id === vaultName ||
        cachedItem.vault.name?.toLowerCase() === vaultName.toLowerCase();
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
          if (failOnError) throw new Error(`[cypress-1password] ${message}`);
          console.warn(`[cypress-1password] ${message}`);
          return undefined;
        }
      }
    }
  }

  log(
    `Fetching item "${itemName}" (vault "${vaultName}") for path "${originalPath}" (not found in cache).`
  );

  try {
    const fetchedItemData: OpJsItem | OpJsValueField | OpJsValueField[] =
      await item.get(itemName, { vault: vaultName });

    if (!("fields" in fetchedItemData) || Array.isArray(fetchedItemData)) {
      const message = `Data for item "${itemName}" (vault "${vaultName}", path "${originalPath}") not in expected OpJsItem format.`;
      // Cache the failure
      itemCache.push({
        error: new Error("Invalid item format"),
        vaultName,
        itemName,
        originalPath,
      });
      if (failOnError) throw new Error(`[cypress-1password] ${message}`);
      console.warn(`[cypress-1password] ${message}`);
      return undefined;
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
      if (failOnError) throw new Error(`[cypress-1password] ${message}`);
      console.warn(`[cypress-1password] ${message}`);
      return undefined;
    }
  } catch (error: any) {
    log(
      `Failed to fetch item "${itemName}" (vault "${vaultName}") for path "${originalPath}". Error: ${error.message}`
    );
    // Cache the failure
    itemCache.push({ error, vaultName, itemName, originalPath });

    let errorMessage = error.message;
    // Check if it's an error from op-js which might have stderr
    if (error.stderr) errorMessage += `\nStderr: ${error.stderr}`;

    // If the error message is already prefixed (e.g., from a previous throw in this function or findFieldValue),
    // and failOnError is true, rethrow it. If failOnError is false, log it (it's already prefixed).
    if (error.message && error.message.startsWith("[cypress-1password]")) {
      if (failOnError) throw error; // Rethrow the already formatted error
      console.warn(error.message); // Log the already formatted warning
      return undefined;
    }

    // For other errors (e.g., network issues, op-js internal errors not caught above)
    const fullErrorMessage = `Failed to load secret for path "${originalPath}" (Item: "${itemName}", Vault: "${vaultName}"): ${errorMessage}`;
    if (failOnError) throw new Error(`[cypress-1password] ${fullErrorMessage}`);
    console.error(`[cypress-1password] ${fullErrorMessage}`); // Use console.error for unexpected errors
    return undefined;
  }
}

// Helper to find a specific field value from an item, supporting section.field format
function findFieldValue(
  itemObject: OpJsItem, // Expect OpJsItem directly
  fieldSpecifier: string,
  log: debug.Debugger // Added for logging
): string | undefined {
  const fieldSpecifierLower = fieldSpecifier.toLowerCase();
  if (
    !["url", "website"].includes(fieldSpecifier) &&
    (!itemObject.fields || itemObject.fields.length === 0)
  ) {
    log(`Item "${itemObject.title}" (ID: ${itemObject.id}) has no fields.`);
    return undefined;
  }

  const fields = itemObject.fields ?? [];

  log(
    `Searching for field "${fieldSpecifier}" in item "${itemObject.title}" (ID: ${itemObject.id}).`
  );

  // Attempt 1: Direct match
  for (const field of fields) {
    const currentFieldLabel = field.label?.toLowerCase();
    const currentFieldId = field.id?.toLowerCase();

    if (
      currentFieldLabel === fieldSpecifierLower ||
      currentFieldId === fieldSpecifierLower
    ) {
      log(
        `Direct match for "${fieldSpecifier}" (Label: "${field.label}", ID: "${
          field.id
        }"). Value ${
          typeof (field as OpJsValueField).value !== "undefined"
            ? "found"
            : "absent"
        }.`
      );
      return (field as OpJsValueField).value;
    }
  }
  log(`No direct match for "${fieldSpecifier}".`);

  // Attempt 2: Section.Field match
  const parts = fieldSpecifier.split(".");
  if (parts.length > 1) {
    const targetFieldName = parts.pop()?.toLowerCase();
    const targetSectionName = parts.join(".").toLowerCase();

    if (targetFieldName && targetSectionName && targetSectionName.length > 0) {
      log(
        `Attempting section.field match: Section="${targetSectionName}", Field="${targetFieldName}".`
      );
      for (const field of fields) {
        const currentFieldLabel = field.label?.toLowerCase();
        const currentFieldId = field.id?.toLowerCase();
        const currentFieldSectionLabel = field.section?.label?.toLowerCase();
        const currentFieldSectionId = field.section?.id?.toLowerCase();

        const fieldNameMatch =
          currentFieldLabel === targetFieldName ||
          currentFieldId === targetFieldName;
        const sectionNameMatch =
          currentFieldSectionLabel === targetSectionName ||
          currentFieldSectionId === targetSectionName;

        if (fieldNameMatch && sectionNameMatch) {
          log(
            `Section.field match for "${fieldSpecifier}": Field (Label: "${
              field.label
            }", ID: "${field.id}") in Section (Label: "${
              field.section?.label
            }", ID: "${field.section?.id}"). Value ${
              typeof (field as OpJsValueField).value !== "undefined"
                ? "found"
                : "absent"
            }.`
          );
          return (field as OpJsValueField).value;
        }
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
  if (fieldSpecifierLower === "url" || fieldSpecifierLower === "website") {
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

async function replacePlaceholders(
  originalString: string,
  cypressEnv: Record<string, any> | undefined, // Made cypressEnv explicitly potentially undefined
  itemCache: CachedItemEntry[], // Added itemCache parameter
  pluginOptions?: CyOpPluginOptions
): Promise<string> {
  const log = debug("cyop:replace");
  let resultString = originalString;
  let match;
  const failOnError = pluginOptions?.failOnError ?? true; // For top-level issues in this function

  // Use a Map to avoid re-fetching the same secret multiple times if it appears in multiple placeholders
  const resolvedSecretsCache = new Map<string, string | undefined>();

  // Create a list of all replacements to be made
  const replacements = [];
  placeholderRegex.lastIndex = 0;
  while ((match = placeholderRegex.exec(originalString)) !== null) {
    replacements.push({ placeholder: match[0], opPath: match[1] });
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
            `[cypress-1password] Cannot resolve path for placeholder "${placeholder}" (path: "${opPath}").`
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

export async function loadOpSecrets(
  config: Cypress.PluginConfigOptions,
  pluginOptions?: CyOpPluginOptions
): Promise<Cypress.PluginConfigOptions> {
  const log = debug("cyop:load");
  const itemCache: CachedItemEntry[] = []; // Initialize item cache as an array

  if (!config || typeof config !== "object") {
    return config; // No config to process
  }
  const updatedConfig = { ...config };
  if (!updatedConfig.env) {
    return config; // No env vars to process
  }
  const failOnError = pluginOptions?.failOnError ?? true; // For top-level issues in this function

  try {
    await validateCli();
    log("1Password CLI validated.");
  } catch (error: any) {
    console.error(
      `[cypress-1password] 1Password CLI validation failed. Plugin will not load secrets. Error: ${error.message}`
    );
    return config; // Critical setup error, return original config
  }

  log("Processing Cypress environment variables for 1Password secrets...");

  for (const envVarName in updatedConfig.env) {
    if (Object.prototype.hasOwnProperty.call(updatedConfig.env, envVarName)) {
      let originalValue = updatedConfig.env[envVarName];

      if (typeof originalValue === "string") {
        originalValue = originalValue.trim();
        if (originalValue.startsWith("op://")) {
          const opPath = originalValue;
          log(
            `Processing direct op:// path for env var "${envVarName}": "${opPath}"`
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
                `[cypress-1password] Cannot resolve path for env var "${envVarName}" (path: "${opPath}").`
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
              `[cypress-1password] Error processing placeholders for env var "${envVarName}": ${error.message}. Variable may be partially updated or unchanged.`
            );
          }
        }
      }
    }
  }
  log("Finished processing Cypress environment variables.");
  return updatedConfig;
}

export default async (
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  pluginOptions?: CyOpPluginOptions // Added pluginOptions
): Promise<Cypress.PluginConfigOptions> => {
  const log = debug("cyop:core");
  log(
    "Initializing to load secrets from environment variables. " +
      "It will look for values starting with 'op://' or containing '{{op://...}}' placeholders."
  );

  // The op-js library handles the authentication flow automatically.
  return loadOpSecrets(config, pluginOptions); // Pass pluginOptions
};
