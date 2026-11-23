<div align="center">

<img src="docs/img/icon.png" alt="ASSCRACK icon" width="128" height="128">

# ASSCRACK

**Voice, chat, files and screen share for you and your friends.<br>No server, no sign-up. Just your PCs.**

<sub><b>A</b>utomated <b>S</b>erver <b>S</b>witch in <b>C</b>ase <b>R</b>elays <b>A</b>re <b>C</b>rashed or <b>K</b>illed</sub>

<br>

[![Latest release](https://img.shields.io/github/v/release/noveblue53/asscrack?label=release&color=00a9c6)](https://github.com/noveblue53/asscrack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/noveblue53/asscrack/total?color=07536b)](https://github.com/noveblue53/asscrack/releases)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](https://github.com/noveblue53/asscrack/releases/latest)
[![License: MIT](https://img.shields.io/github/license/noveblue53/asscrack?color=2e7d32)](LICENSE)

<br>

[![Download the installer](https://img.shields.io/badge/Download-Installer-00a9c6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/noveblue53/asscrack/releases/latest)
&nbsp;
[![Download the portable app](https://img.shields.io/badge/Download-Portable-07536b?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/noveblue53/asscrack/releases/latest)

<sub>Pick <code>ASSCRACK-x.y.z-setup.exe</code> to install, or <code>ASSCRACK-x.y.z-portable.exe</code> to run it from any folder.<br>
Windows SmartScreen may warn you the first time: click <b>More info → Run anyway</b>. The app is not code-signed yet.</sub>

<br><br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/hero-dark.webp">
  <img src="docs/img/hero-light.webp" alt="A room called Friday Game Night: three friends chatting, two of them in voice, and a new friend knocking to join" width="900">
</picture>

</div>

## Take a look

<table>
  <tr>
    <td width="33%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/img/login-dark.webp">
        <img src="docs/img/login-light.webp" alt="The start screen: pick a name and create or join a room">
      </picture>
      <br><sub><b>Start a room in seconds</b></sub>
    </td>
    <td width="33%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/img/friends-dark.webp">
        <img src="docs/img/friends-light.webp" alt="The Friends list with two friends online">
      </picture>
      <br><sub><b>Keep your friends close</b></sub>
    </td>
    <td width="33%" align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/img/invite-dark.webp">
        <img src="docs/img/invite-light.webp" alt="The Invite panel of the room owner with room codes and the list of devices">
      </picture>
      <br><sub><b>You decide who gets in</b></sub>
    </td>
  </tr>
</table>

<sub>Shown in the Aero Classic theme, or Aero Night if your GitHub is in dark mode. The app has six themes.</sub>

## What you get

<table>
  <tr>
    <td width="33%" valign="top"><b>Voice</b><br>Push-to-talk or voice activity, with noise suppression and echo cancellation.</td>
    <td width="33%" valign="top"><b>Voice channels</b><br>Split up for a match, then meet back in General.</td>
    <td width="33%" valign="top"><b>Chat with history</b><br>Channels, quotes, search, links and images. Saved rooms keep their history.</td>
  </tr>
  <tr>
    <td valign="top"><b>File sharing</b><br>Drop a file in. Big downloads pick up where they left off.</td>
    <td valign="top"><b>Screen share</b><br>Show your game or your desktop to the room.</td>
    <td valign="top"><b>Friends</b><br>A friends list, invites, and knock-to-join for rooms.</td>
  </tr>
  <tr>
    <td valign="top"><b>One portable folder</b><br>All your data sits in one folder next to the app.</td>
    <td valign="top"><b>Signed updates</b><br>New versions install from inside the app with one click.</td>
    <td valign="top"><b>Diagnostics on your terms</b><br>A report leaves your PC only when you click Send.</td>
  </tr>
</table>

## How it works

- **There is no server.** A room lives on your friends' PCs. If the host leaves, another trusted PC takes over and the room keeps going.
- **Every connection is encrypted** between the two PCs on each end.
- **The owner decides who gets in.** Share a room code or invite a friend, then click Allow when they knock.
- **On the same network**, friends find each other on their own. Over the internet, one of you needs an open port, and the app can ask your router for one.

## Get started

1. **Download** the installer or the portable app from the [latest release](https://github.com/noveblue53/asscrack/releases/latest).
2. **Open ASSCRACK**, pick a name and create a room.
3. **Bring your friends in.** Click **Invite → Copy room code**, send it to them, and click **Allow** when they knock.

## Privacy

No accounts, no ads, no company server in the middle. Your saved chat history stays on your PC, encrypted.
The room host passes voice along to everyone, so make someone you trust the host.
Diagnostics stay on your PC until you choose to send them.

## More

- [Changelog](CHANGELOG.md): what is new in each version
- [Status and roadmap](docs/STATUS.md): test results, known limits and what comes next
- [Development](docs/DEVELOPMENT.md): build from source with `npm run install:clean` (it works on a PC with no VC++ build tools), run the tests, and use the terminal demo
- [License](LICENSE): MIT

## Acknowledgments

- The libp2p team, for the peer-to-peer network stack
- Noveblue, Parker, Sunmanga, HBO Max Verstappen
- Discord ;)
