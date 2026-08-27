export function formatRevocationOutput(row: {
  authVersion: number;
  id: string;
}): string {
  return `account_id: ${row.id}\nauth_version: ${row.authVersion}\n`;
}
