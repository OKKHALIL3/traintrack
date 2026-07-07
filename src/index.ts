import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Derive the version from package.json (always shipped in the npm tarball) so the
// CLI banner can never drift from the published version. dist/index.js → ../package.json.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };
export const VERSION: string = pkg.version;

// Public API — so host apps (e.g. the Traintrack desktop studio) and the
// ecosystem can consume the channel directly. The CLI/MCP server remain the
// primary writers; readers (a Coordination Room UI) can open the same channel.
export { Channel } from './channel/channel.js';
export type { Member, Message } from './channel/channel.js';
export { resolveChannelPath, gitRoot } from './channel/resolve.js';
export type { ResolveOpts } from './channel/resolve.js';
