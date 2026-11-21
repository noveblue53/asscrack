import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAsscrackNode } from '../src/network/node.mjs'
import { createAttachments } from '../src/network/attachment.mjs'
import { newRoomKey } from '../src/network/invite.mjs'
import { createSavedRooms } from '../src/application/saved-rooms.mjs'
import { createRoomMedia } from '../src/application/room-media.mjs'
import { loadRoomWindow, settle } from './helpers/renderer-fixture.mjs'

async function waitFor(check, label) {
    const end = Date.now() + 15000
    while (!check() && Date.now() < end) await delay(20)
    assert.ok(check(), label)
}

test('channel switches preserve the attachment, recipient, quote and caption through preparation', async () => {
    const controls = ['channel-select','channel-add','channel-dialog','channel-name','channel-note','channel-error',
        'channel-cancel','channel-create-form'].map(id => ({id}))
    const r = await loadRoomWindow({scripts: ['channels-ui.js'], elements: controls})
    await r.login('sender')
    const music = randomUUID(), ch = r.window.roomChannels
    r.handlers.onChannels({ channels: [{id:'general',name:'General'},{id:music,name:'Music'}], available:true })
    r.handlers.onPeerJoined({peerId:'other'})
    ch.open(music)
    const file = { name:'album.png', type:'image/png' }
    r.el('file-input').files = [file]
    r.el('file-input').dispatchEvent(new r.Event('change'))
    r.el('file-recipient').value = 'other'
    r.el('message-input').value = 'album caption'
    ch.open('general')
    assert.ok(r.el('file-draft').hidden)
    assert.equal(r.el('file-recipient').value, 'room')
    r.el('message-input').value = 'General draft'
    ch.open(music)
    assert.equal(r.el('file-draft-name').textContent, file.name)
    assert.equal(r.el('file-recipient').value, 'other')
    assert.equal(r.el('message-input').value, 'album caption')
    r.el('file-recipient').value = 'room'
    const row = r.receive({id:'prior',from:'friend',text:'reference',peerId:'other',time:12000})
    // receive() is a General helper; select its real visible row when quoting.
    ch.open('general')
    const generalRow = row ?? r.rows().find(li => li.dataset.id === 'prior')
    r.window.roomActions.run('quote', generalRow)
    ch.open(music)
    assert.ok(r.chip().hidden, 'General quote stays in that conversation')
    let complete
    const sendCalls = []
    r.window.asscrack.postMedia = (...args) => { sendCalls.push(args); return new Promise(resolve => {complete=resolve}) }
    r.el('send-file').click()
    assert.equal(sendCalls[0][0], file)
    assert.equal(sendCalls[0][2], music)
    ch.open('general')
    complete({ message:{ id:'photo-1',from:'sender',text:'album caption\nalbum.png',time:14000 },
        offer:{offerId:'offer',name:file.name,size:12,peers:1,recipients:['other']} })
    await settle()
    assert.equal(r.el('message-input').value, 'General draft')
    assert.equal(r.chip().hidden, false)
    assert.ok(!r.rows().some(li => li.dataset.id === 'photo-1'))
    ch.open(music)
    assert.ok(r.el('file-draft').hidden)
    assert.equal(r.el('message-input').value, '')
    assert.equal(r.rows().filter(li => li.dataset.id === 'photo-1').length, 1)
    assert.deepEqual(r.errors, [])
})

test('127.0.0.1 named attachment and quote retain canonical IDs on late replay; Clear and Forget preserve the downloaded original', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'channel-media-'))
    const downloads = path.join(dir,'Downloads')
    await mkdir(downloads)
    // A recognized extension with unsupported contents is still an ordinary transferable original.
    const file = path.join(dir,'source-marker.png')
    const bytes = Buffer.from('not an image; user requested the original')
    await writeFile(file, bytes)
    const room='media', roomKey=newRoomKey(), nodes=[]
    const openArchive = () => createSavedRooms({dir:path.join(dir,'archive'),protector:{available:()=>true,wrap:b=>b,unwrap:b=>b}})
    let saved = openArchive()
    const roomId=saved.afterLogin({room,roomKey,userName:'host',save:true,keepHistory:true}).roomId
    async function make(options) {
        const n=await createAsscrackNode({room,roomKey,listen:['/ip4/127.0.0.1/tcp/0'],discovery:false,
            heartbeatInterval:200,electionDelay:500,hostTimeout:1500,fullNode:false,...options})
        nodes.push(n)
        return n
    }
    t.after(async()=>{ await Promise.all(nodes.map(n=>n.stop())); saved.close(); await rm(dir,{recursive:true,force:true}) })
    const host=await make({fullNode:true,downloadDir:downloads,seedHistory:invalidate=>saved.prepareReplay(room,roomKey,invalidate)})
    saved.attachNode(host)
    host.events.on('channels', snapshot => saved.persistChannels(snapshot.added))
    const sender=await make({name:'Friend'})
    await sender.connect(host.getMultiaddrs()[0])
    await waitFor(()=>host.isHost()&&sender.channels().available,'initial host')
    const channel=sender.createChannel('Album')
    await waitFor(()=>host.channels().channels.some(c=>c.id===channel),'channel present')
    const offers=[],done=[]
    host.events.on('file-offer',e=>offers.push(e))
    host.events.on('file-done',e=>done.push(e))
    const {message}=await sender.postAttachment(file,'caption',channel)
    await waitFor(()=>offers.length && saved.lines(roomId,{channelId:channel}).length,'received offer and saved post')
    const archived=saved.lines(roomId,{channelId:channel})[0]
    assert.deepEqual(archived.attachment,message.attachment)
    assert.equal(archived.id,message.id)
    assert.equal(offers[0].offerId,message.attachment.id)
    assert.ok(!JSON.stringify(archived).includes(dir))
    assert.equal(host.acceptFile(offers[0].offerId),true)
    await waitFor(()=>done.length,'verified download')
    assert.equal(path.dirname(done[0].path),downloads)
    const hash=b=>createHash('sha256').update(b).digest('hex')
    assert.equal(hash(await readFile(done[0].path)),message.attachment.sha256)
    let decoderCalls = 0
    const media = createRoomMedia({ nativeImage: { createFromBuffer() { decoderCalls++; throw new Error('unsupported') } } })
    await media.verified(message.attachment, done[0].path)
    assert.equal(decoderCalls, 0)
    assert.ok(!media.info(message.attachment).thumbnailUrl)
    const ui=await loadRoomWindow()
    const q=ui.window.quoteCore
    const quote=q.makeQuote({from:archived.from,text:archived.text,clock:'09:15'})
    const reply=host.sendRecord(q.compose(quote,'saved my copy'),channel)
    saved.recordSend(reply)
    const late=await make()
    await late.connect(host.getMultiaddrs()[0])
    await waitFor(()=>late.history().length===2,'canonical replay')
    assert.deepEqual(new Set(late.history().map(m=>m.id)),new Set([message.id,reply.id]))
    assert.deepEqual(late.history().find(m=>m.id===message.id).attachment,message.attachment)
    const quoted=late.history().find(m=>m.id===reply.id)
    assert.ok(quoted.text.includes('source-marker.png')&&quoted.text.includes('saved my copy'))
    assert.equal(quoted.attachment,undefined)
    assert.ok(late.history().every(m=>m.channelId===channel))
    assert.deepEqual(saved.lines(roomId,{channelId:'general'}),[])
    saved.rememberDownload(message.attachment,done[0].path)
    assert.equal(saved.getDownload(message.id,message.attachment.id).path,done[0].path)
    assert.equal(saved.clear(roomId).cleared,2)
    assert.equal(saved.getDownload(message.id,message.attachment.id),null)
    assert.deepEqual(saved.lines(roomId,{channelId:channel}),[])
    assert.deepEqual(host.history(),[])
    assert.equal(hash(await readFile(done[0].path)),message.attachment.sha256)
    // Forget is a login-screen action. Leave a second, still-associated download in the archive at exit.
    const again = await sender.postAttachment(file,'second copy',channel)
    await waitFor(()=>offers.length === 2 && saved.lines(roomId,{channelId:channel}).length === 1,'another saved card')
    assert.equal(host.acceptFile(offers[1].offerId),true)
    await waitFor(()=>done.length === 2,'second download')
    saved.rememberDownload(again.message.attachment,done[1].path)
    assert.equal(saved.getDownload(again.message.id,again.message.attachment.id).path,done[1].path)
    saved.close()
    saved = openArchive()
    assert.ok(saved.forget(roomId).forgotten)
    assert.equal(saved.getRoom(roomId),null)
    assert.deepEqual(await readFile(done[1].path),bytes)
    media.clear()
    assert.deepEqual(await readFile(done[0].path),bytes)
    assert.deepEqual(await readFile(file),bytes)
})

test('cached attachment actions stay bound to the displayed source and bytes when descriptors conflict', async () => {
    const source='12D3KooWCksvcsuzM6xHeV5BNVr593yb3FTZC7n7hUQNUm3pwW7N'
    const d={id:randomUUID(),source,name:'x.webm',sha256:'1'.repeat(64),kind:'video',expires:Date.now()+600000,size:64}
    const changed={...d,sha256:'2'.repeat(64)}
    const a=createAttachments({self:'local',sessions:new Map(),connections:()=>[],events:{emit(){}},files:{}})
    assert.deepEqual(a.remember({attachment:d},source).attachment,d)
    assert.equal(a.remember({attachment:changed},source).attachment,undefined)
    assert.equal(a.descriptor(changed),null)
    assert.deepEqual(a.descriptor(d),d)
    assert.equal(a.requestOriginal(changed),false)
    assert.equal(await a.requestPreviewById(changed),null)
    const media=createRoomMedia({nativeImage:{}})
    await media.verified(d,path.join(os.tmpdir(),'missing-'+randomUUID()))
    assert.equal(media.info(d).originalUrl,null)
    assert.deepEqual(media.info(changed),{})
    media.clear()
    a.stop()
})
