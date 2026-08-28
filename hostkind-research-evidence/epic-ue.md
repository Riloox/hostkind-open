# Crash Reporting
## Crash Reports
### Common Causes of Crashes in Unreal Engine
* Accessing null objects.
* Attempting to write data to objects that do not exist.
* Accessing corrupted objects or data.
* Stack overflows, usually due to infinite loops or infinite recursion.
* Out-of-memory (OOM) errors. | |

...

## Add Custom Context to Crash Reports
The data is added using key/value pairs and using the `FPlatformCrashContext::SetGameData` function.
GenericPlatformCrashContext.h
```
	/** Updates (or adds if not already present) arbitrary game data to the crash context (will remove the key if passed an empty string) */
	CORE_API static void SetGameData(const FString& Key, const FString& Value);
 Copy full snippet
```

...

```
	void OnEnterMyGameMode()
	{
		FPlatformCrashContext::SetGameData(TEXT("GameMode"), TEXT("MyGameModeName"));
	}

	void OnExitMyGameMode()
	{
		FPlatformCrashContext::SetGameData(TEXT("GameMode"), FString());
	}
 Copy full snippet
```

...

## Crash Reporter Infrastructure
1. A **Crash Report Client** on the user’s machine, distributed with builds of the editor or your game. The Crash Report Client sends crash dump info to your endpoint.
2. A **server** with applications and components that manage, filter, and store crash reports.

...

## Crash Reporter Client
### Package the Crash Reporter Client With Your Game
By default, the Crash Reporter Client is not included with packaged games. To add it to your packaged builds:
1. In Unreal Editor, open **Project Settings** and navigate to **Project** > **Packaging** .
2. Unfold the **Advanced** dropdown.
3. Enable the **Include Crash Reporter** setting.
Alternatively, you can add `IncludeCrashReporter=True` to your project’s `Config/DefaultGame.ini` file.
DefaultGame.ini
```
	[/Script/UnrealEd.ProjectPackagingSettings]
	IncludeCrashReporter=True
 Copy full snippet
```
[/Script/UnrealEd.ProjectPackagingSettings]
IncludeCrashReporter=True

### Configure Automatic Crash Reports
The following config variables decide whether or not the crash reporter should automatically send crash reports to the server. You can configure these in any `Engine.ini` file under the `[CrashReportClient]` category.

...

DefaultEngine.ini
```
	[CrashReportClient]
	bAgreeToCrashUpload=false
	bSendUnattendedBugReports=false
 Copy full snippet
```

...

### Configure the Crash Reporter Client
You can customize the Crash Reporter Client to send crash events to a server of your choice. To customize the Crash Reporter:
1. Open your Unreal Engine install directory.
2. Navigate to Engine/Programs/CrashReportClient/Config
3. Open the `DefaultEngine.ini` file.
This config file includes all variables used for configuring the Crash Reporter.
DefaultEngine.ini (Programs/CrashReportClient)
```
	[CrashReportClient]
	DataRouterUrl="https://datarouter.ol.epicgames.com/datarouter/api/v1/public/data"
	bAllowToBeContacted=true
	bSendLogFile=true
	CanSendWhenUIFailedToInitialize=true
	UIInitRetryCount=10
	UIInitRetryInterval=2.0
 Copy full snippet
```
[CrashReportClient]
DataRouterUrl="https://datarouter.ol.epicgames.com/datarouter/api/v1/public/data"
bAllowToBeContacted=true
bSendLogFile=true
CanSendWhenUIFailedToInitialize=true
UIInitRetryCount=10
UIInitRetryInterval=2.0

#### Change the URL to Send Crash Reports To
To send crash reports to your own organization, change the `DataRouterURL` variable to the URL of your own crash report server. Refer to the Crash Report Server section below for more information about how to set up this endpoint.

...

#### Config Variable Reference
| **Config Variable** | **Default Value** | **Description** |
| DataRouterUrl | https://datarouter.ol.epicgames.com/datarouter/api/v1/public/data | A URL pointing to your crash report server. |
| bSendLogFile | true | Controls whether the Crash Report Client should send the log file associated with the crash. |
| CanSendWhenUIFailedToInitialize | true | If the Crash Report Client fails to initialize its UI, this controls whether or not to automatically send the crash report. |
| UIInitRetryCount | 10 | Number of times to retry opening the Crash Report Client window before automatically sending a crash report. |
| UIInitRetryInterval | 2 | Number of seconds between retry attempts. |

...

## Crash Report Server
| [[Bugsplat](https://www.bugsplat.com/)](https://www.bugsplat.com/) | [[Bugsplat -- Unreal Engine](https://docs.bugsplat.com/introduction/getting-started/integrations/game-development/unreal-engine/)](https://docs.bugsplat.com/introduction/getting-started/integrations/game-development/unreal-engine/) |
| [[Sentry](https://sentry.io/welcome/)](https://sentry.io/welcome/) | [[Sentry -- Crash Report Client for Unreal Engine](https://docs.sentry.io/platforms/unreal/configuration/setup-crashreporter/)](https://docs.sentry.io/platforms/unreal/configuration/setup-crashreporter/) |

...

* [Common Causes of Crashes in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/crash-reporting-in-unreal-engine?application_version=5.2)
* [Add Custom Context to Crash Reports](https://dev.epicgames.com/documentation/unreal-engine/crash-reporting-in-unreal-engine?application_version=5.2)