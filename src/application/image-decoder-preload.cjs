// L7: the preload of the hidden image decoder window. It gives the page one job channel and one result channel, and
// the two channels of Copy image.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imageDecoder', {
    onJob: callback => ipcRenderer.on('asscrack:image-decode', (_event, id, bytes, size) => callback(id, bytes, size)),
    reply: (id, bytes) => ipcRenderer.send('asscrack:image-decoded', id, bytes instanceof Uint8Array ? bytes : null),
    // Copy image (image-decoder.mjs): a preview PNG to show, and the answer when the image is ready to copy.
    onCopy: callback => ipcRenderer.on('asscrack:image-copy', (_event, id, bytes) => callback(id, bytes)),
    copyReady: (id, ok) => ipcRenderer.send('asscrack:image-copy-ready', id, ok === true)
});
