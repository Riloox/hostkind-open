Content mirrored for search engine indexing from:

📅 Last Modified: Tue, 04 Nov 2025 19:40:18 GMT

# Server Troubleshooting - Valheim-Modding/Wiki GitHub Wiki

# Dedicated Server Troubleshooting

This is a collection of common problems and solutions for not working modded dedicated servers.

## TL;DR

`BepInEx/LogOutput.log`
`start_headless_server.bat`
`%*`

## Failed to Connect

![image](https://user-images.githubusercontent.com/39767545/208296944-e74d4dfa-31cc-4520-a91b-e19933baeab2.png)

![image](https://user-images.githubusercontent.com/39767545/208296944-e74d4dfa-31cc-4520-a91b-e19933baeab2.png)

If you get this error window, it probably means you could not reach the server. Make sure the server is running. Some server host will reassign your URL/IP address on game updates, make sure you are connecting to the right one. If you switched between crossplay and non-crossplay, Valheim sometimes remembers this and wants to connect to the old server. Remove the server from your recent connection list in-game and add it again to refresh it.

Make sure BepInEx is up to date. Game updates can occasionally break the BepInEx pack, and using the wrong version will cause the server to crash on startup. It can be downloaded from here [BepInExPack Valheim](https://valheim.thunderstore.io/package/denikson/BepInExPack_Valheim). Do not use the BepInEx release from GitHub as it is not configured to work with Valheim.

## BepInEx/Mods are not Starting

Many mods only need to be enabled on the client but some have to be installed on the server to synchronize configs or perform a version check. If you were able to connect with some client mods installed, it does not imply that mods have been loaded on the server. To tell if a mod has loaded on a server, check for a log file at `BepInEx/LogOutput.log`. If this file does not appear, BepInEx has not loaded. If it does appear, be sure that the file is up-to-date by either looking at the last modification time or shutting the server down, deleting the file and rebooting the server to generate a new file. By default, the log file is overwritten on every successful startup.

`BepInEx/LogOutput.log`

If you do have the server log file you will see lines such as `[Info : BepInEx] Loading [ModName 1.0.0]` for every mod that was successfully loaded. You can compare your client an server log files in a text editor (such as VSCode or Notepad++) to quickly identify differences. As a reminder, client-only mods do not need to be installed on a server (If using Thunderstore check the mod tags). If you see errors in your log file consult the client troubleshooting guide for more information.

`[Info : BepInEx] Loading [ModName 1.0.0]`

### Jotunn Information Pop-up

![](https://raw.githubusercontent.com/Valheim-Modding/Wiki/refs/heads/main/Jotunn_Failed.png)

If you get this pop-up you were able to reach the server but there was a mod mismatch. This specific pop-up will only appear if you have a Jotunn mod installed, but does not always mean a mod using Jotunn has failed the connection attempt. Any failed connection by any mod can trigger this window. This pop-up can sometimes give you specific advice on how to fix your mod installation. If the remote version list is empty it is very likely BepInEx is not starting on your server. Follow the steps below to ensure BepInEx is starting:

### Externally Hosted

Many server host support mods, but require you to toggle on a setting for the BepInEx mod loader. You may have added your mod files to the server but they will not start unless this toggle is on. A common issue with some Valheim server hosts is that ValheimPlus must to be enabled in order to start BepInEx. Even if BepInEx is manually installed this can be the case. If you have a web interface and a V+ switch, make sure to turn it on and restart the server. If you do not want to run V+ you can delete the `ValheimPlus.dll` or install [Valheim Minus](https://valheim.thunderstore.io/package/Azumatt/Valheim_Minus/). This is no offense to the ValheimPlus mod itself but the host companies, nobody should be forced to use a mod they do not want.

`ValheimPlus.dll`

### Self-Hosted

If you are hosting your own server make sure you have correctly installed BepInEx. The BepInEx pack comes with multiple files (in addition to the BepInEx folder) that must be installed at the top level of your server to work. For docker containers you may need to edit some of the server parameters in your UI. Many containers support BepInEx and can simply be toggled on and it will be installed for you.

#### Bitdefender (Advanced Threat Defense) - Required Exclusion Steps

If you (or your host PC) run Bitdefender, **you must add an Advanced Threat Defense (ATD) exception for `valheim_server.exe`**.
Without this, Bitdefender can silently terminate or quarantine the server process, leading to crashes/hangs or no `BepInEx/LogOutput.log` being created even though you launched the server.

`valheim_server.exe`
`BepInEx/LogOutput.log`

[How to stop Advanced Threat Defense from blocking a trusted app](https://www.bitdefender.com/consumer/support/answer/2393/)

[Video Walkthrough/Tutorial](https://www.youtube.com/watch?v=byqL2jQA6D4)

**Steps (Bitdefender on Windows):**

![Advanced Threat Pane](https://camo.githubusercontent.com/acddf41d4a00c71c14ce0e75ed071a9c9c166e48ddbc524592a135aca672733b/68747470733a2f2f7777772e626974646566656e6465722e636f6d2f6d656469612f75706c6f6164732f323031372f30372f6f70656e2d626974646566656e6465722d616476616e6365642d7468726561742d646566656e73652d373638783533362e706e67)
![Settings Tab](https://camo.githubusercontent.com/4fd1f567dbca346e03effc79fa4ac8bfab0445daf21df6a1d9d4143a9847fee3/68747470733a2f2f7777772e626974646566656e6465722e636f6d2f6d656469612f75706c6f6164732f323031372f30372f626974646566656e6465722d616476616e6365642d7468726561742d646566656e73652d6d616e6167652d657863657074696f6e732d373638783532332e706e67)

![Add an Exception](https://camo.githubusercontent.com/d3b647f45d952775681ddb878c28ff4ca162f3c616c32b1d7600f2990349e9dd/68747470733a2f2f7777772e626974646566656e6465722e636f6d2f6d656469612f75706c6f6164732f323031372f30372f626974646566656e6465722d616476616e6365642d7468726561742d646566656e73652d6164642d616e2d657863657074696f6e2d373638783532372e706e67)

![Add an Exception](https://camo.githubusercontent.com/d3b647f45d952775681ddb878c28ff4ca162f3c616c32b1d7600f2990349e9dd/68747470733a2f2f7777772e626974646566656e6465722e636f6d2f6d656469612f75706c6f6164732f323031372f30372f626974646566656e6465722d616476616e6365642d7468726561742d646566656e73652d6164642d616e2d657863657074696f6e2d373638783532372e706e67)
`C:\Program Files (x86)\Steam\steamapps\common\Valheim dedicated server\valheim_server.exe`
`valheim_server.exe`

**Tips:**

`.exe`
`BepInEx/LogOutput.log`
`valheim_server.exe`

Example Error you might see in your Player.log file (note: not BepInEx/LogOutput.log!)

C:\Program Files\Bitdefender\Bitdefender Security\bdhkm\dlls\_268005067768265260\bdhkm64.dll:bdhkm64.dll (00007FF9209E0000), size: 897024 (result: 0), SymType: '-exported-', PDB: 'C:\Program Files\Bitdefender\Bitdefender Security\bdhkm\dlls\_268005067768265260\bdhkm64.dll', fileVersion: 1.12.237.0
C:\Program Files\Bitdefender\Bitdefender Security\atcuf\dlls\_268005067752227730\atcuf64.dll:atcuf64.dll (00007FF920800000), size: 1937408 (result: 0), SymType: '-exported-', PDB: 'C:\Program Files\Bitdefender\Bitdefender Security\atcuf\dlls\_268005067752227730\atcuf64.dll', fileVersion: 1.77.427.0

This part of the stack trace is the most important, as it is showing the crash immediately following all of the logs about Bitdefender.
![image](https://private-user-images.githubusercontent.com/80414405/509768297-9f4dd057-a6cf-45b1-9fc3-53081198366d.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODc3OTUwMjAsIm5iZiI6MTc4Nzc5NDcyMCwicGF0aCI6Ii84MDQxNDQwNS81MDk3NjgyOTctOWY0ZGQwNTctYTZjZi00NWIxLTlmYzMtNTMwODExOTgzNjZkLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjA4MjclMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwODI3VDAxMzg0MFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPWYxM2FiNDhiYWIzZTdhYjc0M2Y0ZDgyMTZjNTA1Y2NlMDk1NmEwNzUyMzQyOGI0NDkyNGVmM2Q1M2JhYTRiNWYmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JnJlc3BvbnNlLWNvbnRlbnQtdHlwZT1pbWFnZSUyRnBuZyJ9.c-lY431YnY2fFTXJZ651qU6YJvsmg2KEn-xbmxBJ5i8)

![image](https://private-user-images.githubusercontent.com/80414405/509768297-9f4dd057-a6cf-45b1-9fc3-53081198366d.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODc3OTUwMjAsIm5iZiI6MTc4Nzc5NDcyMCwicGF0aCI6Ii84MDQxNDQwNS81MDk3NjgyOTctOWY0ZGQwNTctYTZjZi00NWIxLTlmYzMtNTMwODExOTgzNjZkLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjA4MjclMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwODI3VDAxMzg0MFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPWYxM2FiNDhiYWIzZTdhYjc0M2Y0ZDgyMTZjNTA1Y2NlMDk1NmEwNzUyMzQyOGI0NDkyNGVmM2Q1M2JhYTRiNWYmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JnJlc3BvbnNlLWNvbnRlbnQtdHlwZT1pbWFnZSUyRnBuZyJ9.c-lY431YnY2fFTXJZ651qU6YJvsmg2KEn-xbmxBJ5i8)

and of course, it points to more crash logs if that didn't give it away.
![image](https://private-user-images.githubusercontent.com/80414405/509769317-38c810ee-2428-4696-8ddd-1539226d2eac.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODc3OTUwMjAsIm5iZiI6MTc4Nzc5NDcyMCwicGF0aCI6Ii84MDQxNDQwNS81MDk3NjkzMTctMzhjODEwZWUtMjQyOC00Njk2LThkZGQtMTUzOTIyNmQyZWFjLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjA4MjclMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwODI3VDAxMzg0MFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTAzYjJhZmFiMmE1YTc3YjUzYTkxMjA3NTViOTVkZGFmY2Y3YmIzNWZlOTBjZGQ4N2JmZDNiMjJjZjU2NjQyZDEmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JnJlc3BvbnNlLWNvbnRlbnQtdHlwZT1pbWFnZSUyRnBuZyJ9.tz7KYoty33MiFZ8JYdd12QHQW3IT9e4EIscsRX1vKuE)

![image](https://private-user-images.githubusercontent.com/80414405/509769317-38c810ee-2428-4696-8ddd-1539226d2eac.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODc3OTUwMjAsIm5iZiI6MTc4Nzc5NDcyMCwicGF0aCI6Ii84MDQxNDQwNS81MDk3NjkzMTctMzhjODEwZWUtMjQyOC00Njk2LThkZGQtMTUzOTIyNmQyZWFjLnBuZz9YLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFWQ09EWUxTQTUzUFFLNFpBJTJGMjAyNjA4MjclMkZ1cy1lYXN0LTElMkZzMyUyRmF3czRfcmVxdWVzdCZYLUFtei1EYXRlPTIwMjYwODI3VDAxMzg0MFomWC1BbXotRXhwaXJlcz0zMDAmWC1BbXotU2lnbmF0dXJlPTAzYjJhZmFiMmE1YTc3YjUzYTkxMjA3NTViOTVkZGFmY2Y3YmIzNWZlOTBjZGQ4N2JmZDNiMjJjZjU2NjQyZDEmWC1BbXotU2lnbmVkSGVhZGVycz1ob3N0JnJlc3BvbnNlLWNvbnRlbnQtdHlwZT1pbWFnZSUyRnBuZyJ9.tz7KYoty33MiFZ8JYdd12QHQW3IT9e4EIscsRX1vKuE)

If you're asking, "but how did you know it was Bitdefender?" here is a breakdown

The crashing thread’s top frames are Bitdefender’s keyboard/heuristics module:
bdhkm64.dll → BdhkmIsApiInDllImports with “Attempt to access invalid address.”

Immediately under that is Microsoft’s Party voice stack:
many calls to PartyWin32!PartyTextToSpeechProfileSetCustomContext

This is a classic “security product DLL injection + game/voice TTS init” conflict.

#### Thunderstore Mod Manager (or r2modman)

The Valheim script to start a server cuts off all additional parameters set by the mod managers. Edit the `start_headless_server.bat` inside the Steam Valheim Dedicated Server folder and append `%*` at the line where the server is launched:

`start_headless_server.bat`
`%*`

![image](https://user-images.githubusercontent.com/39767545/227964979-9c7f2fb1-c50b-4470-94aa-9020aad9a417.png)

![image](https://user-images.githubusercontent.com/39767545/227964979-9c7f2fb1-c50b-4470-94aa-9020aad9a417.png)

Be aware that the mod manager uses the same folder location for both the server and client when hosted from the same machine by default. If you use the mod manager to launch both (the client and server) you may run into issues with some mods. If you encounter issues using the mod manager for your server try doing a manual mod installation for your server.

It's recommended to not use crossplay as a decent amount of mods don't support it.
but it's crucial that you have a server profile, and a client profile.
Making them the same will cause file locks and BepInEx issues.
(since BepInEx preloader will crash or state it's already running....because it is)
Once you boot your server, back out (going to settings and change game)
and switch to game mode. Then, choose Valheim game/your game profile.

## Blackscreen After Connection Attempt

This can mean a mod uses an outdated ServerSync version internally. You can try to use the [ServerSyncFix](https://valheim.thunderstore.io/package/JereKuusela/Server_Sync_Fix/) by Jere, which patches and writes the likely trouble mods to your console or log file. Be aware that this is only a short term workaround, the causing mods are no longer supported by their authors and could break at any time. Please read that mod description for more information on this issue.

## Specific Valheim Server Hosts

No information at this time.

###### ⚠️ \*\*GitHub.com Fallback\*\* ⚠️