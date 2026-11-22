// P9C: a local test release server on 127.0.0.1 in place of GitHub (the P9C checks, docs/RELEASE_UPDATES.md).
//
// Usage:
//   node tools/update-test-server.mjs <release folder> [--port <n>]
//
// The folder holds the files of one release: update.json, update.json.sig and the ASSCRACK-<v>-*.exe files. The server
// answers the two requests of the updater (src/application/updater.mjs, releaseSource with a test address):
//   GET /api/repos/noveblue53/asscrack/releases/latest   { tag_name: "v<version of update.json>", assets: [...] }
//   GET /download/<tag>/<file name>                       the file (only a file name of the folder, only that tag)
// It prints one line for each request. Only a test version of the app (for example 1.0.0-test) accepts the option
// --update-server 127.0.0.1:<port>. The server reads the folder at each request: a change of the files applies
// at once.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const folder = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error('Usage: node tools/update-test-server.mjs <release folder> [--port <n>]');
    process.exit(1);
}
const portIndex = process.argv.indexOf('--port');
const port = portIndex !== -1 ? Number(process.argv[portIndex + 1]) : 0;

function tag() {
    try { return `v${JSON.parse(readFileSync(path.join(folder, 'update.json'), 'utf8')).version}`; } catch { return null; }
}
const files = () => readdirSync(folder).filter(name => statSync(path.join(folder, name)).isFile());

const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').map(part => { try { return decodeURIComponent(part); } catch { return null; } });
    let status = 404;
    if (request.method === 'GET' && url.pathname === '/api/repos/noveblue53/asscrack/releases/latest' && tag()) {
        status = 200;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ tag_name: tag(), assets: files().map(name => ({ name })) }));
    } else if (request.method === 'GET' && parts.length === 4 && parts[1] === 'download' && parts[2] === tag() &&
        files().includes(parts[3])) {
        status = 200;
        const file = path.join(folder, parts[3]);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size });
        createReadStream(file).pipe(response);
    } else {
        response.writeHead(404);
        response.end();
    }
    console.log(`${new Date().toISOString()} ${request.method} ${url.pathname} ${status} UA=${request.headers['user-agent'] ?? ''}`);
});
server.listen(port, '127.0.0.1', () => {
    console.log(`update test server: http://127.0.0.1:${server.address().port} (app option: --update-server 127.0.0.1:${server.address().port}) (folder ${folder})`);
});
