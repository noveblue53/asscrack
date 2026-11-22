// P9C: the public key of the update signature (Ed25519, the base64url text of the 32 raw bytes).
//
// REPLACE WITH THE OPERATOR'S KEY BEFORE 1.0.0. This value is a throwaway TEST key of the P9C checks on this PC. Its
// private key was only in a scratch folder of those checks. Do not trust it. The steps: docs/RELEASE_UPDATES.md, "Make the key one time". `node tools/update-key.mjs`
// prints the two lines for this file. Then set UPDATE_KEY_IS_TEST to false.
//
// The release check stops a release with the test key: `node tools/sign-update.mjs --check-release` and
// `ASSCRACK_RELEASE=1 node --test test/update-release.test.mjs` fail while UPDATE_KEY_IS_TEST is true.
export const UPDATE_PUBLIC_KEY = '8YENDIajxQUy7EkOWsxXZSgXM0cu2t_ATePUHARopl0';
export const UPDATE_KEY_IS_TEST = true;
