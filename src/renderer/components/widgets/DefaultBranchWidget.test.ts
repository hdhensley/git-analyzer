import { describe, it, expect } from 'vitest';
import { classifyDefaultBranch } from './DefaultBranchWidget';

describe('classifyDefaultBranch', () => {
  it('treats main as on-target production', () => {
    expect(classifyDefaultBranch('main')).toEqual({
      status: 'on-target',
      role: 'Production',
    });
  });

  it('flags develop as needing conversion to main (it should not be the default)', () => {
    expect(classifyDefaultBranch('develop')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
  });

  it('flags master for conversion to main', () => {
    expect(classifyDefaultBranch('master')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
  });

  it('flags dev for conversion to main', () => {
    expect(classifyDefaultBranch('dev')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
  });

  it('flags any other branch for conversion to main', () => {
    expect(classifyDefaultBranch('trunk')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
    expect(classifyDefaultBranch('release')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(classifyDefaultBranch('  MAIN ')).toEqual({
      status: 'on-target',
      role: 'Production',
    });
    expect(classifyDefaultBranch('Develop')).toEqual({
      status: 'needs-conversion',
      suggestion: 'main',
    });
  });
});
