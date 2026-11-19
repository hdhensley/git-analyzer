/**
 * Which branch counts as "released". `auto` uses `main` and falls back to
 * `master` for repositories that have no `main`.
 */
export type ReleaseBranchMode = 'main' | 'master' | 'auto';

export const DEFAULT_RELEASE_BRANCH_MODE: ReleaseBranchMode = 'main';

export const RELEASE_BRANCH_MODES: Array<{ id: ReleaseBranchMode; label: string }> = [
  { id: 'main', label: 'main' },
  { id: 'master', label: 'master' },
  { id: 'auto', label: 'main, else master' },
];

export function isReleaseBranchMode(value: unknown): value is ReleaseBranchMode {
  return value === 'main' || value === 'master' || value === 'auto';
}

/** Branch names to try, in order. */
export function releaseBranchCandidates(mode: ReleaseBranchMode): string[] {
  return mode === 'auto' ? ['main', 'master'] : [mode];
}
