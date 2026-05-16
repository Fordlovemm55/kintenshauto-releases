const { contextBridge, ipcRenderer } = require('electron');

// Backend port comes from main process via additionalArguments
function readBackendPort() {
    try {
        const arg = (process.argv || []).find(a => typeof a === 'string' && a.startsWith('--kintenshauto-port='));
        if (arg) {
            const n = parseInt(arg.split('=')[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch {}
    return 3003;
}
const BACKEND_PORT = readBackendPort();

contextBridge.exposeInMainWorld('kintenshauto', {
    backendPort: BACKEND_PORT,
    apiBase: `http://127.0.0.1:${BACKEND_PORT}`,
    getPaths: () => ipcRenderer.invoke('app:getPaths'),
    isFirstRun: () => ipcRenderer.invoke('app:isFirstRun'),
    completeSetup: () => ipcRenderer.invoke('app:completeSetup'),
    resetSetup: () => ipcRenderer.invoke('app:resetSetup'),
    checkDeps: () => ipcRenderer.invoke('app:checkDeps'),
    installDeps: () => ipcRenderer.invoke('app:installDeps'),
    onDepsProgress: (cb) => {
        const listener = (_, p) => { try { cb(p); } catch {} };
        ipcRenderer.on('deps:progress', listener);
        return () => ipcRenderer.removeListener('deps:progress', listener);
    },
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    showOpenDialog: (opts) => ipcRenderer.invoke('app:showOpenDialog', opts),
    showMessageBox: (opts) => ipcRenderer.invoke('app:showMessageBox', opts),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    reportCrash: (info) => ipcRenderer.invoke('app:reportCrash', info),
    onUpdateAvailable: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('update:available', listener);
        return () => ipcRenderer.removeListener('update:available', listener);
    },
    onUpdateDownloaded: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('update:downloaded', listener);
        return () => ipcRenderer.removeListener('update:downloaded', listener);
    },
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onCloudUpdateForce: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('cloud-update:force', listener);
        return () => ipcRenderer.removeListener('cloud-update:force', listener);
    },
    onCloudUpdateSoft: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('cloud-update:soft', listener);
        return () => ipcRenderer.removeListener('cloud-update:soft', listener);
    }
});
