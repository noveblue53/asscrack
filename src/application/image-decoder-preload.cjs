// L7: the preload of the hidden image decoder window. It gives the page one job channel and one result channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imageDecoder', {
    onJob: callback => ipcRenderer.on('asscrack:image-decode', (_event, id, bytes, size) => callback(id, bytes, size)),
    reply: (id, bytes) => ipcRenderer.send('asscrack:image-decoded', id, bytes instanceof Uint8Array ? bytes : null)
});
