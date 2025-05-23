# Cypress 1Password Plugin

Integrate your Cypress projects with 1Password to dynamically load secrets into Cypress environment variables. This plugin allows you to avoid hardcoding sensitive information like usernames, passwords, or API keys in your `cypress.env.json` files or directly in your test code.

## Features

*   Load secrets directly from your 1Password vaults into Cypress environment variables.
*   Supports two methods for specifying secrets:
    *   Directly assigning a 1Password secret reference URI (e.g., `op://vault/item/field`) to an environment variable.
    *   Embedding secret reference URIs as placeholders (e.g., `{{op://vault/item/field}}`) within string environment variables.
*   Uses the official [@1password/op-js](https://1password.github.io/op-js/) library, enabling flexible authentication.

## Prerequisites

*   Node.js
*   Cypress (>=10.0.0)
*   1Password account.
*   One of the following authentication methods configured for `@1password/op-js`:
    *   **1Password CLI**: Installed and configured for system authentication (e.g., biometrics, desktop app integration). This is the preferred and often easiest method.
    *   **1Password Connect Server**: Environment variables `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` set.
    *   **1Password Service Account**: Environment variable `OP_SERVICE_ACCOUNT_TOKEN` set.

## Installation

1.  **Install the plugin**

    ```bash
    npm install cypress-1password --save-dev
    # or
    yarn add cypress-1password --dev
    ```
    *(Assuming this plugin will be published as `cypress-1password`. If you are using it locally, you might install it from a local path or git repository).*

2.  **Set up 1Password Authentication**

    The plugin, via `@1password/op-js`, will attempt to authenticate in the following order:
    1.  **1Password CLI (System Authentication)**: If you have the 1Password CLI installed and configured (e.g., signed in, biometrics enabled), the plugin will use it automatically.
        *   [Install 1Password CLI](https://developer.1password.com/docs/cli/get-started#install)
        *   Sign in using the CLI: `op signin`
    2.  **1Password Connect Server**: If you have a 1Password Connect server, set the following environment variables:
        ```bash
        export OP_CONNECT_HOST="<your-connect-host>"
        export OP_CONNECT_TOKEN="<your-connect-token>"
        ```
    3.  **1Password Service Account**: If you prefer to use a Service Account (e.g., for CI environments):
        *   [Create a Service Account](https://developer.1password.com/docs/service-accounts/get-started/).
        *   Grant the Service Account access to the vaults containing the secrets.
        *   Export the token as `OP_SERVICE_ACCOUNT_TOKEN`:
            ```bash
            export OP_SERVICE_ACCOUNT_TOKEN="<your-service-account-token>"
            ```
    It's recommended to set these environment variables (for Connect or Service Account) in your CI environment's secret management system or your local shell profile (e.g., `.zshrc`, `.bashrc`). For local development, using the 1Password CLI with system authentication is often the simplest.

## Configuration

1.  **Register the Plugin in Cypress**

    In your `cypress.config.js` or `cypress.config.ts` file, import the plugin and call it within the `setupNodeEvents` function.

    ```typescript
    // cypress.config.ts
    import { defineConfig } from 'cypress';
    import onePasswordPlugin from 'cypress-1password-plugin'; // Adjust path if installed locally

    export default defineConfig({
      e2e: {
        async setupNodeEvents(on, config) {
          // The plugin will automatically scan config.env for 1Password references.
          // No explicit mapping object is needed anymore.
          return await onePasswordPlugin(on, config);
        },
        // ... other e2e config
      },
      // ... other Cypress config
      env: {
        // Example 1: Direct secret reference
        // The entire value of this env var will be replaced with the secret.
        ADMIN_PASSWORD: 'op://MyVault/AdminCredentials/password',

        // Example 2: Embedded secret reference(s)
        // The {{op://...}} placeholders will be replaced with their corresponding secrets.
        DATABASE_URL: 'postgres://{{op://DBVault/DBUser/username}}:{{op://DBVault/DBUser/password}}@local.db.host:5432/mydb',
        
        // Example 3: Multiple placeholders in one string
        API_KEY_SECRET: 'Key: {{op://APIVault/ServiceKey/key}}, Secret: {{op://APIVault/ServiceKey/secret}}',

        // Example 4: Non-secret environment variable
        BASE_URL: 'http://localhost:3000',

        // After the plugin runs, your env object might look like:
        // ADMIN_PASSWORD: 'actual_admin_password_from_1password'
        // DATABASE_URL: 'postgres://actual_db_user:actual_db_pass@local.db.host:5432/mydb'
        // API_KEY_SECRET: 'Key: actual_api_key, Secret: actual_api_secret'
        // BASE_URL: 'http://localhost:3000'
      },
    });
    ```

2.  **Define Secrets in Cypress Environment**

    As shown above, configure your secrets directly in the `env` block of your `cypress.config.js`/`ts` or in `cypress.env.json`.

    *   **Direct Reference**: If an environment variable's value is a single `op://` string, the plugin will replace the entire value with the fetched secret.
        ```json
        // cypress.env.json example
        {
          "MY_API_TOKEN": "op://SharedVault/MyService/apiToken"
        }
        ```

    *   **Embedded Placeholders**: If an environment variable is a string containing `{{op://...}}` placeholders, the plugin will replace each placeholder with its corresponding secret.
        ```json
        // cypress.env.json example
        {
          "WELCOME_MESSAGE": "Hello {{op://UserVault/UserProfile/username}}, your API key is {{op://UserVault/UserAPIKey/key}}"
        }
        ```

    **Finding 1Password Secret Reference URIs:**
    You can find or construct these URIs by:
    *   Using the 1Password CLI: `op item get "My Login Item" --vault "My Vault" --format json | jq '.fields[] | select(.label=="password") | .reference'`
    *   Manually constructing them: `op://<vault_name_or_uuid>/<item_name_or_uuid>/<field_label_or_uuid>`
    Refer to the [1Password Secret Reference Syntax documentation](https://developer.1password.com/docs/cli/secret-reference-syntax/) for more details.

    **Simplified Path Resolution with Environment Variables:**

    To simplify referencing secrets, especially when many secrets come from the same vault or item, you can define the following environment variables. These can be set either as system environment variables (e.g., `process.env.CYOP_VAULT`) or as Cypress environment variables (e.g., in `cypress.config.js` or `cypress.env.json`):

    *   `CYOP_VAULT`: Specifies the default vault name or UUID.
    *   `CYOP_ITEM`: Specifies the default item name or UUID within the `CYOP_VAULT`.

    **Priority:** If both a Cypress environment variable and a system environment variable are set for `CYOP_VAULT` or `CYOP_ITEM`, the Cypress environment variable will take precedence.

    The plugin will use these environment variables to construct the full secret path if you provide a partial `op://` URI:

    1.  **Full Path (no environment variables needed)**:
        `op://MyVault/MyItem/MyField`
        This always takes precedence.

    2.  **Item and Field (uses `CYOP_VAULT`)**:
        If `CYOP_VAULT="SharedSecrets"` is set, then `op://MyItem/MyField` will be resolved as `op://SharedSecrets/MyItem/MyField`.

    3.  **Field Only (uses `CYOP_VAULT` and `CYOP_ITEM`)**:
        If `CYOP_VAULT="SharedSecrets"` and `CYOP_ITEM="ApiCredentials"` are set, then `op://MyField` will be resolved as `op://SharedSecrets/ApiCredentials/MyField`.

    This applies to both direct references and embedded placeholders. For example:
    ```json
    // With CYOP_VAULT="UserVault" and CYOP_ITEM="UserProfile"
    // cypress.env.json
    {
      "USER_EMAIL": "op://email", // Resolves to op://UserVault/UserProfile/email
      "API_ENDPOINT": "https://api.example.com/{{op://api_key}}" // Resolves to op://UserVault/UserProfile/api_key
    }
    ```
    If a partial path is provided but the required `CYOP_VAULT` or `CYOP_ITEM` variables are not set (either in Cypress env or process.env), a warning will be logged, and the secret will not be resolved.

## Usage in Tests

Once configured, the secrets will be available in your Cypress tests via `Cypress.env()`:

```javascript
// in your_spec.cy.js
describe('Login Test', () => {
  it('should log in using secrets from 1Password', () => {
    const adminPassword = Cypress.env('ADMIN_PASSWORD');
    const dbUrl = Cypress.env('DATABASE_URL');

    expect(adminPassword).to.be.a('string').and.not be.empty;
    expect(dbUrl).to.contain('postgres://'); // Assuming part of the string remains if placeholders were used

    cy.log(`Admin Password retrieved: ${adminPassword}`); // For debugging, be careful logging secrets
    // ... use adminPassword and dbUrl in your tests
  });
});
```

## Plugin Details

The plugin performs the following steps during Cypress setup:
1.  Initializes `@1password/op-js`, which automatically attempts authentication (CLI, Connect, or Service Account).
2.  Validates 1Password CLI accessibility (logs a warning if not found, relying on other auth methods).
3.  Iterates through all environment variables defined in `config.env`.
4.  For each string environment variable:
    *   If the entire value starts with `op://`, it attempts to resolve this URI as a secret. The environment variable is updated with the resolved value.
    *   If the value contains one or more `{{op://...}}` placeholders, it attempts to resolve each placeholder. The environment variable is updated with the new string containing resolved values.
5.  If a secret cannot be resolved (either direct or placeholder), an error/warning is logged, and the original value (or placeholder) may remain.

## Troubleshooting

*   **Authentication Issues (`1Password CLI validation failed`, `Failed to load secret ...` with auth errors)**:
    *   **CLI**: Ensure 1Password CLI is installed, you are signed in (`op signin`), and system authentication/biometrics are working. Try a simple CLI command like `op vault ls` to test.
    *   **Connect**: Verify `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` are correctly set and exported in the environment where Cypress is running. Check Connect server logs.
    *   **Service Account**: Verify `OP_SERVICE_ACCOUNT_TOKEN` is correctly set and exported. Ensure the Service Account has permission to access the specified vault and item.
*   **`Failed to load secret for ...` (other than auth)**:
    *   Verify the 1Password secret reference URI is correct (e.g., `op://vault/item/field`).
    *   Ensure the authenticated 1Password identity (user, Service Account, or Connect identity) has permission to access the specified vault and item.
*   **Secrets are not replaced or are `undefined` in tests**:
    *   Double-check the environment variable names and the `op://` URIs or `{{op://...}}` placeholders in your Cypress `env` configuration.
    *   Ensure `onePasswordPlugin(on, config)` is correctly called, `await`ed, and its result is returned in `setupNodeEvents`.
    *   Make sure `setupNodeEvents` is an `async` function.
    *   Check the console output during Cypress startup for any plugin-specific logs or error messages.
    *   Enable debug logs (see below) for more detailed output.

*   **Enabling Debug Logs**:
    To enable debug logs, set the `DEBUG` environment variable before running Cypress. You can specify one or more namespaces:
    *   `cyop:core`: For general plugin initialization and flow.
    *   `cyop:load`: For details about loading secrets (both direct `op://` and placeholders).
    *   `cyop:replace`: For specifics on placeholder replacement.
    *   `cyop:configure`: For logs related to explicit authentication configuration (if `configureOpAuth` is used).
    *   `cyop:*`: For all plugin logs.

    **Examples:**

    Enable all plugin logs:
    ```bash
    DEBUG="cyop:*" cypress run
    # or
    DEBUG="cyop:*" yarn cypress run 
    ```

    Enable specific logs (e.g., core and loading):
    ```bash
    DEBUG="cyop:core,cyop:load" cypress open
    ```

    You can also set this environment variable in your shell's configuration file (e.g., `~/.zshrc`, `~/.bashrc`) or for a single session.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue.

## License

ISC (or your chosen license)
