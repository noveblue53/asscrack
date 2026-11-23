// Save image as (chat-media.js, main.js): a copy of a local original to the place of the Save dialog. The main process
// checks the target with checkSaveTarget (file-choice.mjs, L8) before it calls this function. The copy goes to a
// temporary file in the target folder. The SHA-256 and the size of the copy must be those of the descriptor. A file
// from a peer gets the Mark-of-the-Web (M3, zone-mark.mjs) before the rename to the target name.
import * as fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { markFromInternet } from '../network/zone-mark.mjs';

async function sha256Of(file) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    return { sha256: hash.digest('hex'), size };
}

// source: the verified local original. target: the checked path. descriptor: { sha256, size }. fromPeer: true for
// the file of another member. Gives { ok: true, marked } or { ok: false, reason }.
export async function saveVerifiedCopy({ source, target, descriptor, fromPeer = true, mark = markFromInternet, fs = fsp }) {
    if (!source || !target || !descriptor?.sha256 || !Number.isSafeInteger(descriptor.size)) return { ok: false, reason: 'input' };
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.part`);
    try {
        await fs.copyFile(source, temp, fsp.constants.COPYFILE_EXCL);
        const copy = await sha256Of(temp);
        if (copy.sha256 !== descriptor.sha256 || copy.size !== descriptor.size) {
            await fs.rm(temp, { force: true });
            return { ok: false, reason: 'changed' };
        }
        const marked = fromPeer ? await mark(temp) : false;
        await fs.rename(temp, target);
        return { ok: true, marked };
    } catch {
        await fs.rm(temp, { force: true }).catch(() => {});
        return { ok: false, reason: 'write' };
    }
}
