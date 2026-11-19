import type { ReleaseCommit, ReleaseDateSource } from '../../shared/types';

/** Only tags newer than this get their commit lists fetched and stored. */
export const RELEASE_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

/** Cap on commits stored for a repo's first tag, which has no earlier tag to bound it. */
export const FIRST_RELEASE_COMMIT_CAP = 500;

export interface RawReleaseTag {
  tag: string;
  sha: string;
  releasedAt: Date;
  dateSource: ReleaseDateSource;
}

export interface OrderedReleaseTag extends RawReleaseTag {
  /** The release tag immediately before this one, if any. */
  previous?: RawReleaseTag;
}

/**
 * Orders tags oldest to newest and links each to the one before it. Tags that
 * point at the same commit collapse to the most recently created one, so a
 * commit is never reported as two releases.
 */
export function orderReleaseTags(tags: RawReleaseTag[]): OrderedReleaseTag[] {
  const sorted = [...tags].sort(
    (a, b) =>
      a.releasedAt.getTime() - b.releasedAt.getTime() ||
      a.tag.localeCompare(b.tag, undefined, { numeric: true })
  );
  const bySha = new Map<string, RawReleaseTag>();
  for (const tag of sorted) {
    bySha.set(tag.sha, tag); // later (newer) tags overwrite earlier ones
  }
  const unique = sorted.filter((tag) => bySha.get(tag.sha) === tag);
  return unique.map((tag, index) => ({
    ...tag,
    ...(index > 0 && { previous: unique[index - 1] }),
  }));
}

/** Tags whose release date is inside the lookback window. */
export function isWithinLookback(tag: RawReleaseTag, now = Date.now()): boolean {
  return tag.releasedAt.getTime() >= now - RELEASE_LOOKBACK_MS;
}

export const GIT_FIELD_SEP = '\x1f';
export const GIT_RECORD_SEP = '\x1e';
/** `git log` format matching parseReleaseCommits: hash, name, email, ISO date, parents, message. */
export const RELEASE_COMMIT_FORMAT = '%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B%x1e';

/** Parses `git log --format=RELEASE_COMMIT_FORMAT` output. */
export function parseReleaseCommits(stdout: string): ReleaseCommit[] {
  const commits: ReleaseCommit[] = [];
  for (const record of stdout.split(GIT_RECORD_SEP)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(GIT_FIELD_SEP);
    if (fields.length < 6) continue;
    const [hash, authorName, authorEmail, dateStr, parents, ...messageParts] = fields;
    const date = new Date(dateStr);
    if (!hash || isNaN(date.getTime())) continue;
    commits.push({
      hash,
      authorName,
      authorEmail,
      date,
      message: messageParts.join(GIT_FIELD_SEP).trim(),
      isMerge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  return commits;
}
