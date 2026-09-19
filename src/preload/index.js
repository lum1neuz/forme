import { contextBridge, ipcRenderer } from 'electron'

const MENU_CHANNEL = 'forme:menu-command'
const OPEN_FILE_CHANNEL = 'forme:open-external-file'
const FOLDER_CHANGED_CHANNEL = 'forme:folder-changed'
const THEME_CHANGED_CHANNEL = 'forme:theme-changed'
const MAXIMIZE_CHANNEL = 'forme:maximize-change'

/**
 * Wrap an ipcRenderer.on subscription so the raw IpcRendererEvent (which carries
 * `sender` and would punch a hole through context isolation) never reaches the
 * renderer callback. Returns an unsubscribe function.
 */
function subscribe(channel, handler) {
  const listener = (_event, ...args) => handler(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** Turn a bridge-level failure (a record that will not clone) into a result object. */
function bridgeError(err) {
  return { error: (err && err.message) || String(err || 'Unknown error') }
}

const api = {
  platform: process.platform,

  file: {
    openDialog: () => ipcRenderer.invoke('file:openDialog'),
    openPath: (path) => ipcRenderer.invoke('file:openPath', path),
    save: (path, content) => ipcRenderer.invoke('file:save', path, content),
    saveDialog: (content, suggestedName) =>
      ipcRenderer.invoke('file:saveDialog', content, suggestedName),
    exportHtml: (html, suggestedName) =>
      ipcRenderer.invoke('file:exportHtml', html, suggestedName),
    exportPdf: (html, suggestedName) => ipcRenderer.invoke('file:exportPdf', html, suggestedName),
    revealInFolder: (path) => ipcRenderer.invoke('file:revealInFolder', path)
  },

  folder: {
    choose: () => ipcRenderer.invoke('folder:choose'),
    list: (path) => ipcRenderer.invoke('folder:list', path),
    onChanged: (cb) => {
      if (typeof cb !== 'function') return () => {}
      return subscribe(FOLDER_CHANGED_CHANNEL, (payload) => cb(payload))
    },
    unwatch: () => ipcRenderer.invoke('folder:unwatch')
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },

  // Draft persistence (Addendum E). Main never rejects these, but a record that fails
  // structured cloning would reject in the renderer instead — so the failure is turned
  // into the same result object here. This is unsaved work; it never throws.
  draft: {
    // -> [record], newest first; unreadable/oversized/corrupt files are skipped
    list: () => ipcRenderer.invoke('draft:list').catch(() => []),
    // -> {ok, draftId} | {error}
    save: (record) => ipcRenderer.invoke('draft:save', record).catch(bridgeError),
    // -> {ok} | {error}
    remove: (draftId) => ipcRenderer.invoke('draft:remove', draftId).catch(bridgeError),
    // -> {ok, removed} | {error}; spares drafts written in the last 60s
    prune: (keepIds) => ipcRenderer.invoke('draft:prune', keepIds).catch(bridgeError),
    // -> {ok, removed} | {error}; deletes every draft, no recency guard
    clear: () => ipcRenderer.invoke('draft:clear').catch(bridgeError)
  },

  theme: {
    // -> [{ id, name, type, builtin }]  built-ins first, then user, each alphabetical
    list: () => ipcRenderer.invoke('theme:list'),
    // -> full theme, already merged over the built-in of its type | {error}
    get: (id) => ipcRenderer.invoke('theme:get', id),

    // cb() on a debounced change in <userData>/themes. Returns an unsubscribe
    // function. Subscribing also (re)arms the watcher in main.
    onChanged: (cb) => {
      if (typeof cb !== 'function') return () => {}
      ipcRenderer.invoke('theme:watch').catch(() => {})
      return subscribe(THEME_CHANGED_CHANNEL, () => cb())
    },

    openFolder: () => ipcRenderer.invoke('theme:openFolder')
  },

  app: {
    // Answer to the `app:before-quit` menu command: 'quit' | 'cancel' | 'wait'.
    quitResponse: (decision) => ipcRenderer.invoke('app:quitResponse', decision)
  },

  win: {
    setTitle: (title) => ipcRenderer.invoke('win:setTitle', title),
    setDocumentEdited: (edited) => ipcRenderer.invoke('win:setDocumentEdited', !!edited),

    // Custom title-bar controls. `close` goes through the normal window close path,
    // so the dirty-tab prompt still runs — it is not a hard kill.
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('win:maximizeToggle'),
    close: () => ipcRenderer.invoke('win:close'),

    // Synchronous, so it can be read inline while painting the title bar.
    // `await` on the result still works, so either calling style is fine.
    isMaximized: () => {
      try {
        return !!ipcRenderer.sendSync('win:isMaximized')
      } catch {
        return false
      }
    },

    // cb(isMaximized) — fires on maximize/unmaximize/full-screen changes and once
    // after every load. Returns an unsubscribe function.
    onMaximizeChange: (cb) => {
      if (typeof cb !== 'function') return () => {}
      return subscribe(MAXIMIZE_CHANNEL, (maximized) => cb(!!maximized))
    }
  },

  menu: {
    onCommand: (cb) => {
      if (typeof cb !== 'function') return () => {}
      return subscribe(MENU_CHANNEL, (command, payload) => cb(command, payload))
    },
    setState: (state) => ipcRenderer.invoke('menu:setState', state)
  },

  dialog: {
    confirmDiscard: (name) => ipcRenderer.invoke('dialog:confirmDiscard', name),
    error: (title, message) => ipcRenderer.invoke('dialog:error', title, message)
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },

  onOpenExternalFile: (cb) => {
    if (typeof cb !== 'function') return () => {}
    return subscribe(OPEN_FILE_CHANNEL, (payload) => cb(payload))
  }
}

contextBridge.exposeInMainWorld('forme', api)
