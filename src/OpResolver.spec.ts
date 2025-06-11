/// <reference types="jest" />

import { CyOpPluginOptions, OpResolver } from './index';
import { item, vault, validateCli } from '@1password/op-js';

// Mock @1password/op-js
jest.mock('@1password/op-js', () => ({
  ...jest.requireActual('@1password/op-js'), // Import and retain default behavior
  item: {
    get: jest.fn(),
  },
  vault: {
    list: jest.fn(),
  },
  validateCli: jest.fn(),
}));

const mockItemGet = item.get as jest.Mock;
const mockVaultList = vault.list as jest.Mock;
const mockValidateCli = validateCli as jest.Mock;

// Define a type for our mock Cypress config
interface MockCypressConfig {
  env?: Record<string, any>;
  [key: string]: any;
}

/**
 * Main function to load 1Password secrets into Cypress environment variables.
 * This is now a backward-compatible wrapper around OpResolver.resolve().
 */
async function testResolve(
  config: any,
  pluginOptions?: CyOpPluginOptions
): Promise<any> {
  // Create resolver instance and use the new resolve method
  const resolver = new OpResolver(config.env, pluginOptions);
  return await resolver.resolve(config, pluginOptions);
}

describe('OpResolver', () => {
  beforeEach(() => {
    // Reset mocks completely before each test (both call history and implementations)
    mockItemGet.mockReset();
    mockVaultList.mockReset();
    mockValidateCli.mockReset();

    // Set up default mock implementations
    mockValidateCli.mockResolvedValue(undefined);
    // Mock vault.list to return empty array by default (so vault discovery doesn't trigger unless explicitly configured)
    mockVaultList.mockResolvedValue([]);

    // Clear any CYOP environment variables from process.env
    delete process.env.CYOP_VAULT;
    delete process.env.CYOP_ITEM;
    delete process.env.CYOP_SESSION;
    delete process.env.C8Y_SESSION;
  });

  it('should replace direct op:// path', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        MY_SECRET: 'op://vault1/item1/field1',
        MY_SECRET_SPACES: '    op://vault1/item1/field1  ',
        MY_SECRET_TITLE: 'op://vault1/Item 1/Field 1',
        MY_SECRET_TITLE_PACES: '    op://vault1/Item 1/Field 1  ',
      },
    };

    mockItemGet.mockResolvedValue({
      id: 'item1',
      label: 'Item 1',
      vault: { id: 'vault1', name: 'Vault 1' },
      fields: [{ id: 'field1', label: 'Field 1', value: 'secretValue123' }],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.MY_SECRET).toBe('secretValue123');
    expect(updatedConfig.env.MY_SECRET_SPACES).toBe('secretValue123');
    expect(updatedConfig.env.MY_SECRET).toBe('secretValue123');
    expect(updatedConfig.env.MY_SECRET_SPACES).toBe('secretValue123');
    expect(updatedConfig.env.MY_SECRET_TITLE).toBe('secretValue123');
    expect(updatedConfig.env.MY_SECRET_TITLE_PACES).toBe('secretValue123');
    expect(mockItemGet).toHaveBeenCalledWith('item1', { vault: 'vault1' });
  });

  it('should replace {{op://...}} placeholders', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        API_URL: 'https://api.example.com/{{op://v/i/f_api_key}}',
        API_URL_SPACES: 'https://api.example.com/{{ op://v/i/f_api_key     }}',
      },
    };

    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Test Item',
      vault: { id: 'v', name: 'Test Vault' },
      fields: [{ id: 'f_api_key', label: 'API Key', value: 'myApiKey' }],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.API_URL).toBe('https://api.example.com/myApiKey');
    expect(updatedConfig.env.API_URL_SPACES).toBe(
      'https://api.example.com/myApiKey'
    );
    expect(mockItemGet).toHaveBeenCalledWith('i', { vault: 'v' });
  });

  it('should prioritize label match over ID match if both could match the specifier', async () => {
    // This scenario is a bit contrived as labels and IDs usually differ more significantly
    // or the specifier would be more unique. But tests the prioritization.
    const mockConfig: MockCypressConfig = {
      env: {
        AMBIGUOUS_SECRET: 'op://v/i/MatchThis',
      },
    };
    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Item With Ambiguous Field',
      vault: { id: 'v', name: 'Vault' },
      fields: [
        {
          id: 'field_id_not_this',
          label: 'MatchThis',
          value: 'valueFromLabelPriority',
        },
        {
          id: 'MatchThis',
          label: 'Some Other Label',
          value: 'valueFromIdSecondary',
        },
      ],
    });
    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.AMBIGUOUS_SECRET).toBe('valueFromLabelPriority');
  });

  it('should handle multiple placeholders in a single string value', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        CONNECTION_STRING:
          'user={{op://v/i/username}}&pass={{  op://v/i/password  }}',
      },
    };

    mockItemGet.mockResolvedValueOnce({
      // Should be called once and then cached
      id: 'i',
      title: 'Item',
      vault: { id: 'v', name: 'Vault' },
      fields: [
        { id: 'uname', label: 'username', value: 'testUser' },
        { id: 'pwd', label: 'password', value: 'testPass' },
      ],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.CONNECTION_STRING).toBe(
      'user=testUser&pass=testPass'
    );
    expect(mockItemGet).toHaveBeenCalledWith('i', { vault: 'v' });
    expect(mockItemGet).toHaveBeenCalledTimes(1);
  });

  it('should handle field specifier with section (section.field)', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        // use label
        SECTION_SECRET: 'op://v/i/section1.field_in_section',
        // use id
        SECTION_ID_SECRET: 'op://v/i/s1.field_in_section',
      },
    };

    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Item With Sections',
      vault: { id: 'v', name: 'Vault' },
      fields: [
        {
          id: 'f1',
          label: 'field_in_section',
          value: 'sectionSecretValue',
          section: { id: 's1', label: 'section1' },
        },
      ],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.SECTION_SECRET).toBe('sectionSecretValue');
    expect(updatedConfig.env.SECTION_ID_SECRET).toBe('sectionSecretValue');
    expect(mockItemGet).toHaveBeenCalledTimes(1);
    expect(mockItemGet).toHaveBeenCalledWith('i', { vault: 'v' });
  });

  it('should find field by label in section.field format', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        SECTION_SECRET_LABEL: 'op://v/i/My Section.My Field Label',
      },
    };
    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Item With Section Label Field',
      vault: { id: 'v', name: 'Vault' },
      fields: [
        {
          id: 'f_id_section',
          label: 'My Field Label',
          value: 'valueFromSectionLabel',
          section: { id: 's_id', label: 'My Section' },
        },
      ],
    });
    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.SECTION_SECRET_LABEL).toBe(
      'valueFromSectionLabel'
    );
  });

  it('should find field by ID in section.field format when labels differ', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        SECTION_SECRET_ID: 'op://v/i/section_id_abc.field_id_xyz',
      },
    };
    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Item With Section ID Field',
      vault: { id: 'v', name: 'Vault' },
      fields: [
        {
          id: 'field_id_xyz',
          label: 'Some Other Field Label',
          value: 'valueFromSectionId',
          section: {
            id: 'section_id_abc',
            label: 'Some Other Section Label',
          },
        },
      ],
    });
    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.SECTION_SECRET_ID).toBe('valueFromSectionId');
  });

  it('should handle special "url" field specifiers', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        WEBSITE_URL: 'op://v/i/url',
        WEBSITE_SITE: 'op://v/i/website',
      },
    };

    mockItemGet.mockResolvedValue({
      id: 'i',
      title: 'Item With URL',
      vault: { id: 'v', name: 'Vault' },
      fields: [], // No direct field named 'url'
      urls: [{ primary: true, href: 'https://primary.example.com' }],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.WEBSITE_URL).toBe('https://primary.example.com');
    expect(updatedConfig.env.WEBSITE_SITE).toBe('https://primary.example.com');
  });

  it('should return original config if CLI validation fails', async () => {
    const originalError = console.error;
    console.error = jest.fn(); // Suppress error logging for this test

    mockValidateCli.mockRejectedValue(new Error('CLI not found'));
    const mockConfig: MockCypressConfig = {
      env: {
        MY_SECRET: 'op://vault1/item1/field1',
      },
    };

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig).toEqual(mockConfig); // Should be the original config
    expect(mockItemGet).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[cypress-1password] 1Password CLI validation failed. Plugin will not load secrets. Error: CLI not found'
    );
    console.error = originalError; // Restore original console.error
  });

  it('should use cached value for identical op:// paths in placeholders within the same string', async () => {
    const mockConfig: MockCypressConfig = {
      env: {
        REPEATED_SECRET:
          'Value is {{op://v/i/secret_a}} and again {{op://v/i/secret_a}}',
      },
    };

    mockItemGet.mockResolvedValueOnce({
      // Should only be called once for secret_a
      id: 'i',
      title: 'Item A',
      vault: { id: 'v', name: 'Vault' },
      fields: [{ id: 'sa', label: 'secret_a', value: 'Alpha' }],
    });

    const updatedConfig = await testResolve(mockConfig as any);
    expect(updatedConfig.env.REPEATED_SECRET).toBe(
      'Value is Alpha and again Alpha'
    );
    expect(mockItemGet).toHaveBeenCalledWith('i', { vault: 'v' });
    expect(mockItemGet).toHaveBeenCalledTimes(1); // Crucial check for caching
  });

  describe('Error Handling and Edge Cases for op:// paths', () => {
    it('should throw error if failOnError is true (default) and secret not found', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          MISSING_SECRET: 'op://v/i/nonexistent_field',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'i',
        title: 'Item',
        vault: { id: 'v', name: 'Vault' },
        fields: [{ id: 'f1', label: 'some_field', value: 'val' }],
      });

      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Field "nonexistent_field" not found or value is null/undefined in item "Item" (ID: i, path "op://v/i/nonexistent_field").'
      );
    });

    it('should warn and not replace if failOnError is false and secret not found', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();

      const mockConfig: MockCypressConfig = {
        env: {
          MISSING_SECRET: 'op://v/i/nonexistent_field',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'i',
        title: 'Item',
        vault: { id: 'v', name: 'Vault' },
        fields: [{ id: 'f1', label: 'some_field', value: 'val' }],
      });

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.MISSING_SECRET).toBe(
        'op://v/i/nonexistent_field'
      );
      expect(console.warn).toHaveBeenCalledWith(
        '[cypress-1password] Field "nonexistent_field" not found or value is null/undefined in item "Item" (ID: i, path "op://v/i/nonexistent_field").'
      );
      console.warn = originalWarn; // Restore original console.warn
    });

    it('should throw error for invalid op:// path format (too few parts)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          INVALID_PATH: 'op://vault/item', // Missing field
        },
      };
      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Cannot resolve path for env var "INVALID_PATH" (path: "op://vault/item").'
      );
      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.INVALID_PATH).toBe('op://vault/item');
    });

    it('should throw error for invalid op:// path format (empty parts)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          INVALID_PATH: 'op://vault//field', // Empty item
        },
      };
      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Cannot resolve path for env var "INVALID_PATH" (path: "op://vault//field").'
      );
      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.INVALID_PATH).toBe('op://vault//field');
    });

    it('should warn and not replace placeholder if item.get fails and failOnError is false', async () => {
      const originalError = console.error; // Changed from console.warn
      console.error = jest.fn(); // Changed from console.warn
      const mockConfig: MockCypressConfig = {
        env: {
          FAIL_SECRET_PLACEHOLDER: 'Value: {{ op://v/i/f }}',
        },
      };
      mockItemGet.mockRejectedValue(new Error('1Password API error'));
      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.FAIL_SECRET_PLACEHOLDER).toBe(
        'Value: {{ op://v/i/f }}'
      );
      // getAndFindSecretValue logs the primary error
      expect(console.error).toHaveBeenCalledWith(
        // Changed from console.warn
        '[cypress-1password] Failed to load secret for path "op://v/i/f" (Item: "i", Vault: "v"): 1Password API error'
      );
      // replacePlaceholders also logs a debug message about not replacing, but the user-facing warning is the one above.
      console.error = originalError; // Changed from console.warn
    });
  });

  describe('CYOP_VAULT and CYOP_ITEM environment variable handling', () => {
    it('should use CYOP_VAULT and CYOP_ITEM for partial paths', async () => {
      process.env.CYOP_VAULT = 'shared_vault';
      process.env.CYOP_ITEM = 'shared_item';

      const mockConfig: MockCypressConfig = {
        env: {
          DB_PASSWORD: 'op://password_field',
          TOKEN: '{{ op://token_field }}',
        },
      };

      // Mock for both DB_PASSWORD and TOKEN - should only be called once
      mockItemGet.mockResolvedValueOnce({
        id: 'shared_item',
        title: 'Shared Item',
        vault: { id: 'shared_vault', name: 'Shared Vault' },
        fields: [
          { id: 'pw', label: 'password_field', value: 'dbPass123' },
          { id: 'tok', label: 'token_field', value: 'authTokenXYZ' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.DB_PASSWORD).toBe('dbPass123');
      expect(updatedConfig.env.TOKEN).toBe('authTokenXYZ');
      expect(mockItemGet).toHaveBeenCalledWith('shared_item', {
        vault: 'shared_vault',
      });
      expect(mockItemGet).toHaveBeenCalledTimes(1);
    });

    it('should correctly resolve path when CYOP_VAULT is in Cypress env but not process.env', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'cypress_vault_env',
          MY_SECRET: 'op://item_from_code/field_from_code',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'item_from_code',
        title: 'Item From Code',
        vault: { id: 'cypress_vault_env', name: 'Cypress Vault Env' },
        fields: [
          { id: 'f1', label: 'field_from_code', value: 'secretValue456' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('secretValue456');
      expect(mockItemGet).toHaveBeenCalledWith('item_from_code', {
        vault: 'cypress_vault_env',
      });
    });

    it('should correctly resolve path when CYOP_ITEM is in Cypress env but not process.env', async () => {
      process.env.CYOP_VAULT = 'process_vault'; // Set vault through process.env
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_ITEM: 'cypress_item_env',
          MY_SECRET: 'op://field_from_code_only',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'cypress_item_env',
        title: 'Cypress Item Env',
        vault: { id: 'process_vault', name: 'Process Vault' },
        fields: [
          { id: 'f1', label: 'field_from_code_only', value: 'secretValue789' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('secretValue789');
      expect(mockItemGet).toHaveBeenCalledWith('cypress_item_env', {
        vault: 'process_vault',
      });
    });

    it('should prefer CYOP variables from Cypress env over process.env', async () => {
      process.env.CYOP_VAULT = 'process_vault_ignored';
      process.env.CYOP_ITEM = 'process_item_ignored';

      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'cypress_vault_preferred',
          CYOP_ITEM: 'cypress_item_preferred',
          MY_SECRET: 'op://field_short_path',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'cypress_item_preferred',
        title: 'Cypress Item Preferred',
        vault: {
          id: 'cypress_vault_preferred',
          name: 'Cypress Vault Preferred',
        },
        fields: [
          {
            id: 'f_short',
            label: 'field_short_path',
            value: 'preferredSecret',
          },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('preferredSecret');
      expect(mockItemGet).toHaveBeenCalledWith('cypress_item_preferred', {
        vault: 'cypress_vault_preferred',
      });
    });

    it('should throw if CYOP_VAULT is present but empty and path requires vault', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: '', // Empty
          MY_SECRET: 'op://item/field',
        },
      };
      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Cannot resolve path for env var "MY_SECRET" (path: "op://item/field")'
      );
    });

    it('should warn and not replace if CYOP_VAULT is empty, path requires vault, and failOnError is false', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: '', // Empty
          MY_SECRET: 'op://item/field',
        },
      };
      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.MY_SECRET).toBe('op://item/field');
      expect(console.warn).toHaveBeenCalledWith(
        '[cypress-1password] CYOP_VAULT missing for partial path "op://item/field" (op://item/field).'
      );
      console.warn = originalWarn;
    });

    it('should throw if CYOP_ITEM is present but empty and path requires item', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'v',
          CYOP_ITEM: '', // Empty
          MY_SECRET: 'op://field',
        },
      };
      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Cannot resolve path for env var "MY_SECRET" (path: "op://field")'
      );
    });

    it('should warn and not replace if CYOP_ITEM is empty, path requires item, and failOnError is false', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'v',
          CYOP_ITEM: '', // Empty
          MY_SECRET: 'op://field',
        },
      };
      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.MY_SECRET).toBe('op://field');
      expect(console.warn).toHaveBeenCalledWith(
        '[cypress-1password] Could not determine vault, item and field for "op://field".'
      );
      console.warn = originalWarn;
    });

    it('should use process.env.CYOP_VAULT if Cypress env CYOP_VAULT is undefined', async () => {
      process.env.CYOP_VAULT = 'proc_vault';
      const mockConfig: MockCypressConfig = {
        env: {
          // CYOP_VAULT is not in Cypress env
          MY_SECRET: 'op://item1/field1',
        },
      };
      mockItemGet.mockResolvedValue({
        id: 'item1',
        title: 'Item 1',
        vault: { id: 'proc_vault', name: 'Proc Vault' },
        fields: [{ id: 'f1', label: 'field1', value: 'val1' }],
      });
      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('val1');
      expect(mockItemGet).toHaveBeenCalledWith('item1', {
        vault: 'proc_vault',
      });
      delete process.env.CYOP_VAULT;
    });

    it('should use process.env.CYOP_ITEM if Cypress env CYOP_ITEM is undefined', async () => {
      process.env.CYOP_VAULT = 'proc_vault';
      process.env.CYOP_ITEM = 'proc_item';
      const mockConfig: MockCypressConfig = {
        env: {
          // CYOP_ITEM is not in Cypress env
          MY_SECRET: 'op://field1',
        },
      };
      mockItemGet.mockResolvedValue({
        id: 'proc_item',
        title: 'Proc Item',
        vault: { id: 'proc_vault', name: 'Proc Vault' },
        fields: [{ id: 'f1', label: 'field1', value: 'val1' }],
      });
      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('val1');
      expect(mockItemGet).toHaveBeenCalledWith('proc_item', {
        vault: 'proc_vault',
      });
      delete process.env.CYOP_VAULT;
      delete process.env.CYOP_ITEM;
    });
  });

  describe('Multiple Vault Support', () => {
    it('should support comma-separated vault list in CYOP_VAULT', async () => {
      process.env.CYOP_VAULT = 'personal,team,shared';

      const mockConfig: MockCypressConfig = {
        env: {
          SECRET: 'op://test-item/password',
        },
      };

      // Mock first vault to fail, second vault to succeed
      mockItemGet
        .mockRejectedValueOnce(new Error('Item not found in personal vault'))
        .mockResolvedValueOnce({
          id: 'test-item',
          title: 'Test Item',
          vault: { id: 'team', name: 'Team Vault' },
          fields: [{ id: 'pwd', label: 'password', value: 'teamSecret123' }],
        });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET).toBe('teamSecret123');

      // Should have tried personal vault first, then team vault
      expect(mockItemGet).toHaveBeenCalledWith('test-item', {
        vault: 'personal',
      });
      expect(mockItemGet).toHaveBeenCalledWith('test-item', { vault: 'team' });
      expect(mockItemGet).toHaveBeenCalledTimes(2);
    });

    it('should support array vault list in Cypress env CYOP_VAULT', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: ['vault1', 'vault2', 'vault3'],
          SECRET: 'op://shared-item/token',
        },
      };

      // Mock first two vaults to fail, third vault to succeed
      mockItemGet
        .mockRejectedValueOnce(new Error('Not found in vault1'))
        .mockRejectedValueOnce(new Error('Not found in vault2'))
        .mockResolvedValueOnce({
          id: 'shared-item',
          title: 'Shared Item',
          vault: { id: 'vault3', name: 'Vault 3' },
          fields: [{ id: 'tok', label: 'token', value: 'vault3Token' }],
        });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET).toBe('vault3Token');

      // Should have tried all three vaults in order
      expect(mockItemGet).toHaveBeenCalledWith('shared-item', {
        vault: 'vault1',
      });
      expect(mockItemGet).toHaveBeenCalledWith('shared-item', {
        vault: 'vault2',
      });
      expect(mockItemGet).toHaveBeenCalledWith('shared-item', {
        vault: 'vault3',
      });
      expect(mockItemGet).toHaveBeenCalledTimes(3);
    });

    it('should cache failures per vault when trying multiple vaults', async () => {
      process.env.CYOP_VAULT = 'vault1,vault2';

      const mockConfig: MockCypressConfig = {
        env: {
          SECRET1: 'op://missing-item/field1',
          SECRET2: 'op://missing-item/field2', // Same item, different field
        },
      };

      // Mock both vaults to fail for the item
      mockItemGet
        .mockRejectedValueOnce(new Error('Not found in vault1'))
        .mockRejectedValueOnce(new Error('Not found in vault2'));

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });

      // Both secrets should remain unchanged
      expect(updatedConfig.env.SECRET1).toBe('op://missing-item/field1');
      expect(updatedConfig.env.SECRET2).toBe('op://missing-item/field2');

      // Should only call item.get twice (once per vault) for the first secret,
      // and use cached failures for the second secret
      expect(mockItemGet).toHaveBeenCalledTimes(2);
      expect(mockItemGet).toHaveBeenCalledWith('missing-item', {
        vault: 'vault1',
      });
      expect(mockItemGet).toHaveBeenCalledWith('missing-item', {
        vault: 'vault2',
      });
    });

    it('should handle mixed comma-separated and array format correctly', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'vault1, vault2,vault3 ,vault4', // Mixed spacing
          SECRET: 'op://test-item/password',
        },
      };

      // Mock to succeed on vault3
      mockItemGet
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce({
          id: 'test-item',
          title: 'Test Item',
          vault: { id: 'vault3', name: 'Vault 3' },
          fields: [{ id: 'pwd', label: 'password', value: 'foundSecret' }],
        });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET).toBe('foundSecret');

      // Should properly parse and try vaults with trimmed names
      expect(mockItemGet).toHaveBeenCalledWith('test-item', {
        vault: 'vault1',
      });
      expect(mockItemGet).toHaveBeenCalledWith('test-item', {
        vault: 'vault2',
      });
      expect(mockItemGet).toHaveBeenCalledWith('test-item', {
        vault: 'vault3',
      });
      expect(mockItemGet).toHaveBeenCalledTimes(3);
    });

    it('should provide detailed error message when all vaults fail', async () => {
      const originalError = console.error;
      console.error = jest.fn();

      process.env.CYOP_VAULT = 'vault1,vault2,vault3';

      const mockConfig: MockCypressConfig = {
        env: {
          SECRET: 'op://missing-item/field',
        },
      };

      // Mock all vaults to fail
      mockItemGet
        .mockRejectedValueOnce(new Error('Vault1 error'))
        .mockRejectedValueOnce(new Error('Vault2 error'))
        .mockRejectedValueOnce(new Error('Vault3 error'));

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.SECRET).toBe('op://missing-item/field');

      // Should show multi-vault error format
      expect(console.error).toHaveBeenCalledWith(
        '[cypress-1password] Failed to load secret for path "op://missing-item/field" (Item: "missing-item") after trying all vaults [vault1, vault2, vault3]. Last error: Vault3 error'
      );

      console.error = originalError;
    });

    it('should handle placeholders with multiple vaults', async () => {
      process.env.CYOP_VAULT = 'personal,shared';

      const mockConfig: MockCypressConfig = {
        env: {
          DATABASE_URL: 'postgresql://user:{{op://db-creds/password}}@host/db',
        },
      };

      // Mock personal vault to fail, shared vault to succeed
      mockItemGet
        .mockRejectedValueOnce(new Error('Not in personal'))
        .mockResolvedValueOnce({
          id: 'db-creds',
          title: 'DB Credentials',
          vault: { id: 'shared', name: 'Shared Vault' },
          fields: [{ id: 'pwd', label: 'password', value: 'dbpass123' }],
        });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.DATABASE_URL).toBe(
        'postgresql://user:dbpass123@host/db'
      );

      expect(mockItemGet).toHaveBeenCalledWith('db-creds', {
        vault: 'personal',
      });
      expect(mockItemGet).toHaveBeenCalledWith('db-creds', { vault: 'shared' });
      expect(mockItemGet).toHaveBeenCalledTimes(2);
    });
  });

  describe('Handling of non-string and empty config.env values', () => {
    it('should ignore non-string values in config.env', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          STRING_SECRET: 'op://v/i/f',
          NUMBER_VALUE: 123,
          BOOLEAN_VALUE: true,
          OBJECT_VALUE: { key: 'value' },
          NULL_VALUE: null,
          UNDEFINED_VALUE: undefined,
        },
      };
      mockItemGet.mockResolvedValue({
        id: 'i',
        title: 'Item',
        vault: { id: 'v', name: 'Vault' },
        fields: [{ id: 'f_id', label: 'f', value: 'secret' }],
      });
      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.STRING_SECRET).toBe('secret');
      expect(updatedConfig.env.NUMBER_VALUE).toBe(123);
      expect(updatedConfig.env.BOOLEAN_VALUE).toBe(true);
      expect(updatedConfig.env.OBJECT_VALUE).toEqual({ key: 'value' });
      expect(updatedConfig.env.NULL_VALUE).toBeNull();
      expect(updatedConfig.env.UNDEFINED_VALUE).toBeUndefined();
      expect(mockItemGet).toHaveBeenCalledTimes(1); // Only called for STRING_SECRET
    });

    it('should handle empty config.env without errors', async () => {
      const mockConfigEmpty: MockCypressConfig = {
        env: {},
      };
      let updatedConfig = await testResolve(mockConfigEmpty as any);
      expect(updatedConfig.env).toEqual({});
      expect(mockItemGet).not.toHaveBeenCalled();

      const mockConfigUndefined: MockCypressConfig = {}; // env is undefined
      updatedConfig = await testResolve(mockConfigUndefined as any);
      expect(updatedConfig.env).toBeUndefined();
      expect(mockItemGet).not.toHaveBeenCalled();
    });

    it('should not attempt to process CYOP_ prefixed env vars if they are not strings', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 123, // Not a string
          MY_SECRET: 'op://item/field', // This would normally use CYOP_VAULT
        },
      };
      // If CYOP_VAULT is not a string, it's ignored by resolveSecretPath.
      // Then, "op://item/field" is treated as a partial path missing CYOP_VAULT.
      // resolveSecretPath returns null, and loadOpSecrets (with failOnError=true) throws.
      await expect(testResolve(mockConfig as any)).rejects.toThrow(
        '[cypress-1password] Cannot resolve path for env var "MY_SECRET" (path: "op://item/field").'
      );
    });
  });

  describe('Iterative Caching Mechanism', () => {
    it('should cache items and reuse them when accessed by different identifiers (ID vs title)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          // First access by item ID and vault ID
          SECRET_BY_ID: 'op://vault_id_123/item_id_456/field1',
          // Second access by item title and vault name for the same item
          SECRET_BY_TITLE: 'op://Test Vault/Test Item/field2',
        },
      };

      // Mock the item.get call - should only be called once
      mockItemGet.mockResolvedValueOnce({
        id: 'item_id_456',
        title: 'Test Item',
        vault: { id: 'vault_id_123', name: 'Test Vault' },
        fields: [
          { id: 'f1', label: 'field1', value: 'value1' },
          { id: 'f2', label: 'field2', value: 'value2' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET_BY_ID).toBe('value1');
      expect(updatedConfig.env.SECRET_BY_TITLE).toBe('value2');

      // Critical: item.get should only be called once despite two different paths
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('item_id_456', {
        vault: 'vault_id_123',
      });
    });

    it('should cache items across placeholders in the same string and direct op:// paths', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          // Direct op:// path using item ID
          DIRECT_SECRET: 'op://vault_id_123/item_id_456/username',
          // Placeholder using item title for the same item
          COMBINED_STRING:
            'user={{op://Test Vault/Test Item/username}}&pass={{op://vault_id_123/item_id_456/password}}',
        },
      };

      // Mock the item.get call - should only be called once
      mockItemGet.mockResolvedValueOnce({
        id: 'item_id_456',
        title: 'Test Item',
        vault: { id: 'vault_id_123', name: 'Test Vault' },
        fields: [
          { id: 'user', label: 'username', value: 'testuser' },
          { id: 'pass', label: 'password', value: 'testpass' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.DIRECT_SECRET).toBe('testuser');
      expect(updatedConfig.env.COMBINED_STRING).toBe(
        'user=testuser&pass=testpass'
      );

      // Critical: item.get should only be called once despite multiple references
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('item_id_456', {
        vault: 'vault_id_123',
      });
    });
    it('should cache and reuse item fetch failures', async () => {
      const originalError = console.error;
      console.error = jest.fn();

      const mockConfig: MockCypressConfig = {
        env: {
          // First access by item ID
          SECRET_BY_ID: 'op://vault1/nonexistent_item/field1',
          // Second access using the same identifiers
          SECRET_BY_ID_AGAIN: 'op://vault1/nonexistent_item/field2',
        },
      };

      // Mock item.get to fail - should only be called once
      mockItemGet.mockRejectedValueOnce(new Error('Item not found'));

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.SECRET_BY_ID).toBe(
        'op://vault1/nonexistent_item/field1'
      );
      expect(updatedConfig.env.SECRET_BY_ID_AGAIN).toBe(
        'op://vault1/nonexistent_item/field2'
      );

      // Critical: item.get should only be called once despite two failed accesses
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('nonexistent_item', {
        vault: 'vault1',
      });

      // Should log error for both attempts but only fetch once
      expect(console.error).toHaveBeenCalledWith(
        '[cypress-1password] Failed to load secret for path "op://vault1/nonexistent_item/field1" (Item: "nonexistent_item", Vault: "vault1"): Item not found'
      );

      console.error = originalError;
    });

    it('should handle case-insensitive matching for vault and item names', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          // Access with exact case
          SECRET_EXACT: 'op://Test Vault/Test Item/field1',
          // Access with different case but same item
          SECRET_LOWER: 'op://test vault/test item/field2',
          // Access with mixed case
          SECRET_MIXED: 'op://TEST VAULT/TEST ITEM/field3',
        },
      };

      // Mock the item.get call - should only be called once
      mockItemGet.mockResolvedValueOnce({
        id: 'item123',
        title: 'Test Item',
        vault: { id: 'vault123', name: 'Test Vault' },
        fields: [
          { id: 'f1', label: 'field1', value: 'value1' },
          { id: 'f2', label: 'field2', value: 'value2' },
          { id: 'f3', label: 'field3', value: 'value3' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET_EXACT).toBe('value1');
      expect(updatedConfig.env.SECRET_LOWER).toBe('value2');
      expect(updatedConfig.env.SECRET_MIXED).toBe('value3');

      // Critical: item.get should only be called once due to case-insensitive cache matching
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('Test Item', {
        vault: 'Test Vault',
      });
    });

    it('should cache items when using CYOP_VAULT and CYOP_ITEM environment variables', async () => {
      process.env.CYOP_VAULT = 'shared_vault';
      process.env.CYOP_ITEM = 'shared_item';

      const mockConfig: MockCypressConfig = {
        env: {
          // Partial paths using CYOP environment variables
          SECRET1: 'op://field1',
          SECRET2: 'op://field2',
          // Full path to same item using IDs
          SECRET3: 'op://vault_id_456/item_id_123/field3',
        },
      };

      // Mock the item.get call - should only be called once
      mockItemGet.mockResolvedValueOnce({
        id: 'item_id_123',
        title: 'shared_item',
        vault: { id: 'vault_id_456', name: 'shared_vault' },
        fields: [
          { id: 'f1', label: 'field1', value: 'value1' },
          { id: 'f2', label: 'field2', value: 'value2' },
          { id: 'f3', label: 'field3', value: 'value3' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET1).toBe('value1');
      expect(updatedConfig.env.SECRET2).toBe('value2');
      expect(updatedConfig.env.SECRET3).toBe('value3');

      // Critical: item.get should only be called once despite different path formats
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('shared_item', {
        vault: 'shared_vault',
      });
    });

    it('should distinguish between different items and not incorrectly cache', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          SECRET_ITEM1: 'op://vault1/item1/field1',
          SECRET_ITEM2: 'op://vault1/item2/field1',
          SECRET_ITEM1_AGAIN: 'op://Vault One/Item One/field2', // Same as first item but different identifiers
        },
      };

      // Mock first item
      mockItemGet.mockResolvedValueOnce({
        id: 'item1',
        title: 'Item One',
        vault: { id: 'vault1', name: 'Vault One' },
        fields: [
          { id: 'f1', label: 'field1', value: 'item1_value1' },
          { id: 'f2', label: 'field2', value: 'item1_value2' },
        ],
      });

      // Mock second item
      mockItemGet.mockResolvedValueOnce({
        id: 'item2',
        title: 'Item Two',
        vault: { id: 'vault1', name: 'Vault One' },
        fields: [{ id: 'f1', label: 'field1', value: 'item2_value1' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.SECRET_ITEM1).toBe('item1_value1');
      expect(updatedConfig.env.SECRET_ITEM2).toBe('item2_value1');
      expect(updatedConfig.env.SECRET_ITEM1_AGAIN).toBe('item1_value2'); // Should use cached item1

      // Should be called twice: once for item1, once for item2
      expect(mockItemGet).toHaveBeenCalledTimes(2);
      expect(mockItemGet).toHaveBeenCalledWith('item1', { vault: 'vault1' });
      expect(mockItemGet).toHaveBeenCalledWith('item2', { vault: 'vault1' });
    });

    it('should cache failures and not retry failed item fetches', async () => {
      const originalError = console.error;
      console.error = jest.fn();

      const mockConfig: MockCypressConfig = {
        env: {
          SECRET1: 'op://vault1/failing_item/field1',
          SECRET2: 'op://vault1/failing_item/field2', // Same vault and item identifiers
          SECRET3: 'op://vault1/failing_item/field3', // Same vault and item identifiers
        },
      };

      // Mock item.get to fail - should only be called once
      mockItemGet.mockRejectedValueOnce(new Error('Network timeout'));

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.SECRET1).toBe('op://vault1/failing_item/field1');
      expect(updatedConfig.env.SECRET2).toBe('op://vault1/failing_item/field2');
      expect(updatedConfig.env.SECRET3).toBe('op://vault1/failing_item/field3');

      // Critical: item.get should only be called once and then cached failure used
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('failing_item', {
        vault: 'vault1',
      });

      console.error = originalError;
    });
  });

  describe('Session URI Support', () => {
    beforeEach(() => {
      // Clear session environment variables
      delete process.env.C8Y_SESSION;
      delete process.env.CYOP_SESSION;
    });

    it('should use C8Y_SESSION for field-only path when CYOP_VAULT and CYOP_ITEM are not set', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          C8Y_SESSION: 'op://TestVault/TestItem',
          MY_FIELD: 'op://password',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [{ id: 'pwd', label: 'password', value: 'secretPassword123' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_FIELD).toBe('secretPassword123');
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should use target_url for url/website from CYOP_SESSION', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          C8Y_SESSION: 'op://TestVault/TestItem?target_url=https://example.com',
          C8Y_BASEURL: 'op://url',
          C8Y_HOST: 'op://website',
        },
      };
      mockItemGet.mockResolvedValue({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [{ id: 'pwd', label: 'password', value: 'secretPassword123' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.C8Y_BASEURL).toBe('https://example.com');
      expect(updatedConfig.env.C8Y_HOST).toBe('https://example.com');
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should use session URI for item/field path when CYOP_VAULT is not set', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION: 'op://SessionVault/SessionItem',
          MY_CREDENTIAL: 'op://MyItem/username',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'MyItem',
        title: 'My Item',
        vault: { id: 'SessionVault', name: 'Session Vault' },
        fields: [{ id: 'user', label: 'username', value: 'myuser' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_CREDENTIAL).toBe('myuser');
      expect(mockItemGet).toHaveBeenCalledWith('MyItem', {
        vault: 'SessionVault',
      });
    });

    it('should prioritize session URI over CYOP_VAULT when session provides vault/item', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'PriorityVault',
          CYOP_SESSION: 'op://SessionVault/SessionItem',
          MY_SECRET: 'op://password', // Field-only path to use session item
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'SessionItem',
        title: 'Session Item',
        vault: { id: 'SessionVault', name: 'Session Vault' },
        fields: [{ id: 'pwd', label: 'password', value: 'sessionPassword' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('sessionPassword');
      expect(mockItemGet).toHaveBeenCalledWith('SessionItem', {
        vault: 'SessionVault',
      });
    });

    it('should prioritize session URI over CYOP_ITEM when session provides vault/item', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'PriorityVault',
          CYOP_ITEM: 'PriorityItem',
          CYOP_SESSION: 'op://SessionVault/SessionItem',
          MY_SECRET: 'op://token', // Field-only path to use session vault/item
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'SessionItem',
        title: 'Session Item',
        vault: { id: 'SessionVault', name: 'Session Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'sessionToken' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('sessionToken');
      expect(mockItemGet).toHaveBeenCalledWith('SessionItem', {
        vault: 'SessionVault',
      });
    });

    it('should use target_url over item url for url/website from CYOP_SESSION', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          C8Y_SESSION:
            'op://TestVault/TestItem?target_url=https%3A%2F%2Fexample.com',
          C8Y_BASEURL: 'op://url',
          C8Y_HOST: 'op://website',
        },
      };
      mockItemGet.mockResolvedValue({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [
          {
            id: 'pwd',
            label: 'password',
            value: 'secretPassword123',
            url: 'https://myexample.com',
          },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.C8Y_BASEURL).toBe('https://example.com');
      expect(updatedConfig.env.C8Y_HOST).toBe('https://example.com');
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should use CYOP_SESSION for field-only path when CYOP_VAULT and CYOP_ITEM are not set', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION: 'op://SessionVault/SessionItem',
          MY_SECRET: 'op://token',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'SessionItem',
        title: 'Session Item',
        vault: { id: 'SessionVault', name: 'Session Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'sessionToken456' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('sessionToken456');
      expect(mockItemGet).toHaveBeenCalledWith('SessionItem', {
        vault: 'SessionVault',
      });
    });

    it('should warn if session URI is invalid format', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();

      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION: 'op://invalid', // Missing item part
          MY_FIELD: 'op://password',
        },
      };

      const updatedConfig = await testResolve(mockConfig as any, {
        failOnError: false,
      });
      expect(updatedConfig.env.MY_FIELD).toBe('op://password');
      expect(console.warn).toHaveBeenCalledWith(
        '[cypress-1password] CYOP_VAULT missing for partial path "op://password" (op://item/field).'
      );
      expect(mockItemGet).not.toHaveBeenCalled();

      console.warn = originalWarn;
    });

    it('should support both C8Y_SESSION and CYOP_SESSION with C8Y_SESSION taking precedence', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION: 'op://CYOPVault/CYOPItem', // takes precedence
          C8Y_SESSION: 'op://C8YVault/C8YItem',
          MY_SECRET: 'op://token',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'C8YItem',
        title: 'C8Y Item',
        vault: { id: 'C8YVault', name: 'C8Y Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'c8yToken' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('c8yToken');
      expect(mockItemGet).toHaveBeenCalledWith('CYOPItem', {
        vault: 'CYOPVault',
      });
    });

    it('should work with session URI in placeholders', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION: 'op://SessionVault/SessionItem',
          API_URL: 'https://api.example.com/{{op://token}}',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'SessionItem',
        title: 'Session Item',
        vault: { id: 'SessionVault', name: 'Session Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'apiToken123' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.API_URL).toBe(
        'https://api.example.com/apiToken123'
      );
      expect(mockItemGet).toHaveBeenCalledWith('SessionItem', {
        vault: 'SessionVault',
      });
    });

    it('should prioritize target_url from session over item URL (including cached items)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION:
            'op://TestVault/TestItem?target_url=https%3A%2F%2Fsession-priority.com',
          // First request - should cache the item with its own URL
          FIRST_URL: 'op://url',
          // Second request - should use session target_url even though item is cached
          SECOND_URL: 'op://website',
        },
      };

      // Mock item with its own URL that should be overridden by session target_url
      mockItemGet.mockResolvedValueOnce({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [{ id: 'pwd', label: 'password', value: 'secretPassword123' }],
        urls: [
          { primary: true, href: 'https://item-url-should-be-ignored.com' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);

      // Both URL requests should use the session target_url, not the item's URL
      expect(updatedConfig.env.FIRST_URL).toBe('https://session-priority.com');
      expect(updatedConfig.env.SECOND_URL).toBe('https://session-priority.com');

      // Item should only be fetched once (cached for second request)
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should prioritize target_url from session over item URL in placeholders', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION:
            'op://TestVault/TestItem?target_url=https%3A%2F%2Fplaceholder-priority.com',
          API_ENDPOINT: 'Base URL: {{op://url}} and Site: {{op://website}}',
        },
      };

      // Mock item with its own URL that should be overridden by session target_url
      mockItemGet.mockResolvedValueOnce({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [{ id: 'api', label: 'api_key', value: 'key123' }],
        urls: [{ primary: true, href: 'https://item-url-ignored.com' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);

      // Both placeholders should use the session target_url
      expect(updatedConfig.env.API_ENDPOINT).toBe(
        'Base URL: https://placeholder-priority.com and Site: https://placeholder-priority.com'
      );

      // Item should only be fetched once (cached for both placeholders)
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should consistently prioritize session target_url over item URLs across all access patterns', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_SESSION:
            'op://TestVault/TestItem?target_url=https%3A%2F%2Fsession-url-priority.com',
          // Direct op:// path for URL field
          DIRECT_URL: 'op://url',
          // Direct op:// path for website field
          DIRECT_WEBSITE: 'op://website',
          // Placeholder for URL field
          PLACEHOLDER_URL: 'Config: {{op://url}}',
          // Placeholder for website field
          PLACEHOLDER_WEBSITE: 'Site: {{op://website}}',
          // Mixed placeholders in same string
          MIXED_PLACEHOLDERS: 'URL: {{op://url}} | Website: {{op://website}}',
          // Non-URL field to ensure item is properly cached
          PASSWORD_FIELD: 'op://password',
        },
      };

      // Mock item with multiple URL sources that should all be overridden by session target_url
      mockItemGet.mockResolvedValueOnce({
        id: 'TestItem',
        title: 'Test Item',
        vault: { id: 'TestVault', name: 'Test Vault' },
        fields: [
          { id: 'pwd', label: 'password', value: 'secretPassword123' },
          // URL field with value that should be ignored
          { id: 'url_field', label: 'url', value: 'https://field-url.com' },
          // Website field with value that should be ignored
          {
            id: 'site_field',
            label: 'website',
            value: 'https://field-website.com',
          },
        ],
        // Item URLs that should also be ignored
        urls: [
          { primary: true, href: 'https://primary-item-url.com' },
          { primary: false, href: 'https://secondary-item-url.com' },
        ],
      });

      const updatedConfig = await testResolve(mockConfig as any);

      // All URL-related fields should use session target_url
      expect(updatedConfig.env.DIRECT_URL).toBe(
        'https://session-url-priority.com'
      );
      expect(updatedConfig.env.DIRECT_WEBSITE).toBe(
        'https://session-url-priority.com'
      );
      expect(updatedConfig.env.PLACEHOLDER_URL).toBe(
        'Config: https://session-url-priority.com'
      );
      expect(updatedConfig.env.PLACEHOLDER_WEBSITE).toBe(
        'Site: https://session-url-priority.com'
      );
      expect(updatedConfig.env.MIXED_PLACEHOLDERS).toBe(
        'URL: https://session-url-priority.com | Website: https://session-url-priority.com'
      );

      // Non-URL field should work normally
      expect(updatedConfig.env.PASSWORD_FIELD).toBe('secretPassword123');

      // Item should only be fetched once despite multiple accesses
      expect(mockItemGet).toHaveBeenCalledTimes(1);
      expect(mockItemGet).toHaveBeenCalledWith('TestItem', {
        vault: 'TestVault',
      });
    });

    it('should fall back to CYOP_VAULT when session is incomplete (vault only)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'FallbackVault',
          CYOP_ITEM: 'FallbackItem',
          CYOP_SESSION: 'op://SessionVault', // Only vault, no item
          MY_SECRET: 'op://token',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'FallbackItem',
        title: 'Fallback Item',
        vault: { id: 'FallbackVault', name: 'Fallback Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'fallbackToken' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('fallbackToken');
      expect(mockItemGet).toHaveBeenCalledWith('FallbackItem', {
        vault: 'FallbackVault',
      });
    });

    it('should fall back to CYOP_VAULT when session is incomplete (invalid format)', async () => {
      const mockConfig: MockCypressConfig = {
        env: {
          CYOP_VAULT: 'FallbackVault',
          CYOP_ITEM: 'FallbackItem',
          CYOP_SESSION: 'invalid-session-format',
          MY_SECRET: 'op://token',
        },
      };

      mockItemGet.mockResolvedValue({
        id: 'FallbackItem',
        title: 'Fallback Item',
        vault: { id: 'FallbackVault', name: 'Fallback Vault' },
        fields: [{ id: 'tkn', label: 'token', value: 'fallbackToken' }],
      });

      const updatedConfig = await testResolve(mockConfig as any);
      expect(updatedConfig.env.MY_SECRET).toBe('fallbackToken');
      expect(mockItemGet).toHaveBeenCalledWith('FallbackItem', {
        vault: 'FallbackVault',
      });
    });
  });
});
