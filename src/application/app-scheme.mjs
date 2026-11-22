// I4: the windows of the app load their pages from the custom scheme asscrack-app://, not from file://.
// - The CSP source 'self' then covers only the files of this folder, not each file: URL of the computer.
// - The fuse grantFileProtocolExtraPrivileges can be off (package.json, build.electronFuses).
// The handler gives only the files of the application folder with a known type, and one fixed file of a package.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_SCHEME = 'asscrack-app';
export const APP_ORIGIN = `${APP_SCHEME}://app`;
// The privileges of the scheme. standard: normal URL rules and an origin. secure: a secure context (getUserMedia and
// AudioWorklet need it).
export const APP_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };

export const appPage = name => `${APP_ORIGIN}/${name}`;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm'
};
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

const failed = status => new Response(null, { status, headers: { 'X-Content-Type-Options': 'nosniff' } });

// root: the application folder. extra: { '/vendor/x.js': absolute path } for the fixed files of packages.
// read: the file reader (a test gives a fake).
export function createAppHandler({ root, extra = {}, read = readFile }) {
    // The path of a request, or null when the request is not for a file of the app.
    function fileOf(request) {
        let url;
        try { url = new URL(request.url); } catch { return null; }
        if (url.protocol !== `${APP_SCHEME}:` || url.host !== 'app' || url.username || url.password || url.port) return null;
        if (Object.hasOwn(extra, url.pathname)) return extra[url.pathname];
        const parts = url.pathname.split('/').slice(1);
        if (!parts.length || parts.length > 2) return null;
        // An encoded character (%2e, %2f, %5c) or a dot segment gives no file.
        if (!parts.every(part => NAME.test(part))) return null;
        if (parts.length === 2 && parts[0] !== 'img') return null;
        return path.join(root, ...parts);
    }

    return async function handle(request) {
        if (!['GET', 'HEAD'].includes(request.method)) return failed(405);
        const file = fileOf(request);
        const type = file && TYPES[path.extname(file).toLowerCase()];
        if (!type) return failed(404);
        let body;
        try { body = await read(file); } catch { return failed(404); }
        const headers = { 'Content-Type': type, 'Content-Length': String(body.length), 'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff' };
        return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    };
}
