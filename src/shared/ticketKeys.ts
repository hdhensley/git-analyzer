/** Unique ticket keys such as DEV-1234 found in a commit message, in order of appearance. */
export function extractTicketKeys(message: string): string[] {
  const matches = message.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];
  return [...new Set(matches)];
}
