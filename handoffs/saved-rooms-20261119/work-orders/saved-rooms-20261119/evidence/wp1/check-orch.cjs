const path = require('path'), fs = require('fs');
const Database = require(process.argv[2]);
const f = path.join(process.argv[3], 'orch-check.db');
for (const s of ['', '-journal', '-wal']) fs.rmSync(f + s, { force: true });
const open = (key) => { const d = new Database(f); if (key !== null) { d.pragma("cipher='sqlcipher'"); d.pragma('legacy=4'); d.pragma(`key='${key}'`); } return d; };
let d = open('right-key'); d.exec('CREATE TABLE t(x TEXT)'); d.prepare('INSERT INTO t VALUES (?)').run('marker-ORCH-123'); 
const ver = d.prepare('SELECT sqlite3mc_version() AS v').get().v; d.close();
const out = { runtime: process.versions.electron ? 'electron ' + process.versions.electron : 'node ' + process.version, modules: process.versions.modules, ver };
d = open('right-key'); out.read = d.prepare('SELECT x FROM t').all(); d.close();
for (const [label, key] of [['wrong', 'wrong-key'], ['plain', null]]) { try { d = open(key); out[label] = d.prepare('SELECT x FROM t').all(); } catch (e) { out[label] = e.code + ' ' + e.message; } try { d.close(); } catch {} }
out.markerInFile = fs.readFileSync(f).includes(Buffer.from('marker-ORCH-123'));
console.log(JSON.stringify(out));
