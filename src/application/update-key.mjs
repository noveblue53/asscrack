// P9C: the public key of the update signature (Ed25519, the base64url text of the 32 raw bytes).
//
// This is the operator's release key (made 2026-11-22 with tools/update-key.mjs). The private key is outside each
// repository, in %USERPROFILE%\.asscrack-release\update-key.pem on the release PC. A new key stops the updates of each
// client that has this key. The steps: docs/RELEASE_UPDATES.md.
export const UPDATE_PUBLIC_KEY = 'TywzgU0xhijXJ3jk0foqNLKiPrllQmrpFypR2YLKJ4c';
export const UPDATE_KEY_IS_TEST = false;
