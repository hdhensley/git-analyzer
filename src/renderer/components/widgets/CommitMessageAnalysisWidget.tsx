import { useMemo } from 'react';
import type { ChartWidgetProps } from './types';
import './CommitMessageAnalysisWidget.css';

const CONVENTIONAL_PREFIXES = ['feat', 'fix', 'chore', 'refactor', 'docs', 'style', 'test', 'perf', 'ci', 'build', 'revert'];

interface MessageStats {
  avgLength: number;
  medianLength: number;
  shortMessages: number; // <= 10 chars
  longMessages: number;  // > 72 chars first line
  conventionalBreakdown: { prefix: string; count: number }[];
  topWords: { word: string; count: number }[];
}

const STOP_WORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it','this','that','was','are','be','has','had','have','not','no','do','did','will','can','into','up','out','as','if','so','its','also','just','more','than','then','only','been','some','when','what','which','who','how','all','each','new','old','add','use','set','get','fix','update','remove','change','move','make','run','test','merge','branch','pull','push','commit','added','updated','removed','fixed','changed']);

function analyzeMessages(commits: { message: string }[]): MessageStats {
  const lengths = commits.map(c => c.message.split('\n')[0].length).sort((a, b) => a - b);
  const avg = lengths.reduce((s, v) => s + v, 0) / (lengths.length || 1);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;

  const prefixCounts = new Map<string, number>();
  for (const c of commits) {
    const firstLine = c.message.split('\n')[0].toLowerCase();
    for (const p of CONVENTIONAL_PREFIXES) {
      if (firstLine.startsWith(p + ':') || firstLine.startsWith(p + '(')) {
        prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
        break;
      }
    }
  }

  // Word frequency
  const wordCounts = new Map<string, number>();
  for (const c of commits) {
    const words = c.message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const seen = new Set<string>();
    for (const w of words) {
      if (!seen.has(w)) { seen.add(w); wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1); }
    }
  }

  return {
    avgLength: Math.round(avg),
    medianLength: median,
    shortMessages: lengths.filter(l => l <= 10).length,
    longMessages: lengths.filter(l => l > 72).length,
    conventionalBreakdown: Array.from(prefixCounts.entries()).map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count),
    topWords: Array.from(wordCounts.entries()).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

export function CommitMessageAnalysisWidget({ commits }: ChartWidgetProps) {
  const stats = useMemo(() => analyzeMessages(commits), [commits]);

  if (commits.length === 0) {
    return <div className="msg-analysis msg-analysis--empty">No commits match the current filters</div>;
  }

  const maxWordCount = stats.topWords[0]?.count ?? 1;

  return (
    <div className="msg-analysis">
      <div className="msg-analysis__stats-row">
        <div className="msg-analysis__stat-card">
          <span className="msg-analysis__stat-value">{stats.avgLength}</span>
          <span className="msg-analysis__stat-label">Avg length (chars)</span>
        </div>
        <div className="msg-analysis__stat-card">
          <span className="msg-analysis__stat-value">{stats.medianLength}</span>
          <span className="msg-analysis__stat-label">Median length</span>
        </div>
        <div className="msg-analysis__stat-card">
          <span className="msg-analysis__stat-value">{stats.shortMessages}</span>
          <span className="msg-analysis__stat-label">Short (≤10 chars)</span>
        </div>
        <div className="msg-analysis__stat-card">
          <span className="msg-analysis__stat-value">{stats.longMessages}</span>
          <span className="msg-analysis__stat-label">Long (&gt;72 chars)</span>
        </div>
      </div>

      {stats.conventionalBreakdown.length > 0 && (
        <div className="msg-analysis__section">
          <h4 className="msg-analysis__section-title">Conventional Commits</h4>
          <div className="msg-analysis__prefix-list">
            {stats.conventionalBreakdown.map(({ prefix, count }) => (
              <span key={prefix} className="msg-analysis__prefix-pill">
                {prefix}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {stats.topWords.length > 0 && (
        <div className="msg-analysis__section">
          <h4 className="msg-analysis__section-title">Top Keywords</h4>
          <div className="msg-analysis__word-cloud">
            {stats.topWords.map(({ word, count }) => (
              <span
                key={word}
                className="msg-analysis__word"
                style={{ fontSize: `${0.7 + (count / maxWordCount) * 0.8}rem`, opacity: 0.5 + (count / maxWordCount) * 0.5 }}
                title={`${word}: ${count} commits`}
              >
                {word}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const CommitMessageAnalysisWidgetDefinition = {
  id: 'commit-message-analysis',
  name: 'Commit Message Analysis',
  description: 'Message length stats, conventional commit breakdown, and keyword frequency',
  requiredFields: ['message'] as const,
  supportsDateFilter: true,
  supportsRepoFilter: true,
  component: CommitMessageAnalysisWidget,
};
