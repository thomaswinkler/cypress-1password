import { parseOpUri } from './opUri';

describe('parseOpUri', () => {
  describe('Valid URI formats', () => {
    it('should parse full three-part URI (op://vault/item/field)', () => {
      const expectedResult = {
        vault: 'MyVault',
        item: 'MyItem',
        field: 'MyField',
      };
      const result = parseOpUri('op://MyVault/MyItem/MyField', false);
      expect(result).toEqual(expectedResult);
      const resultTrue = parseOpUri('op://MyVault/MyItem/MyField', true);
      expect(resultTrue).toEqual(expectedResult);
    });

    it('should parse two-part URI (op://vault/item)', () => {
      const result = parseOpUri('op://MyItem/MyField', false);

      expect(result).toEqual({
        item: 'MyItem',
        field: 'MyField',
      });
    });

    it('should parse single-part URI (op://field)', () => {
      const result = parseOpUri('op://MyField', false);

      expect(result).toEqual({
        field: 'MyField',
      });
    });

    it('should handle URIs with spaces in parts', () => {
      const expectedResult = {
        vault: 'My Vault',
        item: 'My Item',
        field: 'My Field',
      };
      const result = parseOpUri('op://My Vault/My Item/My Field', false);
      expect(result).toEqual(expectedResult);
      const resultTrue = parseOpUri('op://My Vault/My Item/My Field', true);
      expect(resultTrue).toEqual(expectedResult);
    });

    it('should handle URIs with special characters', () => {
      const expectedResult = {
        vault: 'Vault-1',
        item: 'Item_2',
        field: 'Field.3',
      };
      const result = parseOpUri('op://Vault-1/Item_2/Field.3', false);
      expect(result).toEqual(expectedResult);
      const resultTrue = parseOpUri('op://Vault-1/Item_2/Field.3', true);
      expect(resultTrue).toEqual(expectedResult);
    });
  });

  describe('Invalid URI formats', () => {
    it('should return null for empty string', () => {
      const result = parseOpUri('', false);

      expect(result).toBeNull();
    });

    it('should return null for null input', () => {
      const result = parseOpUri(null as any, false);

      expect(result).toBeNull();
    });

    it('should return null for undefined input', () => {
      const result = parseOpUri(undefined as any, false);

      expect(result).toBeNull();
    });

    it('should return null for URI without op:// prefix', () => {
      const result = parseOpUri('vault/item/field', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with wrong protocol', () => {
      const result = parseOpUri('http://vault/item/field', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with only protocol', () => {
      const result = parseOpUri('op://', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with empty parts', () => {
      const result = parseOpUri('op://vault//field', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with only empty parts', () => {
      const result = parseOpUri('op://///', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with too many parts (more than 3)', () => {
      const result = parseOpUri('op://vault/item/field/extra', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with trailing slash', () => {
      const result = parseOpUri('op://vault/item/field/', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with leading slash in path', async () => {
      const result = parseOpUri('op:///vault/item/field', false);

      expect(result).toBeNull();
    });

    it('should return null for URI with only whitespace after protocol', () => {
      const result = parseOpUri('op://   ', false);
      expect(result).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should handle URI with numeric parts', () => {
      const result = parseOpUri('op://123/456/789', false);

      expect(result).toEqual({
        vault: '123',
        item: '456',
        field: '789',
      });
    });

    it('should handle URI with mixed alphanumeric and symbols', () => {
      const result = parseOpUri('op://vault@123/item#456/field$789', false);

      expect(result).toEqual({
        vault: 'vault@123',
        item: 'item#456',
        field: 'field$789',
      });
    });

    it('should handle very long part names', () => {
      const longName = 'a'.repeat(100);
      const result = parseOpUri(
        `op://${longName}/${longName}/${longName}`,
        false
      );

      expect(result).toEqual({
        vault: longName,
        item: longName,
        field: longName,
      });
    });

    it('should handle URI with Unicode characters', () => {
      const result = parseOpUri('op://🔐Vault/📁Item/🔑Field', false);

      expect(result).toEqual({
        vault: '🔐Vault',
        item: '📁Item',
        field: '🔑Field',
      });
    });

    it('should handle single character parts', () => {
      const result = parseOpUri('op://v/i/f', false);

      expect(result).toEqual({
        vault: 'v',
        item: 'i',
        field: 'f',
      });
    });
  });

  describe('URL parameter parsing', () => {
    it('should parse target_url parameter and URL decode it', () => {
      const result = parseOpUri(
        'op://vault/item/field?target_url=example.com',
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
        url: 'https://example.com',
      });
    });

    it('should parse target_url parameter with encoded URL', () => {
      const result = parseOpUri(
        'op://vault/item/field?target_url=https%3A%2F%2Fexample.com%2Fpath',
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
        url: 'https://example.com/path',
      });
    });

    it('should handle target_url with existing scheme', () => {
      const result = parseOpUri(
        'op://vault/item/field?target_url=http%3A%2F%2Fexample.com',
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
        url: 'http://example.com',
      });
    });

    it('should handle multiple query parameters', () => {
      const result = parseOpUri(
        'op://vault/item/field?target_url=example.com&other=value',
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
        url: 'https://example.com',
      });
    });

    it('should work with partial URIs and target_url', () => {
      const result = parseOpUri('op://field?target_url=example.com', false);

      expect(result).toEqual({
        field: 'field',
        url: 'https://example.com',
      });
    });

    it('should handle empty target_url parameter', () => {
      const result = parseOpUri('op://vault/item/field?target_url=', false);

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
      });
    });

    it('should handle malformed URL encoding gracefully', () => {
      const result = parseOpUri(
        'op://vault/item/field?target_url=%invalid%',
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
      });
    });

    it('should work with session URIs and target_url', () => {
      const result = parseOpUri('op://vault/item?target_url=example.com', true);

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        url: 'https://example.com',
      });
    });

    it('should handle complex URLs with special characters', () => {
      const encodedUrl = encodeURIComponent(
        'https://example.com/path?param=value&other=test#fragment'
      );
      const result = parseOpUri(
        `op://vault/item/field?target_url=${encodedUrl}`,
        false
      );

      expect(result).toEqual({
        vault: 'vault',
        item: 'item',
        field: 'field',
        url: 'https://example.com/path?param=value&other=test#fragment',
      });
    });
  });
});
