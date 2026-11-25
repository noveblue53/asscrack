// Room music: the bridge of the pop-out window (music-window.html, music-popout.mjs). music-ui.js and music-viz.js use
// the same names as the bridge of the room window (preload.cjs). Each call sends only text, numbers and true or false.
const { contextBridge, ipcRenderer } = require('electron');

const text = value => String(value ?? '');
const listen = channel => callback => {
    ipcRenderer.on(channel, (_event, data) => callback(data));
};

contextBridge.exposeInMainWorld('asscrack', {
    musicWindow: true,
    getMusic: () => ipcRenderer.invoke('asscrack:music-window-state'),
    onMusic: listen('asscrack:music-window-view'),
    onMusicNotice: listen('asscrack:music-window-notice'),
    musicAdd: value => ipcRenderer.invoke('asscrack:music-window-add', text(value)),
    musicAddFiles: () => ipcRenderer.invoke('asscrack:music-window-add-files'),
    musicFolder: () => ipcRenderer.invoke('asscrack:music-window-folder'),
    musicChooseFolder: () => ipcRenderer.invoke('asscrack:music-window-choose-folder'),
    musicAddFolderFile: id => ipcRenderer.invoke('asscrack:music-window-add-folder-file', text(id)),
    musicSkip: () => ipcRenderer.invoke('asscrack:music-window-skip'),
    musicPause: paused => ipcRenderer.invoke('asscrack:music-window-pause', paused === true),
    musicRemove: id => ipcRenderer.invoke('asscrack:music-window-remove', text(id)),
    musicMove: (id, to) => ipcRenderer.invoke('asscrack:music-window-move', text(id), Number(to)),
    musicStop: () => ipcRenderer.invoke('asscrack:music-window-stop'),
    getMusicSettings: () => ipcRenderer.invoke('asscrack:music-window-settings'),
    setMusicSettings: patch => ipcRenderer.invoke('asscrack:music-window-set-settings', patch),
    onMusicSettings: listen('asscrack:music-window-settings-changed'),
    // The visualizer: ask the room window for one frame; the frame comes back (18 bytes, or null).
    musicVizPull: () => ipcRenderer.send('asscrack:music-window-viz-pull'),
    onMusicViz: listen('asscrack:music-window-viz'),
    getMusicWindowState: () => ipcRenderer.invoke('asscrack:music-window-ui-state'),
    setMusicWindowState: patch => {
        const clean = {};
        if (patch && typeof patch.shaded === 'boolean') clean.shaded = patch.shaded;
        if (patch && typeof patch.pinned === 'boolean') clean.pinned = patch.pinned;
        return ipcRenderer.invoke('asscrack:music-window-set-ui-state', clean);
    },
    onMusicWindowState: listen('asscrack:music-window-ui-state-changed'),
    musicWindowAction: action => ipcRenderer.invoke('asscrack:music-window-action', text(action))
});
