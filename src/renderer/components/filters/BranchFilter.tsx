import { useMemo } from 'react';
import type { Commit } from '../../../shared/types';
import './BranchFilter.css';

interface BranchFilterProps {
  commits: Commit[];
  selectedBranches: string[];
  onChange: (branches: string[]) => void;
}

export function BranchFilter({ commits, selectedBranches, onChange }: BranchFilterProps) {
  // Extract unique branches from commits
  const branches = useMemo(() => {
    const branchSet = new Set<string>();
    for (const commit of commits) {
      if (commit.branch) {
        branchSet.add(commit.branch);
      }
    }
    return Array.from(branchSet).sort();
  }, [commits]);

  if (branches.length === 0) {
    return null;
  }

  const handleToggle = (branch: string) => {
    const newSelected = selectedBranches.includes(branch)
      ? selectedBranches.filter(b => b !== branch)
      : [...selectedBranches, branch];
    onChange(newSelected);
  };

  const handleSelectAll = () => {
    onChange(branches);
  };

  const handleSelectNone = () => {
    onChange([]);
  };

  return (
    <div className="branch-filter">
      <div className="branch-filter__header">
        <span className="branch-filter__title">Branches</span>
        <div className="branch-filter__actions">
          <button type="button" onClick={handleSelectAll}>All</button>
          <button type="button" onClick={handleSelectNone}>None</button>
        </div>
      </div>

      <div className="branch-filter__list">
        {branches.map(branch => (
          <label key={branch} className="branch-filter__item">
            <input
              type="checkbox"
              checked={selectedBranches.includes(branch)}
              onChange={() => handleToggle(branch)}
            />
            <span className="branch-filter__name">{branch}</span>
          </label>
        ))}
      </div>

      {selectedBranches.length === 0 && branches.length > 0 && (
        <div className="branch-filter__warning">
          Select at least one branch to view commits
        </div>
      )}
    </div>
  );
}
