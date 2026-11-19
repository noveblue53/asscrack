'use strict';
// F1 (goal 7): use build/portable.nsi in place of the stock portable launcher template of electron-builder.
//
// The stock template deletes the unpack folder (%TEMP%\ASSCRACK, decision 60) before it unpacks, also when a copy
// of the app runs from it. app-builder-lib 26.18.0 has no option for a custom portable template: the portable
// target always reads templates/nsis/portable.nsi, and nsis.script and nsis.include apply only to the installer
// targets. Thus this artifactBuildStarted hook gives the custom template to the NSIS target through the fs-extra
// readFile of app-builder-lib, in memory only. It changes no file in node_modules.
//
// The hook stops the build when the stock template is not the one that build/portable.nsi comes from. Then an
// upgrade of electron-builder cannot remove the fix without a message. To update: compare the new stock template
// with build/portable.nsi, apply the ASSCRACK parts again, and set STOCK_SHA256 to the new value.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STOCK_SHA256 = '80fa75cf8cb68f4999eb92afc9f37f8e5b605cb1c3a077821bbc350a9b907a48';
const CUSTOM_TEMPLATE = path.join(__dirname, 'portable.nsi');

let installed = false;

function install() {
    if (installed) return;
    // The modules that the NSIS target of electron-builder uses (the copy that runs, not an other copy).
    const builderRequire = require('module').createRequire(require.resolve('electron-builder'));
    const libRequire = require('module').createRequire(builderRequire.resolve('app-builder-lib'));
    const nsisUtil = libRequire('app-builder-lib/out/targets/nsis/nsisUtil');
    const fsExtra = libRequire('fs-extra');
    const stockPath = path.join(nsisUtil.nsisTemplatesDir, 'portable.nsi');

    const stockHash = crypto.createHash('sha256').update(fs.readFileSync(stockPath)).digest('hex');
    if (stockHash !== STOCK_SHA256) {
        throw new Error(`portable-launcher: the stock template ${stockPath} changed (SHA-256 ${stockHash}). ` +
            'Update build/portable.nsi and STOCK_SHA256 in build/portable-launcher.cjs.');
    }
    const custom = fs.readFileSync(CUSTOM_TEMPLATE, 'utf8');

    const originalReadFile = fsExtra.readFile;
    fsExtra.readFile = function readFile(file, ...rest) {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(stockPath)) {
            console.log(`  • portable-launcher: custom launcher template ${CUSTOM_TEMPLATE}`);
            return Promise.resolve(custom);
        }
        return originalReadFile.call(this, file, ...rest);
    };
    installed = true;
}

module.exports = async function artifactBuildStarted(context) {
    if (context && context.targetPresentableName === 'portable') install();
};
