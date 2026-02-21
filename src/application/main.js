import { app, BrowserWindow, Menu } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';

// Recreate __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Menu.setApplicationMenu(null);

function createMainWindow() {
    const mainWindow = new BrowserWindow({
        title: 'AssCrack',
        width: 800,
        height: 600
    });

    const startUrl = new URL(`file://${path.join(__dirname, 'index.html')}`).href;

    mainWindow.loadURL(startUrl);
}

app.whenReady().then(createMainWindow);