import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { createApp, SERVER_NAME } from './app.js';

const config = loadConfig();
const app = createApp(config);

let failed = false;
const server = app.listen(config.port);

// Node can emit `listening` for one address family and then fail on another,
// so the banner waits a turn: announcing an address we are not serving is the
// failure mode this whole block exists to prevent.
server.on('listening', () => setImmediate(() => {
    if (failed) return;
    console.log(`${SERVER_NAME} MCP server listening on ${config.publicUrl.origin}`);
    console.log(`  MCP endpoint   ${config.resourceUrl.href}`);
    console.log(`  Unimicro API   ${config.apiBaseUrl.origin}`);
    console.log(`  Identity       ${config.issuer.origin}`);
}));

/**
 * Refuse to start when the port is taken, and say who has it.
 *
 * Without this the failure is silent and vicious: a stale server keeps serving
 * the old code while the new process prints a full success banner, so every
 * request goes somewhere you are not editing and nothing anywhere says why.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
    failed = true;
    if (error.code !== 'EADDRINUSE') throw error;

    console.error(`\nPort ${config.port} is already in use — refusing to start.\n`);
    console.error(`  ${describeHolder(config.port)}\n`);
    console.error('Stop it, or set PORT to a free port. Note that changing PORT also');
    console.error("means registering the new callback URL on your client in the portal:");
    console.error(`  http://localhost:<PORT>/oauth/callback\n`);
    process.exit(1);
});

/** Best-effort "who holds this port", so the fix does not start with a hunt. */
function describeHolder(port: number): string {
    try {
        const pids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n').filter(Boolean);

        if (pids.length === 0) return 'Could not identify the process holding it.';

        return pids.map(pid => {
            let command = '';
            try {
                command = execFileSync('ps', ['-p', pid, '-o', 'command='], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
            } catch {
                // ps can lose the race with a process that just exited.
            }
            return `Held by PID ${pid}${command ? `: ${command}` : ''}\n  Stop it with: kill ${pid}`;
        }).join('\n  ');
    } catch {
        // lsof is absent or refused; the port number alone still beats silence.
        return 'Could not identify the process holding it (lsof unavailable).';
    }
}
