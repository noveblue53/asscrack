export default ()
//const {app, BrowserWindow} = require('electron'); 
import {app, BrowserWindow} from "electron";
//const url = require('url');
import { url } from "url";
//const path = require('path');
import { path } from "path";
//const { Menu } = require('electron');
import { Menu } from "electron";

Menu.setApplicationMenu(null);

function createMainWindow() {
    const mainWindow = new BrowserWindow({
        title: 'AssCrack',
        width: 800,
        height: 600
        
    });


        const startUrl = url.format({
            pathname: path.join(__dirname, 'index.html'),
            protocol: 'file:',
        });

        mainWindow.loadURL(startUrl);

}

app.whenReady().then(createMainWindow);
        
    