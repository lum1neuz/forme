import { Menu, app, shell } from 'electron'
import { basename } from 'node:path'
import { getSettings } from './settings.js'

const isMac = process.platform === 'darwin'

let currentState = { mode: 'source', theme: 'system', dirty: false, hasFile: false }
let currentOnCommand = () => {}
let recentSignature = ''

function send(command, payload) {
  try {
    currentOnCommand(command, payload)
  } catch {
    // A menu click must never surface an unhandled exception.
  }
}

function signatureOf(recentFiles) {
  return recentFiles.join('>|<')
}

function recentSubmenu() {
  const recent = getSettings().recentFiles
  const items = recent.map((filePath, i) => ({
    label: `${i + 1}. ${basename(filePath)}`,
    toolTip: filePath,
    click: () => send('file:open', { path: filePath })
  }))

  if (items.length === 0) {
    items.push({ label: 'No Recent Files', enabled: false })
  }

  items.push({ type: 'separator' })
  items.push({
    label: 'Clear Recently Opened',
    enabled: recent.length > 0,
    click: () => send('file:clear-recent')
  })

  return items
}

function fileMenu() {
  return {
    label: '&File',
    submenu: [
      { id: 'file-new', label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
      { id: 'tab-new', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('tab:new') },
      { type: 'separator' },
      { id: 'file-open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
      { id: 'folder-open', label: 'Open Folder…', click: () => send('folder:open') },
      { id: 'file-open-recent', label: 'Open Recent', submenu: recentSubmenu() },
      { type: 'separator' },
      { id: 'file-save', label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
      {
        id: 'file-save-as',
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => send('file:saveAs')
      },
      {
        id: 'file-export-html',
        label: 'Export as HTML…',
        click: () => send('file:export-html')
      },
      { type: 'separator' },
      // CmdOrCtrl+W closes a tab, not the window — the renderer decides whether the
      // last tab closing should also close the window.
      {
        id: 'tab-close',
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => send('tab:close')
      },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Quit' }])
    ]
  }
}

function editMenu() {
  return {
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      { id: 'edit-find', label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') }
    ]
  }
}

function viewMenu() {
  return {
    label: '&View',
    submenu: [
      {
        id: 'mode-source',
        label: 'Source Mode',
        type: 'radio',
        checked: currentState.mode === 'source',
        accelerator: 'CmdOrCtrl+1',
        click: () => send('mode:source')
      },
      {
        id: 'mode-rich',
        label: 'Rich Text Mode',
        type: 'radio',
        checked: currentState.mode === 'rich',
        accelerator: 'CmdOrCtrl+2',
        click: () => send('mode:rich')
      },
      {
        id: 'mode-split',
        label: 'Split View',
        type: 'radio',
        checked: currentState.mode === 'split',
        accelerator: 'CmdOrCtrl+4',
        click: () => send('mode:split')
      },
      {
        id: 'mode-reading',
        label: 'Reading Mode',
        type: 'radio',
        checked: currentState.mode === 'reading',
        accelerator: 'CmdOrCtrl+3',
        click: () => send('mode:reading')
      },
      { type: 'separator' },
      {
        // Second, visible binding for split — the reference editor uses Ctrl+H.
        // Deliberately a normal item, not a hidden one: hidden-item accelerators
        // are only reliable on macOS. Literal Ctrl (not CmdOrCtrl) because Cmd+H
        // is macOS's reserved Hide shortcut.
        id: 'mode-split-toggle',
        label: 'Toggle Split View',
        accelerator: 'Ctrl+H',
        click: () => send('mode:split')
      },
      {
        id: 'mode-cycle',
        label: 'Cycle Mode',
        accelerator: 'CmdOrCtrl+E',
        click: () => send('mode:cycle')
      },
      { type: 'separator' },
      {
        id: 'view-toggle-sidebar',
        label: 'Toggle Sidebar',
        accelerator: 'CmdOrCtrl+B',
        click: () => send('view:toggle-sidebar')
      },
      {
        id: 'view-toggle-wrap',
        label: 'Toggle Word Wrap',
        accelerator: 'Alt+Z',
        click: () => send('view:toggle-wrap')
      },
      { type: 'separator' },
      // Zoom is handled entirely by the renderer (CSS), not Electron's webContents zoom roles.
      {
        id: 'view-zoom-in',
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        click: () => send('view:zoom-in')
      },
      {
        // Hidden twin so both Ctrl+= and Ctrl+Shift+= reach zoom-in on common layouts.
        id: 'view-zoom-in-alt',
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+=',
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: () => send('view:zoom-in')
      },
      {
        id: 'view-zoom-out',
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: () => send('view:zoom-out')
      },
      {
        id: 'view-zoom-reset',
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        click: () => send('view:zoom-reset')
      },
      { type: 'separator' },
      {
        label: 'Appearance',
        submenu: [
          {
            id: 'theme-dark',
            label: 'Dark',
            type: 'radio',
            checked: currentState.theme === 'dark',
            click: () => send('theme:dark')
          },
          {
            id: 'theme-light',
            label: 'Light',
            type: 'radio',
            checked: currentState.theme === 'light',
            click: () => send('theme:light')
          },
          {
            id: 'theme-system',
            label: 'System',
            type: 'radio',
            checked: currentState.theme === 'system',
            click: () => send('theme:system')
          },
          { type: 'separator' },
          {
            id: 'theme-toggle',
            label: 'Toggle Theme',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => send('theme:toggle')
          }
        ]
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
}

function windowMenu() {
  return {
    label: '&Window',
    submenu: [
      // No accelerators here on purpose: Ctrl+Tab / Ctrl+Shift+Tab are unreliable as
      // Electron menu accelerators on Windows, and a half-registered accelerator would
      // race the renderer's keydown handler and switch tabs twice. The renderer owns
      // those two keys; these items exist for discoverability and mouse users.
      { id: 'tab-next', label: 'Next Tab', click: () => send('tab:next') },
      { id: 'tab-prev', label: 'Previous Tab', click: () => send('tab:prev') },
      { type: 'separator' },
      ...(isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }])
    ]
  }
}

function helpMenu() {
  return {
    role: 'help',
    label: '&Help',
    submenu: [
      { id: 'help-about', label: 'About Forme', click: () => send('help:about') },
      {
        label: 'Markdown Guide',
        click: () => shell.openExternal('https://commonmark.org/help/')
      }
    ]
  }
}

function appMenu() {
  return {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
}

function template() {
  return [
    ...(isMac ? [appMenu()] : []),
    fileMenu(),
    editMenu(),
    viewMenu(),
    windowMenu(),
    helpMenu()
  ]
}

/**
 * Build and install the application menu.
 * onCommand(command, payload) is called for every non-role menu item.
 */
export function buildMenu({ onCommand, state } = {}) {
  if (typeof onCommand === 'function') currentOnCommand = onCommand
  if (state) currentState = { ...currentState, ...state }
  recentSignature = signatureOf(getSettings().recentFiles)

  // Windows/Linux run a frameless window and draw their own menu in the renderer,
  // so no native menu bar is installed there (an installed one would also reserve
  // a strip of the client area). macOS keeps the real menu: the application menu
  // is mandatory there, and `titleBarStyle: 'hiddenInset'` still shows the system
  // menu bar at the top of the screen.
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return null
  }

  const menu = Menu.buildFromTemplate(template())
  Menu.setApplicationMenu(menu)
  return menu
}

/**
 * Sync checkmarks (and the recent-files submenu) with renderer state.
 * Cheap path flips the radio items in place; only a changed recent list forces a rebuild.
 */
export function applyMenuState(state) {
  if (state) currentState = { ...currentState, ...state }

  // No native menu off macOS — the renderer draws its own and keeps itself in sync
  // from its own state plus the `settings:changed` push (which carries recentFiles).
  if (!isMac) {
    recentSignature = signatureOf(getSettings().recentFiles)
    return null
  }

  const menu = Menu.getApplicationMenu()
  const nextSignature = signatureOf(getSettings().recentFiles)
  if (!menu || nextSignature !== recentSignature) {
    return buildMenu({})
  }

  const check = (id, on) => {
    const item = menu.getMenuItemById(id)
    if (item) item.checked = on
  }

  check('mode-source', currentState.mode === 'source')
  check('mode-rich', currentState.mode === 'rich')
  check('mode-split', currentState.mode === 'split')
  check('mode-reading', currentState.mode === 'reading')
  check('theme-dark', currentState.theme === 'dark')
  check('theme-light', currentState.theme === 'light')
  check('theme-system', currentState.theme === 'system')

  return menu
}

export function getMenuState() {
  return { ...currentState }
}
