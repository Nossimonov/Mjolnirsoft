import type { ProjectConfig } from './project-config.ts';
import { SessionStore, type SessionBackend, type SessionStoreOptions } from './session-store.ts';

/**
 * Mount the session-storage backend named by the project config. This factory
 * is the single place that maps a backend id to an implementation, so the rest
 * of the system depends on the {@link SessionBackend} seam rather than a
 * concrete store. No agent is involved — a headless/CI run mounts storage from
 * the committed config alone. An unknown backend fails fast.
 */
export function createSessionStore(
  config: ProjectConfig,
  options: SessionStoreOptions = {},
): SessionBackend {
  switch (config.storage.backend) {
    case 'local':
      return new SessionStore(options);
    default:
      throw new Error(`unknown storage backend: "${config.storage.backend}" (supported: local)`);
  }
}
