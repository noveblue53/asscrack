const { app, safeStorage } = require('electron');
app.whenReady().then(() => {
  const out = { available: safeStorage.isEncryptionAvailable() };
  try { out.backend = safeStorage.getSelectedStorageBackend(); } catch (e) { out.backendError = String(e); }
  try {
    const enc = safeStorage.encryptString('test-secret');
    out.encryptedLength = enc.length;
    out.prefix = enc.subarray(0, 3).toString('latin1');
    out.roundTrip = safeStorage.decryptString(enc) === 'test-secret';
  } catch (e) { out.encryptError = String(e); }
  console.log('SAFESTORAGE ' + JSON.stringify(out));
  app.quit();
});
