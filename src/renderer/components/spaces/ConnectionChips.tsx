import type { SpaceConnections } from '../../../shared/types';

const LABELS: Array<[keyof SpaceConnections, string]> = [
  ['github', 'GitHub'],
  ['bitbucket', 'Bitbucket'],
  ['snyk', 'Snyk'],
];

interface ConnectionChipsProps {
  connections?: SpaceConnections;
  /** Show "Not connected" when nothing is connected (the menu stays quiet). */
  showEmpty?: boolean;
}

/** Small pills showing which services have saved credentials in a space. */
export function ConnectionChips({ connections, showEmpty = false }: ConnectionChipsProps) {
  if (!connections) return null;
  const connected = LABELS.filter(([key]) => connections[key]);
  if (connected.length === 0) {
    return showEmpty ? <span className="connection-chips__none">Not connected</span> : null;
  }
  return (
    <span className="connection-chips" aria-label={`Connected: ${connected.map(([, l]) => l).join(', ')}`}>
      {connected.map(([key, label]) => (
        <span key={key} className="connection-chips__chip" aria-hidden="true">
          {label}
        </span>
      ))}
    </span>
  );
}
