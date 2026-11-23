// Room music (MU-6): the preload of the hidden window of the YouTube player script (music-eval.mjs). One job channel
// and one result channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicEval', {
    onJob: callback => ipcRenderer.on('asscrack:music-eval', (_event, id, code) => callback(id, code)),
    reply: (id, text) => ipcRenderer.send('asscrack:music-evaluated', id, typeof text === 'string' ? text : null)
});
