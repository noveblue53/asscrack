// The listening choices of this user (G4): the volume (0 to 200 %) and "Mute for me" of each person, per room, in the
// file listening.json of the profile. The key of a person is the device ID of the room membership, never the display
// name. The key of a room is a hash of the room key. The default (not muted, 100 %) is not kept: it removes the entry.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const MAX_VOLUME = 200;
const MAX_ROOMS = 256;
const MAX_PEOPLE = 512;
const MAX_KEY = 128;

const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY;

// A valid choice, or null.
export function validChoice(value) {
    if (!value || typeof value.muted !== 'boolean' || !Number.isInteger(value.volume)) return null;
    if (value.volume < 0 || value.volume > MAX_VOLUME) return null;
    return { muted: value.muted, volume: value.volume };
}

const isDefault = choice => !choice.muted && choice.volume === 100;

// The key of a room: the room key is a secret, thus the file keeps only a hash.
export function listeningRoomTag(roomKey) {
    if (typeof roomKey !== 'string' || !roomKey) return null;
    return createHash('sha256').update('asscrack-listening\0' + roomKey).digest('hex').slice(0, 32);
}

export function listeningStore(file) {
    // room tag -> Map(device ID -> { muted, volume })
    const rooms = new Map();
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        for (const [tag, people] of Object.entries(saved?.rooms ?? {}).slice(0, MAX_ROOMS)) {
            if (!validKey(tag) || !people || typeof people !== 'object') continue;
            const map = new Map();
            for (const [device, value] of Object.entries(people).slice(0, MAX_PEOPLE)) {
                const choice = validKey(device) ? validChoice(value) : null;
                if (choice && !isDefault(choice)) map.set(device, choice);
            }
            if (map.size) rooms.set(tag, map);
        }
    } catch { /* No file yet, or a file that is not valid: start empty. */ }

    function write() {
        const data = { v: 1, rooms: {} };
        for (const [tag, people] of rooms) data.rooms[tag] = Object.fromEntries(people);
        writeFileSync(file + '.tmp', JSON.stringify(data));
        renameSync(file + '.tmp', file);
    }

    return {
        get(tag, device) {
            const choice = rooms.get(tag)?.get(device);
            return choice ? { ...choice } : null;
        },
        // Returns true when the choice is valid. The default choice removes the entry (Reset).
        set(tag, device, value) {
            const choice = validChoice(value);
            if (!validKey(tag) || !validKey(device) || !choice) return false;
            let people = rooms.get(tag);
            if (isDefault(choice)) {
                if (!people?.delete(device)) return true;
                if (!people.size) rooms.delete(tag);
            } else {
                if (!people) {
                    if (rooms.size >= MAX_ROOMS) rooms.delete(rooms.keys().next().value);
                    people = new Map();
                    rooms.set(tag, people);
                }
                people.delete(device);
                if (people.size >= MAX_PEOPLE) people.delete(people.keys().next().value);
                people.set(device, choice);
            }
            write();
            return true;
        },
        // Forget of a saved room removes the choices of that room.
        removeRoom(tag) {
            if (!rooms.delete(tag)) return false;
            write();
            return true;
        }
    };
}
