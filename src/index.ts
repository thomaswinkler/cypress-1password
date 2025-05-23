import debug from "debug";
import {
  read,
  validateCli,
  setConnect,
  setServiceAccount,
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

function resolveSecretPath(
  originalOpPath: string,
  log: debug.Debugger,
  cypressEnv?: Record<string, any>
): string | null {
  const vaultFromCypressEnv = cypressEnv?.CYOP_VAULT;
  const itemFromCypressEnv = cypressEnv?.CYOP_ITEM;

  const vaultEnv =
    typeof vaultFromCypressEnv === "string"
      ? vaultFromCypressEnv
      : process.env.CYOP_VAULT;
  const itemEnv =
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
  const pathParts = pathContent.split("/");

  if (pathParts.length === 3 && pathParts.every((p) => p.length > 0)) {
    log(`Path "${originalOpPath}" is already a full path.`);
    return originalOpPath; // e.g., op://vault/item/field
  }

  if (pathParts.length === 2 && pathParts.every((p) => p.length > 0)) {
    // op://item/field
    if (!vaultEnv) {
      console.warn(
        `CYOP_VAULT environment variable is not set, but path "${originalOpPath}" (format op://item/field) requires it.`
      );
      return null;
    }
    const resolved = `op://${vaultEnv}/${pathParts[0]}/${pathParts[1]}`;
    log(`Resolved path "${originalOpPath}" to "${resolved}" using CYOP_VAULT.`);
    return resolved;
  }

  if (pathParts.length === 1 && pathParts[0].length > 0) {
    // op://field
    if (!vaultEnv || !itemEnv) {
      console.warn(
        `CYOP_VAULT and/or CYOP_ITEM environment variables are not set, but path "${originalOpPath}" (format op://field) requires them.`
      );
      return null;
    }
    const resolved = `op://${vaultEnv}/${itemEnv}/${pathParts[0]}`;
    log(
      `Resolved path "${originalOpPath}" to "${resolved}" using CYOP_VAULT and CYOP_ITEM.`
    );
    return resolved;
  }

  console.warn(
    `Path "${originalOpPath}" has an unsupported number of segments or empty segments. Expected 1, 2, or 3 non-empty segments after 'op://'. Found segments: [${pathParts.join(
      ", "
    )}]`
  );
  return null;
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
    const resolvedSecretPath = resolveSecretPath(
      m.shortSecretPath,
      log,
      cypressEnv
    );
    if (!resolvedSecretPath) {
      // Warning already logged by resolveSecretPath if path is invalid or env vars missing
      // Log specific to placeholder skipping if needed, but might be redundant
      log(
        `Skipping placeholder "${m.placeholder}" as its path "${m.shortSecretPath}" could not be fully resolved.`
      );
      continue;
    }
    try {
      const secretValue = await read.parse(resolvedSecretPath);
      if (secretValue !== null && secretValue !== undefined) {
        resultString = resultString.replace(m.placeholder, secretValue);
        if (m.shortSecretPath === resolvedSecretPath) {
          log(
            `Successfully resolved placeholder "${m.placeholder}" (path: "${resolvedSecretPath}")`
          );
        } else {
          log(
            `Successfully resolved placeholder "${m.placeholder}" (original path: "${m.shortSecretPath}", resolved: "${resolvedSecretPath}")`
          );
        }
      } else {
        if (m.shortSecretPath === resolvedSecretPath) {
          console.warn(
            `Secret value for placeholder "${m.placeholder}" (path: "${resolvedSecretPath}") is null or undefined. Placeholder will not be replaced.`
          );
        } else {
          console.warn(
            `Secret value for placeholder "${m.placeholder}" (original path: "${m.shortSecretPath}", resolved: "${resolvedSecretPath}") is null or undefined. Placeholder will not be replaced.`
          );
        }
      }
    } catch (error: any) {
      let errorMessage = error.message;
      if (error.stderr) {
        errorMessage += `\nStderr: ${error.stderr}`;
      }
      if (error.stdout) {
        errorMessage += `\nStdout: ${error.stdout}`;
      }
      if (m.shortSecretPath === resolvedSecretPath) {
        console.error(
          `Failed to load secret for placeholder "${m.placeholder}" (path: "${resolvedSecretPath}"): ${errorMessage}`
        );
      } else {
        console.error(
          `Failed to load secret for placeholder "${m.placeholder}" (original path: "${m.shortSecretPath}", resolved: "${resolvedSecretPath}"): ${errorMessage}`
        );
      }
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
      `1Password CLI validation failed. Please ensure it's installed and configured, or use OP_CONNECT_HOST/TOKEN or OP_SERVICE_ACCOUNT_TOKEN for alternative auth: ${error.message}`
    );
    return config; // Return original config if CLI validation fails and no other auth is likely set up
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
          const resolvedSecretPath = resolveSecretPath(
            shortSecretPath,
            log,
            updatedConfig.env
          );

          if (!resolvedSecretPath) {
            // Warning already logged by resolveSecretPath
            log(
              `Skipping env var "${envVarName}" as its path "${shortSecretPath}" could not be fully resolved.`
            );
          } else {
            try {
              const secretValue = await read.parse(resolvedSecretPath);
              if (secretValue !== null && secretValue !== undefined) {
                updatedConfig.env[envVarName] = secretValue;
                if (shortSecretPath === resolvedSecretPath) {
                  log(
                    `Successfully loaded secret for env var "${envVarName}" (path: "${resolvedSecretPath}")`
                  );
                } else {
                  log(
                    `Successfully loaded secret for env var "${envVarName}" (original path: "${shortSecretPath}", resolved: "${resolvedSecretPath}")`
                  );
                }
              } else {
                if (shortSecretPath === resolvedSecretPath) {
                  console.warn(
                    `Secret value for env var "${envVarName}" (path: "${resolvedSecretPath}") is null or undefined.`
                  );
                } else {
                  console.warn(
                    `Secret value for env var "${envVarName}" (original path: "${shortSecretPath}", resolved: "${resolvedSecretPath}") is null or undefined.`
                  );
                }
              }
            } catch (error: any) {
              let errorMessage = error.message;
              if (error.stderr) {
                errorMessage += `\nStderr: ${error.stderr}`;
              }
              if (error.stdout) {
                errorMessage += `\nStdout: ${error.stdout}`;
              }
              if (shortSecretPath === resolvedSecretPath) {
                console.error(
                  `Failed to load secret for env var "${envVarName}" (path: "${resolvedSecretPath}"): ${errorMessage}`
                );
              } else {
                console.error(
                  `Failed to load secret for env var "${envVarName}" (original path: "${shortSecretPath}", resolved: "${resolvedSecretPath}"): ${errorMessage}`
                );
              }
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
