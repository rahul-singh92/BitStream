'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bitstream', {
    getState: () => ipcRenderer.invoke('state:get'),
    pickTorrent: () => ipcRenderer.invoke('pick-torrent'),
    pickFolder: current => ipcRenderer.invoke('pick-folder', current),
    parseTorrent: p => ipcRenderer.invoke('parse-torrent', p),
    add: (torrentPath, folder, selected) => ipcRenderer.invoke('add', { torrentPath, folder, selected }),
    getFiles: id => ipcRenderer.invoke('download-files', id),
    pause: id => ipcRenderer.send('pause', id),
    resume: id => ipcRenderer.send('resume', id),
    remove: (id, deleteFiles) => ipcRenderer.invoke('remove', { id, deleteFiles }),
    openFolder: id => ipcRenderer.send('open-folder', id),
    setTheme: mode => ipcRenderer.send('set-theme', mode),
    pathForFile: file => webUtils.getPathForFile(file),
    onAdded: cb => ipcRenderer.on('download:added', (_e, d) => cb(d)),
    onUpdate: cb => ipcRenderer.on('download:update', (_e, d) => cb(d)),
    diskSpace: folder => ipcRenderer.invoke('disk-space', folder),
    getMeta: id => ipcRenderer.invoke('download-meta', id),
    getDetail: id => ipcRenderer.invoke('download-detail', id),
    getLog: id => ipcRenderer.invoke('download-log', id),
    clearLog: id => ipcRenderer.send('clear-log', id),
    onDetail: cb => ipcRenderer.on('download:detail', (_e, p) => cb(p)),
    onLog: cb => ipcRenderer.on('download:log', (_e, p) => cb(p)),
    onFiles: cb => ipcRenderer.on('download:files', (_e, p) => cb(p)),
    onRemoved: cb => ipcRenderer.on('download:removed', (_e, id) => cb(id))
});