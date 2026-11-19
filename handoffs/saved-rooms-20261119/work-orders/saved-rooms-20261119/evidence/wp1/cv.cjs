const Database = require('better-sqlite3-multiple-ciphers');
const db = new Database(':memory:');
const r = {};
for (const p of ['cipher_version', 'cipher', 'legacy']) { try { r[p] = db.pragma(p); } catch (e) { r[p] = 'ERR ' + e.message; } }
r.mc = db.prepare('SELECT sqlite3mc_version() v').pluck().get();
try { r.cfg = db.prepare("SELECT sqlite3mc_config('default:cipher') v").pluck().get(); } catch (e) { r.cfg = 'ERR ' + e.message; }
try { r.cipherlist = db.prepare("SELECT sqlite3mc_cipher_name(1) a, sqlite3mc_cipher_name(2) b, sqlite3mc_cipher_name(3) c, sqlite3mc_cipher_name(4) d, sqlite3mc_cipher_name(5) e, sqlite3mc_cipher_name(6) f").get(); } catch (e) { r.cipherlist = 'ERR ' + e.message; }
console.log(JSON.stringify(r));
