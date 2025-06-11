// filepath: /Users/twi/Projects/cy-onepassword/src/index.ts
import debug from 'debug';
import { OpResolver, type CyOpPluginOptions } from './OpResolver';
import { type OpUri } from './opUri';
import { setConnect, setServiceAccount } from '@1password/op-js';

// Re-export the main functions and types for backward compatibility
export { OpResolver };
export type { CyOpPluginOptions, OpUri };

// Default export for backward compatibility
export default async (
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  pluginOptions?: CyOpPluginOptions
): Promise<Cypress.PluginConfigOptions> => {
  // Use the new OpResolver.resolve() method directly
  const resolver = new OpResolver(config.env, pluginOptions);
  return resolver.resolve(config, pluginOptions);
};

// Optional: Helper function to configure op-js authentication if needed.
export function configureOpAuth(authConfig: {
  connectHost?: string;
  connectToken?: string;
  serviceAccountToken?: string;
}) {
  const log = debug('cyop:auth');
  if (authConfig.connectHost && authConfig.connectToken) {
    setConnect(authConfig.connectHost, authConfig.connectToken);
    log('Configured to use 1Password Connect.');
  } else if (authConfig.serviceAccountToken) {
    setServiceAccount(authConfig.serviceAccountToken);
    log('Configured to use 1Password Service Account.');
  }
}
