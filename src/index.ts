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

interface ResolvedSecretIdentifier {
  vaultName: string;
  itemName: string;
  fieldSpecifier: string;
  originalPath: string;
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
    `Attempting to resolve op path: "${originalOpPath}" using CYOP_VAULT="${vaultEnv}" (from ${
      vaultFromCypressEnv ? "Cypress env" : "process.env"
    }), CYOP_ITEM="${itemEnv}" (from ${
      itemFromCypressEnv ? "Cypress env" : "process.env"
    })`
  );

  if (!originalOpPath || !originalOpPath.startsWith("op://")) {
    console.warn(
      `Invalid 1Password key. Path "${originalOpPath}" is not a valid op:// URI.`
    );
    return null;
  }

  const pathContent = originalOpPath.substring(5); // Remove "op://"
  if (!pathContent) {
    console.warn(
      `Invalid 1Password key. Path "${originalOpPath}" is empty after "op://".`
    );
    return null;
  }
  const pathParts = pathContent.split("/"); // These are raw, unencoded parts

  let vaultName: string | undefined;
  let itemName: string | undefined;
  let fieldSpecifier: string | undefined;

  if (pathParts.length === 3 && pathParts.every((p) => p.length > 0)) {
    // Full path: op://vault/item/field
    vaultName = pathParts[0];
    itemName = pathParts[1];
    fieldSpecifier = pathParts[2];
    log(
      `Path "${originalOpPath}" is a full path. Using raw segments: Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === 2 && pathParts.every((p) => p.length > 0)) {
    // Partial path: op://item/field, use CYOP_VAULT
    if (!vaultEnv) {
      console.warn(
        `CYOP_VAULT environment variable is not set or is empty, but path "${originalOpPath}" (format op://item/field) requires it.`
      );
      return null;
    }
    vaultName = vaultEnv;
    itemName = pathParts[0];
    fieldSpecifier = pathParts[1];
    log(
      `Resolved path "${originalOpPath}" to Vault="${vaultName}" (from CYOP_VAULT), Item="${itemName}", Field="${fieldSpecifier}".`
    );
  } else if (pathParts.length === 1 && pathParts[0].length > 0) {
    // Partial path: op://field, use CYOP_VAULT and CYOP_ITEM
    if (!vaultEnv || !itemEnv) {
      console.warn(
        `CYOP_VAULT and/or CYOP_ITEM environment variables are not set or are empty, but path "${originalOpPath}" (format op://field) requires them.`
      );
      return null;
    }
    vaultName = vaultEnv;
    itemName = itemEnv;
    fieldSpecifier = pathParts[0];
    log(
      `Resolved path "${originalOpPath}" to Vault="${vaultName}" (from CYOP_VAULT), Item="${itemName}" (from CYOP_ITEM), Field="${fieldSpecifier}".`
    );
  } else {
    console.warn(
      `Path "${originalOpPath}" has an unsupported number of segments or empty segments. Expected 1, 2, or 3 non-empty segments after \'op://\'. Found segments: [${pathParts.join(
        ", "
      )}]`
    );
    return null;
  }

  if (!vaultName || !itemName || !fieldSpecifier) {
    console.warn(
      `Could not fully determine vault, item, and field for "${originalOpPath}".`
    );
    return null;
  }

  return { vaultName, itemName, fieldSpecifier, originalPath: originalOpPath };
}

// Helper to find a specific field value from an item, supporting section.field format
function findFieldValue(
  itemObject: OpJsItem, // Expect OpJsItem directly
  fieldSpecifier: string,
  log: debug.Debugger // Added for logging
): string | undefined {
  if (!itemObject.fields || itemObject.fields.length === 0) {
    log(`Item "${itemObject.title}" (ID: ${itemObject.id}) has no fields.`);
    return undefined;
  }

  const parts = fieldSpecifier.split(".");
  const targetFieldName = parts.pop()?.toLowerCase(); // Convert to lowercase for case-insensitive comparison
  const targetSectionName = parts.join(".")?.toLowerCase(); // Convert to lowercase for case-insensitive comparison

  const availableFieldsDesc = itemObject.fields
    .map((f) => {
      const sectionDesc = f.section?.label ? `${f.section.label}.` : "";
      const valuePresence =
        typeof (f as OpJsValueField).value !== "undefined"
          ? "present"
          : "absent";
      return `${sectionDesc}${f.label} (id: ${
        f.id || "N/A"
      }, value: ${valuePresence})`;
    })
    .join(", ");

  log(
    `Searching for field specifier "${fieldSpecifier}" (parsed as Field="${targetFieldName}", Section="${
      targetSectionName || "(none)"
    }") within item "${itemObject.title}" (ID: ${
      itemObject.id
    }). Available fields: [${availableFieldsDesc}]`
  );

  for (const field of itemObject.fields) {
    const currentFieldLabel = field.label?.toLowerCase(); // Convert to lowercase
    const currentFieldId = field.id?.toLowerCase(); // Convert to lowercase
    const currentFieldSectionLabel = field.section?.label?.toLowerCase() || ""; // Convert to lowercase

    let matchReason = "";
    if (currentFieldLabel === targetFieldName) {
      matchReason = `label ("${field.label}")`;
    } else if (currentFieldId === targetFieldName) {
      matchReason = `id ("${field.id}")`;
    }

    if (matchReason) {
      if (targetSectionName) {
        // User specified a section
        if (currentFieldSectionLabel === targetSectionName) {
          log(
            `Found matching field by ${matchReason} in section "${
              field.section?.label || ""
            }". Value is ${
              typeof (field as OpJsValueField).value !== "undefined"
                ? "present"
                : "absent"
            }.`
          );
          return (field as OpJsValueField).value;
        }
      } else {
        // User did not specify a section
        log(
          `Found field by ${matchReason}. Section: "${
            field.section?.label || "(none)"
          }". Value is ${
            typeof (field as OpJsValueField).value !== "undefined"
              ? "present"
              : "absent"
          }.`
        );
        return (field as OpJsValueField).value;
      }
    }
  }

  log(
    `Field specifier "${fieldSpecifier}" (parsed as Field="${targetFieldName}", Section="${
      targetSectionName || "(none)"
    }") not found in item "${
      itemObject.title
    }" (checked label and id, case-insensitive).`
  );
  return undefined;
}

async function replacePlaceholders(
  originalString: string,
  cypressEnv?: Record<string, any>
): Promise<string> {
  const log = debug("cyop:replace");
  const placeholderRegex = /{{\s*(op:\/\/[^}\s]+)\s*}}/g;
  let resultString = originalString;
  let match;

  const matches = [];
  while ((match = placeholderRegex.exec(originalString)) !== null) {
    matches.push({
      placeholder: match[0],
      shortSecretPath: match[1],
    });
  }

  for (const m of matches) {
    const resolvedIdentifier = resolveSecretPath(
      m.shortSecretPath,
      log,
      cypressEnv
    );

    if (!resolvedIdentifier) {
      log(
        `Skipping placeholder "${m.placeholder}" as its path "${m.shortSecretPath}" could not be resolved.`
      );
      continue;
    }

    const { vaultName, itemName, fieldSpecifier, originalPath } =
      resolvedIdentifier;

    try {
      // item.get() can return Item | ValueField | ValueField[]
      // We expect an Item when not using the `fields` option in item.get directly for filtering.
      const fetchedItemData: OpJsItem | OpJsValueField | OpJsValueField[] =
        await item.get(itemName, { vault: vaultName });

      // Ensure we have an Item object to pass to findFieldValue
      if (!("fields" in fetchedItemData) || Array.isArray(fetchedItemData)) {
        console.warn(
          `Fetched data for item "${itemName}" in vault "${vaultName}" was not in the expected OpJsItem format. Skipping placeholder "${m.placeholder}".`
        );
        continue;
      }
      const secretValue = findFieldValue(
        fetchedItemData as OpJsItem,
        fieldSpecifier,
        log
      );

      if (secretValue !== null && secretValue !== undefined) {
        resultString = resultString.replace(m.placeholder, secretValue);
        log(
          `Successfully resolved placeholder "${m.placeholder}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}")`
        );
      } else {
        console.warn(
          `Secret value for placeholder "${m.placeholder}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}") is null, undefined, or field not found. Placeholder will not be replaced.`
        );
      }
    } catch (error: any) {
      let errorMessage = error.message;
      if (error.stderr) {
        errorMessage += `\\nStderr: ${error.stderr}`;
      }
      console.error(
        `Failed to load secret for placeholder "${m.placeholder}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}"): ${errorMessage}`
      );
    }
  }
  return resultString;
}

export async function loadOpSecrets(
  config: Cypress.PluginConfigOptions
): Promise<Cypress.PluginConfigOptions> {
  const log = debug("cyop:load");
  const updatedConfig = { ...config };
  if (!updatedConfig.env) {
    updatedConfig.env = {};
  }

  try {
    await validateCli();
    log("1Password CLI validated.");
  } catch (error: any) {
    console.error(
      `1Password CLI validation failed. Please ensure it\'s installed and configured, or use OP_CONNECT_HOST/TOKEN or OP_SERVICE_ACCOUNT_TOKEN for alternative auth: ${error.message}`
    );
    return config;
  }

  for (const envVarName in updatedConfig.env) {
    if (Object.prototype.hasOwnProperty.call(updatedConfig.env, envVarName)) {
      const originalValue = updatedConfig.env[envVarName];

      if (typeof originalValue === "string") {
        if (originalValue.startsWith("op://")) {
          const shortSecretPath = originalValue;
          log(
            `Found direct op path for env var "${envVarName}": "${shortSecretPath}"`
          );

          const resolvedIdentifier = resolveSecretPath(
            shortSecretPath,
            log,
            updatedConfig.env
          );

          if (!resolvedIdentifier) {
            log(
              `Skipping env var "${envVarName}" as its path "${shortSecretPath}" could not be resolved.`
            );
          } else {
            const { vaultName, itemName, fieldSpecifier, originalPath } =
              resolvedIdentifier;
            try {
              const fetchedItemData:
                | OpJsItem
                | OpJsValueField
                | OpJsValueField[] = await item.get(itemName, {
                vault: vaultName,
              });

              if (
                !("fields" in fetchedItemData) ||
                Array.isArray(fetchedItemData)
              ) {
                console.warn(
                  `Fetched data for item "${itemName}" in vault "${vaultName}" was not in the expected OpJsItem format. Skipping env var "${envVarName}".`
                );
                continue;
              }
              const secretValue = findFieldValue(
                fetchedItemData as OpJsItem,
                fieldSpecifier,
                log
              );

              if (secretValue !== null && secretValue !== undefined) {
                updatedConfig.env[envVarName] = secretValue;
                log(
                  `Successfully loaded secret for env var "${envVarName}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}")`
                );
              } else {
                console.warn(
                  `Secret value for env var "${envVarName}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}") is null, undefined, or field not found.`
                );
              }
            } catch (error: any) {
              let errorMessage = error.message;
              if (error.stderr) {
                errorMessage += `\\nStderr: ${error.stderr}`;
              }
              console.error(
                `Failed to load secret for env var "${envVarName}" (path: "${originalPath}" -> Vault="${vaultName}", Item="${itemName}", Field="${fieldSpecifier}"): ${errorMessage}`
              );
            }
          }
        } else if (originalValue.includes("{{op://")) {
          updatedConfig.env[envVarName] = await replacePlaceholders(
            originalValue,
            updatedConfig.env
          );
        }
      }
    }
  }
  return updatedConfig;
}

export default async (
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions
): Promise<Cypress.PluginConfigOptions> => {
  const log = debug("cyop:core");
  log(
    "Initializing to load secrets from environment variables. " +
      "It will look for values starting with 'op://' or containing '{{op://...}}' placeholders."
  );
  log(
    "Authentication will be attempted in the following order: " +
      "1. 1Password CLI (system authentication). " +
      "2. 1Password Connect (OP_CONNECT_HOST & OP_CONNECT_TOKEN env vars). " +
      "3. 1Password Service Account (OP_SERVICE_ACCOUNT_TOKEN env var)."
  );

  // The op-js library handles the authentication flow automatically.
  return loadOpSecrets(config); // Pass the whole config
};
