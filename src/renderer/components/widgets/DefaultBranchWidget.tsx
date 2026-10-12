import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import type { Repository } from '../../../shared/types';
import './DefaultBranchWidget.css';

export type BranchStatus = 'on-target' | 'needs-conversion';

export interface BranchClassification {
  /** Overall status of this default branch against the target convention. */
  status: BranchStatus;
  /** Human-readable role when on-target. */
  role?: 'Production';
  /** Suggested default branch when conversion is needed. */
  suggestion?: string;
}

/**
 * Classifies a repository's DEFAULT branch against the target convention.
 *
 * The SCM default branch should be `main`. `develop` is a valid branch to have
 * (as the testing branch), but it should not be the default — if it is the
 * default, it needs to be pointed at `main`. Legacy `master`/`dev` defaults,
 * and any other value, are likewise flagged for conversion to `main`.
 *
 * Note: this reflects a repository's DEFAULT branch only (one value per repo),
 * not whether the repository actually contains both `main` and `develop`
 * branches — that would require live branch listing.
 */
export function classifyDefaultBranch(branch: string): BranchClassification {
  const normalized = branch.trim().toLowerCase();

  if (normalized === 'main') {
    return { status: 'on-target', role: 'Production' };
  }

  // Everything else should have its default branch pointed at `main`.
  return { status: 'needs-conversion', suggestion: 'main' };
}

interface ClassifiedRepo {
  repository: Repository;
  classification: BranchClassification;
}

const STATUS_LABEL: Record<BranchStatus, string> = {
  'on-target': 'On target',
  'needs-conversion': 'Needs conversion',
};

const PROVIDER_LABEL: Record<Repository['provider'], string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  local: 'Local',
};

export function DefaultBranchWidget({ repositories }: ChartWidgetProps) {
  const classified = useMemo<ClassifiedRepo[]>(
    () =>
      [...repositories]
        .map((repository) => ({
          repository,
          classification: classifyDefaultBranch(repository.defaultBranch),
        }))
        .sort((a, b) => {
          // Surface repos needing attention first, then by name.
          const order: Record<BranchStatus, number> = {
            'needs-conversion': 0,
            'on-target': 1,
          };
          const diff = order[a.classification.status] - order[b.classification.status];
          if (diff !== 0) return diff;
          return a.repository.name.localeCompare(b.repository.name);
        }),
    [repositories]
  );

  if (repositories.length === 0) {
    return (
      <div className="default-branch default-branch--empty">
        Select at least one repository to review default branches
      </div>
    );
  }

  const offTargetCount = classified.filter(
    (c) => c.classification.status !== 'on-target'
  ).length;

  return (
    <div className="default-branch">
      <div className="default-branch__summary">
        {offTargetCount === 0 ? (
          <span className="default-branch__summary-ok">
            All {repositories.length} selected{' '}
            {repositories.length === 1 ? 'repo uses' : 'repos use'} <code>main</code> as the
            default branch.
          </span>
        ) : (
          <span className="default-branch__summary-warn">
            {offTargetCount} of {repositories.length} selected{' '}
            {repositories.length === 1 ? 'repo needs' : 'repos need'} the default branch changed to{' '}
            <code>main</code>.
          </span>
        )}
      </div>

      <table className="default-branch__table">
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">Source</th>
            <th scope="col">Default branch</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {classified.map(({ repository, classification }) => (
            <tr key={repository.id}>
              <td className="default-branch__repo">
                {repository.parentFolder ? (
                  <span className="default-branch__repo-folder">
                    {repository.parentFolder}/
                  </span>
                ) : null}
                {repository.name}
              </td>
              <td className="default-branch__source">
                {PROVIDER_LABEL[repository.provider] ?? repository.provider}
              </td>
              <td className="default-branch__branch">
                <code>{repository.defaultBranch}</code>
              </td>
              <td className="default-branch__status">
                <span
                  className={`default-branch__badge default-branch__badge--${classification.status}`}
                >
                  {STATUS_LABEL[classification.status]}
                  {classification.role ? ` · ${classification.role}` : ''}
                </span>
                {classification.suggestion ? (
                  <span className="default-branch__suggestion">
                    → set default to <code>{classification.suggestion}</code>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="default-branch__note">
        The SCM default branch should be <code>main</code>. <code>develop</code> is a valid
        branch to keep as the testing branch, but it should not be the default. This reflects
        each repository&apos;s default branch only (one value per repo), not which branches the
        repo actually contains — that requires live branch listing.
      </p>
    </div>
  );
}

// Widget definition for registry
export const DefaultBranchWidgetDefinition = {
  id: 'default-branch-overview',
  name: 'Default Branch Overview',
  description:
    'Default branch per selected repository, flagging any repo whose default is not main',
  requiredFields: [] as const,
  supportsDateFilter: false,
  supportsRepoFilter: true,
  component: DefaultBranchWidget,
};
