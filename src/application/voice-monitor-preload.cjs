const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceMonitor', {
    onState: listener => ipcRenderer.on('asscrack:voice-monitor-state', (_event, view) => listener(view)),
    setMuted: value => ipcRenderer.send('asscrack:voice-monitor-set-muted', value),
    close: () => ipcRenderer.send('asscrack:voice-monitor-close'),
    // P8b: Stop sharing of the screen share.
    stopShare: () => ipcRenderer.send('asscrack:voice-monitor-stop-share')
});
