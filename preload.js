const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // Contas
  accounts: {
    list:   ()           => ipcRenderer.invoke('accounts:list'),
    add:    (data)       => ipcRenderer.invoke('accounts:add', data),
    remove: (id)         => ipcRenderer.invoke('accounts:remove', id),
  },
  // Jobs
  jobs: {
    list:    ()          => ipcRenderer.invoke('jobs:list'),
    create:  (job)       => ipcRenderer.invoke('jobs:create', job),
    update:  (data)      => ipcRenderer.invoke('jobs:update', data),
    delete:  (id)        => ipcRenderer.invoke('jobs:delete', id),
    start:   (id)        => ipcRenderer.invoke('jobs:start', id),
    stop:    (id)        => ipcRenderer.invoke('jobs:stop', id),
    runNow:  (id)        => ipcRenderer.invoke('jobs:runNow', id),
  },
  // Utilitários
  dialog: {
    openFile: (filters)  => ipcRenderer.invoke('dialog:openFile', filters),
  },
  shell: {
    openFolder: (p)      => ipcRenderer.invoke('shell:openFolder', p),
  },
  ollama: {
    check: ()            => ipcRenderer.invoke('ollama:check'),
  },
  ytdlp: {
    check: ()            => ipcRenderer.invoke('ytdlp:check'),
  },
  ai: {
    status: ()           => ipcRenderer.invoke('ai:status'),
  },
  update: {
    install: ()          => ipcRenderer.invoke('update:install'),
  },
  live: {
    sessions: ()         => ipcRenderer.invoke('live:sessions'),
  },
  settings: {
    get: ()              => ipcRenderer.invoke('settings:get'),
    set: (patch)         => ipcRenderer.invoke('settings:set', patch),
  },
  support: {
    chat: (messages)     => ipcRenderer.invoke('support:chat', { messages }),
  },
  // Controles de janela
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close:    () => ipcRenderer.send('win:close'),
  },
  // Eventos recebidos do main
  on: (channel, fn) => {
    const allowed = ['job:log', 'job:status', 'job:update', 'ai:status', 'ai:log', 'update:status', 'live:frame', 'live:sessions', 'fix:announcements']
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, data) => fn(data))
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
