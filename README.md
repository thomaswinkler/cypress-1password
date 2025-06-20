# Cypress 1Password Plugin

Integrate your Cypress projects with 1Password to dynamically load secrets into Cypress environment variables. This plugin allows you to avoid hardcoding sensitive information like usernames, passwords, or API keys in your `cypress.env.json` files or directly in your test code. 

This plugin uses the official [@1password/op-js](https://1password.github.io/op-js/) library to securely fetch secrets from your 1Password vaults, making it easy to manage sensitive data in your Cypress tests.

It follows [1Password's Secret Reference Syntax](https://developer.1password.com/docs/cli/secret-reference-syntax/) also used to allow both direct secret references and embedded placeholders within strings, providing flexibility in how you manage and use secrets in your tests. With this, it is mimicking the behavior of the [op inject](https://developer.1password.com/docs/cli/secret-reference-syntax/) cli command for Cypress.

## Features

*   Load secrets directly from your 1Password vaults into Cypress environment variables.
*   **Multiple Vault Support**: Configure multiple vaults in `CYOP_VAULT` (comma-separated or array) to automatically search across personal, team, and shared vaults in order.
*   **Automatic Vault Discovery**: When no vault is configured, automatically discover and search across all accessible vaults for maximum flexibility.
*   Supports two methods for specifying secrets:
    *   Directly assigning a 1Password secret reference URI (e.g., `op://vault/item/field`) to an environment variable.
    *   Embedding secret reference URIs as placeholders (e.g., `{{op://vault/item/field}}`) within string environment variables.
*   **Performance Optimized**: Intelligent caching prevents duplicate API calls within the same operation.
*   Uses the official [@1password/op-js](https://1password.github.io/op-js/) library, enabling flexible authentication.

## Prerequisites

*   Cypress (tested with >=14.0.0)
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

    In your `cypress.config.js` or `cypress.config.ts` file, import the plugin and call it within the `setupNodeEvents` function. You can also pass plugin-specific options here.

    ```typescript
    // cypress.config.ts
    import { defineConfig } from 'cypress';
    import onePasswordPlugin, { CyOpPluginOptions } from 'cypress-1password';

    export default defineConfig({
      e2e: {
        async setupNodeEvents(on, config) {
          // Plugin options (optional)
          const options: CyOpPluginOptions = {
            failOnError: true, // Default is true. Set to false to only log warnings instead of throwing errors.
          };
          return await onePasswordPlugin(on, config, options);
        },
      },
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
        
        // Example 5: Multiple vault configuration
        CYOP_VAULT: 'PersonalVault,TeamVault,SharedSecrets', // Check vaults in this order
        CYOP_ITEM: 'DefaultCredentials',
        
        // With multiple vaults configured above, this will search:
        // 1. PersonalVault/DefaultCredentials/apiKey
        // 2. TeamVault/DefaultCredentials/apiKey  
        // 3. SharedSecrets/DefaultCredentials/apiKey
        DEFAULT_API_KEY: 'op://apiKey',
      },
    });
    ```

2.  **Plugin Options**

    The plugin accepts an optional configuration object with the following properties:

    *   `failOnError` (boolean, default: `true`):
        *   If `true`, the plugin will throw an error and halt Cypress setup if any 1Password secret (direct `op://` reference or `{{op://...}}` placeholder) cannot be resolved. This is the default behavior to ensure that tests don't run with missing critical secrets.
        *   If `false`, the plugin will log a warning to the console if a secret cannot be resolved, but will allow Cypress to continue. The environment variable will retain its original `op://` string, or the placeholder will remain unreplaced.

3.  **Define Secrets in Cypress Environment**

    As shown above, configure your secrets directly in the `env` block of your `cypress.config.js`/`ts` or in `cypress.env.json`.

    *   **Direct Reference**: If an environment variable's value is a single `op://` string, the plugin will replace the entire value with the fetched secret.
        ```json
        {
          "MY_API_TOKEN": "op://SharedVault/MyService/apiToken"
        }
        ```

    *   **Embedded Placeholders**: If an environment variable is a string containing `{{op://...}}` placeholders, the plugin will replace each placeholder with its corresponding secret.
        ```json
        {
          "WELCOME_MESSAGE": "Hello {{op://UserVault/UserProfile/username}}, your API key is {{op://UserVault/UserAPIKey/key}}"
        }
        ```

## Usage in Tests

Once configured, the secrets will be available in your Cypress tests via `Cypress.env()`:

```javascript
// in your_spec.cy.js
describe('Login Test', () => {
  it('should log in using secrets from 1Password', () => {
    const adminPassword = Cypress.env('ADMIN_PASSWORD');
    const dbUrl = Cypress.env('DATABASE_URL');

    expect(adminPassword).to.be.a('string').and.not.be.empty;
    expect(dbUrl).to.contain('postgres://'); // Assuming part of the string remains if placeholders were used

    cy.log(`Admin Password retrieved: ${adminPassword}`); // For debugging, be careful logging secrets
    // ... use adminPassword and dbUrl in your tests
  });
});
```

## Resolving Secrets

### Finding 1Password Secret Reference URIs

1Password secret reference URIs follow the format `op://<vault_name_or_uuid>/<item_name_or_uuid>/<field_label_or_id>`. The `<vault_name_or_uuid>` and `<item_name_or_uuid>` can be either the name or UUID of the vault and item, respectively. The `<field_label_or_id>` is the label or unique ID of the field you want to retrieve.

You can find or construct these URIs by:
*   Using the 1Password CLI: `op item get "My Login Item" --vault "My Vault" --format json`
*   Manually constructing them: `op://<vault_name_or_uuid>/<item_name_or_uuid>/<field_label_or_id>`

The plugin will attempt to match the `<field_label_or_id>` part against both the field's visible label and its unique ID (case-insensitively). For example, if a field has the label "Password" and an ID "password_123", providing either "Password" or "password_123" in the URI should work.
Refer to the [1Password Secret Reference Syntax documentation](https://developer.1password.com/docs/cli/secret-reference-syntax/) for more details.

To list all URI references for a specific vault or item, you can use the 1Password CLI:
```bash
op item get "My Login Item" --vault "My Vault" --format json  | jq '.fields[] | .reference'
```

### Specifying Fields within Sections

If a field is located within a section in your 1Password item, you can specify it using a dot-separated format in the field part of the URI: `section_name.field_name`. For example:

*   `op://MyVault/MyItem/MySection.MyField`
*   If `CYOP_VAULT="MyVault"` and `CYOP_ITEM="MyItem"` are set: `op://MySection.MyField`

The plugin will first try to match the entire `MySection.MyField` string against field labels or IDs directly. If that fails, it will then interpret `MySection` as the section name (or ID) and `MyField` as the field name (or ID) within that section. Both section and field name/ID matching are case-insensitive.

If your field label or ID itself contains a dot (e.g., a field labeled `config.api.key` *not* in a section), the plugin will prioritize matching this full label/ID first. Only if that fails and a dot is present will it attempt to parse the specifier as `section.field`.

When resolving `section_name.field_name`, the plugin will try to match `section_name` against the section's label first, and if that doesn't match, it will try to match against the section's ID.

### Special Handling for "url" or "website" Fields

If you specify `op://.../url` or `op://.../website` and a field explicitly labeled or identified as "url" or "website" is not found through the standard matching process (including section matching), the plugin will then look into the item's dedicated `urls` array (if present on the item structure provided by `@1password/op-js`).
*   It will first look for a URL marked as `primary: true`.
*   If no primary URL is found, it will use the first URL in the `urls` array.
*   The `href` property of the selected URL object will be returned.

### Simplified Path Resolution with Environment Variables

To simplify referencing secrets, especially when many secrets come from the same vault or item, you can define the following environment variables. These can be set either as system environment variables (e.g., `process.env.CYOP_VAULT`) or as Cypress environment variables (e.g., in `cypress.config.js` or `cypress.env.json`):

*   `CYOP_VAULT`: Specifies the default vault name(s) or UUID(s). Can be:
    *   A single vault: `"MyVault"` or `"personal-vault-uuid"`
    *   Multiple vaults (comma-separated): `"PersonalVault,TeamVault,SharedVault"`
    *   An array when defined in Cypress config: `["PersonalVault", "TeamVault"]`
*   `CYOP_ITEM`: Specifies the default item name or UUID within the vault(s) specified by `CYOP_VAULT`.

**Priority:** If both a Cypress environment variable and a system environment variable are set for `CYOP_VAULT` or `CYOP_ITEM`, the Cypress environment variable will take precedence.

#### Multiple Vault Support

When using multiple vaults in `CYOP_VAULT`, the plugin will search for items in the order vaults are specified. This is useful when you have secrets distributed across different vaults (e.g., personal and team vaults) and want to check them automatically without changing the environment variable for each test.

For example, with `CYOP_VAULT="PersonalVault,TeamVault,SharedSecrets"`:
- First, the plugin attempts to find the item in `PersonalVault`
- If not found, it tries `TeamVault`
- Finally, it tries `SharedSecrets`
- If the item is not found in any vault, an error is reported with details about all vaults checked

The plugin will use these environment variables to construct the full secret path if you provide a partial `op://` URI:

1.  **Full Path (no environment variables needed)**:
    `op://MyVault/MyItem/MyField`
    This always takes precedence.

2.  **Item and Field (uses `CYOP_VAULT`)**:
    If `CYOP_VAULT="SharedSecrets"` is set, then `op://MyItem/MyField` will be resolved as `op://SharedSecrets/MyItem/MyField`.
    
    With multiple vaults like `CYOP_VAULT="PersonalVault,TeamVault"`, the plugin will try `op://PersonalVault/MyItem/MyField` first, then `op://TeamVault/MyItem/MyField` if not found.

3.  **Field Only (uses `CYOP_VAULT` and `CYOP_ITEM`)**:
    If `CYOP_VAULT="SharedSecrets"` and `CYOP_ITEM="ApiCredentials"` are set, then `op://MyField` will be resolved as `op://SharedSecrets/ApiCredentials/MyField`.
    
    With multiple vaults, the same search order applies: `op://PersonalVault/ApiCredentials/MyField`, then `op://TeamVault/ApiCredentials/MyField`, etc.

This applies to both direct references and embedded placeholders. For example:
```json
{
  "CYOP_VAULT": "UserVault",
  "CYOP_ITEM": "UserProfile",
  "USER_EMAIL": "op://email", 
  "API_ENDPOINT": "https://api.example.com/{{op://api_key}}"
}
```

#### Multiple Vault Configuration Examples

```javascript
// cypress.config.js - String format (comma-separated)
export default defineConfig({
  env: {
    CYOP_VAULT: 'PersonalVault,TeamVault,SharedSecrets',
    CYOP_ITEM: 'ServiceCredentials',
    API_TOKEN: 'op://token', // Will search all three vaults in order
  }
});
```

```javascript
// cypress.config.js - Array format
export default defineConfig({
  env: {
    CYOP_VAULT: ['PersonalVault', 'TeamVault', 'SharedSecrets'],
    CYOP_ITEM: 'ServiceCredentials',
    API_TOKEN: 'op://token', // Will search all three vaults in order
  }
});
```

```bash
# Environment variable format (comma-separated)
export CYOP_VAULT="PersonalVault,TeamVault,SharedSecrets"
export CYOP_ITEM="ServiceCredentials"
```

## Troubleshooting

### Authentication Issues (`1Password CLI validation failed`, `Failed to load secret ...` with auth errors)
*   **CLI**: Ensure 1Password CLI is installed, you are signed in (`op signin`), and system authentication/biometrics are working. Try a simple CLI command like `op vault ls` to test.
*   **Connect**: Verify `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` are correctly set and exported in the environment where Cypress is running. Check Connect server logs.
*   **Service Account**: Verify `OP_SERVICE_ACCOUNT_TOKEN` is correctly set and exported. Ensure the Service Account has permission to access the specified vault and item.
  
### `Failed to load secret for ...` (other than auth)
*   Verify the 1Password secret reference URI is correct (e.g., `op://vault/item/field`).
*   Ensure the authenticated 1Password identity (user, Service Account, or Connect identity) has permission to access the specified vault and item.
*   **For multiple vaults**: Check that the item exists in at least one of the specified vaults and that you have access to all vaults listed in `CYOP_VAULT`.
     
### Multiple Vault Issues
*   **Item not found in any vault**: Verify the item name/ID is correct and exists in at least one of the vaults specified in `CYOP_VAULT`.
*   **Vault access permissions**: Ensure your 1Password account, Service Account, or Connect identity has access to all vaults listed in `CYOP_VAULT`.
*   **Vault names vs UUIDs**: Make sure vault names are exact matches (case-sensitive) or use vault UUIDs for more reliable identification.
*   **Order matters**: Items will be retrieved from the first vault in the list where they're found. If you have duplicate items across vaults, the plugin will use the one from the vault listed first in `CYOP_VAULT`.

### Automatic Vault Discovery Issues
*   **"Could not automatically discover vaults"**: This indicates the plugin couldn't retrieve the vault list from 1Password. Check your authentication and ensure you have permission to list vaults.
*   **Slow performance**: Automatic discovery requires an extra API call. For better performance in production, explicitly configure `CYOP_VAULT` with the specific vaults you need.
     
### Secrets are not replaced or are `undefined` in tests

*   Double-check the environment variable names and the `op://` URIs or `{{op://...}}` placeholders in your Cypress `env` configuration.
*   Ensure `onePasswordPlugin(on, config, options)` is correctly called, `await`ed, and its result is returned in `setupNodeEvents`. Use `failOnError: true` to catch issues during plugin initialization.
*   Make sure `setupNodeEvents` is an `async` function.
*   Check the console output during Cypress startup for any plugin-specific logs or error messages.
*   Enable debug logs (see below) for more detailed output.

### Debug Logs
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

