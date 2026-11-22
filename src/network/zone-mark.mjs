// M3: Windows keeps the Mark-of-the-Web of a file in its alternate data stream Zone.Identifier. ZoneId=3 is the
// Internet zone. SmartScreen, Office Protected View and other programs then warn before they open the file. A file
// from a peer is a file from the internet. The stream stays with the file through link() and rename() on NTFS.
import * as fsp from 'node:fs/promises'

export const ZONE_TEXT = '[ZoneTransfer]\r\nZoneId=3\r\n'

// Writes the mark on the file. A volume with no alternate data streams (FAT, exFAT, some shares) refuses the write:
// the file then has no mark, but the receive continues. Gives true when the mark is on the file.
export async function markFromInternet(file, { platform = process.platform, fs = fsp } = {}) {
    if (platform !== 'win32') return false
    try {
        await fs.writeFile(`${file}:Zone.Identifier`, ZONE_TEXT)
        return true
    } catch {
        return false
    }
}
