import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { inspectImage, inspectGif, PREVIEW_LIMIT } from '../src/application/media-formats.mjs';
import { Readable } from 'node:stream';
import { createRoomMedia, byteRange, mediaBody } from '../src/application/room-media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCdjyHwADrAIYvvruLQAAAABJRU5ErkJggg==', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
function dimensions(buf, w, h) {
    const data = Buffer.from(buf); data.writeUInt32BE(w,16); data.writeUInt32BE(h,20);
    data.writeUInt32BE(crc32(data.subarray(12,29)),29);
    return data;
}
function descriptor(bytes, kind) {
    return { id:'31e69ba1-2dbc-416a-ae60-727092a82188', source:'publisher', kind, size:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex') };
}

test('wire thumbnails must be static CRC-valid PNGs within pixel, edge and encoded limits', () => {
    const small = inspectImage(png,true); assert.equal(small.width,1); assert.equal(small.height,1);
    assert.equal(inspectImage(dimensions(png,1025,1),true),null);
    assert.equal(inspectImage(dimensions(png,1001,1000),true),null);
    assert.equal(inspectImage(Buffer.alloc(PREVIEW_LIMIT+1),true),null);
    assert.equal(inspectImage(png.subarray(0,-5),true),null);
    const corrupt=Buffer.from(png);corrupt[47]^=1;assert.equal(inspectImage(corrupt,true),null);
    const bomb=dimensions(png,100000,100000);assert.equal(inspectImage(bomb),null);
    const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8);chunk.write('acTL',4);chunk.writeUInt32BE(2,8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4,16)),16);
    assert.equal(inspectImage(Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]),true),null);
});

test('inline GIF inspection bounds canvas, total frame work, subblocks and rectangles', () => {
    assert.deepEqual(inspectGif(gif),{width:1,height:1,frames:1,mime:'image/gif'});
    assert.equal(inspectGif(gif.subarray(0,-2)),null);
    const large=Buffer.from(gif);large.writeUInt16LE(2048,6);assert.equal(inspectGif(large),null);
    const badRect=Buffer.from(gif);badRect.writeUInt16LE(17,24);assert.equal(inspectGif(badRect),null);
    const repeated=Buffer.concat([gif.subarray(0,19),...Array(257).fill(gif.subarray(19,-1)),gif.subarray(-1)]);
    assert.equal(inspectGif(repeated),null);
});

test('video range parsing supports bytes, suffix and open-ended seeks and refuses invalid ranges', () => {
    assert.deepEqual(byteRange('bytes=5-9',10),{start:5,end:9});
    assert.deepEqual(byteRange('bytes=7-',10),{start:7,end:9});
    assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});
    for(const v of ['bytes=-0','bytes=12-','bytes=9-1','bytes=0-1,3-4','bytes=99999999999999999999999-']) assert.equal(byteRange(v,10),null);
});

test('opaque original URLs verify content, stream ranges, reject replacement, symlinks and stale capability', async t => {
    const dir=await mkdtemp(path.join(os.tmpdir(),'ac-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const file=path.join(dir,'clip.webm'), link=path.join(dir,'link.webm');
    const bytes=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from('....webm....'),Buffer.alloc(1024,88)]);
    await writeFile(file,bytes);
    const d=descriptor(bytes,'video'), media=createRoomMedia({nativeImage:null});
    await media.verified(d,file);
    const url=media.info(d.id).originalUrl;
    assert.ok(url.startsWith('room-media://asset/'));assert.ok(!url.includes(file));
    const ranged=()=>media.serve(new Request(url,{headers:{range:'bytes=4-15'}}));
    const r=await ranged(); assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 4-15/'+bytes.length);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(4,16));
    assert.equal((await media.serve(new Request(url.replace('/original','/../../secret')))).status,404);
    assert.equal((await media.serve(new Request(url,{method:'POST'}))).status,405);
    if(process.platform!=='win32'){
        await symlink(file,link);const other={...d,id:'second'};
        await media.verified(other,link);assert.equal(media.info(other.id).originalUrl,null);
    }
    await writeFile(file,Buffer.alloc(bytes.length,90));
    assert.equal((await ranged()).status,410);
    media.clear();assert.equal((await ranged()).status,404);
    await writeFile(file,bytes);
    await media.verified({...d,sha256:'0'.repeat(64)},file);
    assert.equal((await media.serve(new Request(media.info(d.id).originalUrl))).status,410);
});

test('publisher derivative and restored local identity check the exact original before display', async t => {
    const dir=await mkdtemp(path.join(os.tmpdir(),'ac-src-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const file=path.join(dir,'shot.png');
    const d=descriptor(png,'image');
    let decodes=0;
    const nativeImage={createFromBuffer() { decodes++; return { getSize:()=>({width:1,height:1}),isEmpty:()=>false,toPNG:()=>png }; }};
    const media=createRoomMedia({nativeImage});
    await writeFile(file,png);assert.deepEqual(await media.makePreview(file,d),png);
    assert.equal(await media.restore(d,file),true);assert.ok(media.info(d.id).thumbnailUrl);
    assert.equal(decodes,2);
    const copy=Buffer.from(png);copy[45]^=1;await writeFile(file,copy);
    assert.equal(await media.makePreview(file,d),null);assert.equal(await media.canReveal(d,file),false);
    assert.equal(decodes,2);
});

test('a paused original-file consumer does not prefetch the whole video', async () => {
    let chunks = 0;
    const block = Buffer.alloc(64 * 1024);
    const stream = new Readable({ highWaterMark: block.length, read() {
        chunks++; this.push(chunks <= 100 ? block : null);
    } });
    const response = new Response(mediaBody(stream));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(chunks > 0 && chunks <= 3, 'paused after ' + chunks + ' blocks ahead of the reader');
    await response.body.cancel();
});
