import { DatabaseService } from '../services/database';
import { SecureStorage } from '../services/secure-storage';
import { AuthService } from '../services/auth';
import { SnykService } from '../services/snyk';
import { GitService } from '../services/git';
import { LocalGitService } from '../services/local-git';

/** Identity of a space. Phase 0 has exactly one: the legacy default. */
export interface SpaceInfo {
  id: string;
  name: string;
}

/**
 * Everything that belongs to one space: its database, its credential store
 * and the services built on them. Nothing outside a context should hold on to
 * its members, so closing a context releases every resource it owns.
 */
export interface SpaceContext extends SpaceInfo {
  db: DatabaseService;
  secureStorage: SecureStorage;
  auth: AuthService;
  snyk: SnykService;
  git: GitService;
  localGit: LocalGitService;
  close(): void;
}

export interface SpaceContextOptions {
  /** Absolute database path. Defaults to the app's userData database. */
  dbPath?: string;
  /** Keychain namespace. Omit for the legacy un-prefixed credential keys. */
  credentialNamespace?: string;
}

export function createSpaceContext(info: SpaceInfo, options: SpaceContextOptions = {}): SpaceContext {
  const db = new DatabaseService(options.dbPath);
  const secureStorage = new SecureStorage(options.credentialNamespace);
  const auth = new AuthService(secureStorage, db);
  return {
    ...info,
    db,
    secureStorage,
    auth,
    snyk: new SnykService(secureStorage, db),
    git: new GitService(auth),
    localGit: new LocalGitService(),
    close: () => db.close(),
  };
}
