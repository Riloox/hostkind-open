![Palworld](/img/logo.jpg)
![Palworld](/img/logo.jpg)

# Configuration parameters

On this page, you can learn about server settings, game balance settings, and other items that can be set with ini files.

## Location of configuration file[​](#location-of-configuration-file "Direct link to Location of configuration file")

Configuration file should be located at the following location

The directories will only create once the server has been started.

Copy the default configuration file and use that.

`Copy-Item steamapps\common\PalServer\DefaultPalWorldSettings.ini steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`

Edit `steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini` to change settings.

`steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`

Copy the default configuration file and use that.

`Copy-Item steamapps\common\PalServer\DefaultPalWorldSettings.ini steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`

Edit `steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini` to change settings.

`steamapps\common\PalServer\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`

Copy the default configuration file and use that.

`cp steamapps/common/PalServer/DefaultPalWorldSettings.ini steamapps/common/PalServer/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`

Edit `steamapps/common/PalServer/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini` to change settings

`steamapps/common/PalServer/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`

Note that editing `DefaultPalWorldSettings.ini` will not affect the changes.

`DefaultPalWorldSettings.ini`

## Parameters[​](#parameters "Direct link to Parameters")

The settings for each parameter are as follows.

There are reserved for future updates and deprecated parameter.

### Performances[​](#performances "Direct link to Performances")

| Parameters | Description |
| --- | --- |
| BaseCampMaxNum | Total number of bases across the server. |
| BaseCampMaxNumInGuild | Maximum number of bases per guild. Default: 4 (max 10). Increasing this value raises processing load. |
| BaseCampWorkerMaxNum | Maximum number of Pals per base (max 50). Increasing this value raises processing load. |
| ItemContainerForceMarkDirtyInterval | How often to force re-sync while a container UI is open (seconds). |
| MaxBuildingLimitNum | Per-player building count cap (0 = unlimited). |
| PhysicsActiveDropItemMaxNum | Maximum number of dropped items that can use physics behavior. |
| ServerReplicatePawnCullDistance | Pal sync distance from players (cm). Minimum 5000 – maximum 15000. |

### Server management[​](#server-management "Direct link to Server management")

| Parameters | Description |
| --- | --- |
| AdminPassword | Password used to obtain administrative privileges on the server. |
| AllowConnectPlatform | Not available in this version. Use CrossplayPlatforms instead. |
| bAllowClientMod | Allow players with mods enabled to join the server. |
| bEnableBuildingPlayerUIdDisplay | Whether to display the creator’s player ID on structures. |
| bIsShowJoinLeftMessage | On dedicated servers, show in-game messages when players join/leave. |
| bIsUseBackupSaveData | Enable world backups. Enabling this increases disk load. |
| ChatPostLimitPerMinute | Maximum number of chat messages allowed per minute. |
| CrossplayPlatforms | Allowed platform to connect the server. Default: (Steam,Xbox,PS5,Mac) |
| LogFormatType | Log format: Text or Json |
| PublicIP | (Community server) Explicitly specify the external public IP. |
| PublicPort | (Community server) Explicitly specify the external public port. (Does not change the server’s listening port.) |
| RCONEnabled | Enable RCON. |
| RCONPort | Port number used for RCON. |
| RESTAPIEnabled | Enable the REST API. |
| RESTAPIPort | Listening port for the REST API. |
| ServerDescription | Server description |
| ServerName | Server name |
| ServerPassword | Password required to log in to the server. |
| ServerPlayerMaxNum | Maximum number of players who can join the server. |

### Features[​](#features "Direct link to Features")

| Parameters | Description |
| --- | --- |
| AutoResetGuildTimeNoOnlinePlayers | Offline duration before `bAutoResetGuildNoOnlinePlayers` triggers. Ignored if `bAutoResetGuildNoOnlinePlayers` is False. |
| bAllowEnhanceStat\_Attack | Allow allocating stat points to Attack. |
| bAllowEnhanceStat\_Health | Allow allocating stat points to HP. |
| bAllowEnhanceStat\_Stamina | Allow allocating stat points to Stamina. |
| bAllowEnhanceStat\_Weight | Allow allocating stat points to Carry Weight. |
| bAllowEnhanceStat\_WorkSpeed | Allow allocating stat points to Work Speed. |
| bAllowGlobalPalboxExport | Allow saving to the Global Palbox. |
| bAllowGlobalPalboxImport | Allow loading from the Global Palbox. |
| bAutoResetGuildNoOnlinePlayers | If no guild members log in, automatically delete structures and base Pals. |
| bBuildAreaLimit | Prevent building near structures such as fast-travel points. |
| bCharacterRecreateInHardcore | Whether you may recreate your character upon death in Hardcore mode. |
| bDisplayPvPItemNumOnWorldMap\_BaseCamp | Whether to show, on the map, the number of PvP-exclusive items in each base. |
| bDisplayPvPItemNumOnWorldMap\_Player | Whether to show player locations and the number of PvP-exclusive items on the map. |
| bEnableFastTravel | Enable fast travel. |
| bEnableFastTravelOnlyBaseCamp | Restrict fast travel to between bases only. |
| bEnableInvaderEnemy | Enable Invader |
| bEnableVoiceChat | Enable in-game voice chat. |
| bExistPlayerAfterLogout | Whether players enter a sleeping state at their current location when logging out. |
| bHardcore | Enable Hardcore. You will not be able to respawn on death. |
| bInvisibleOtherGuildBaseCampAreaFX | Show base area boundaries. |
| bIsPvP | EnablePvP |
| bIsRandomizerPalLevelRandom | If true, wild Pal levels are fully random. If false, levels are randomized within each area’s intended range. |
| bIsStartLocationSelectByMap | Whether to allow players to choose their starting location. |
| bShowPlayerList | Enable the player list on the ESC menu. |
| RandomizerSeed | Seed value used when Pal spawn randomization mode is enabled. |
| RandomizerType | Pal spawn randomization mode: None = no randomization; Region = randomize per region; All = fully randomized. |
| VoiceChatMaxVolumeDistance | Distance at which voice chat volume does not attenuate. |
| VoiceChatZeroVolumeDistance | Distance at which voice chat volume becomes zero. |

`bAutoResetGuildNoOnlinePlayers`
`bAutoResetGuildNoOnlinePlayers`

### Game balances[​](#game-balances "Direct link to Game balances")

| Parameters | Description |
| --- | --- |
| AdditionalDropItemNumWhenPlayerKillingInPvPMode | When `bAdditionalDropItemWhenPlayerKillingInPvPMode` is enabled, the quantity of the item to drop. |
| AdditionalDropItemWhenPlayerKillingInPvPMode | When `bAdditionalDropItemWhenPlayerKillingInPvPMode` is enabled, the ID of the item to drop. |
| bAdditionalDropItemWhenPlayerKillingInPvPMode | Whether to drop a special item when a player is killed while PvP is enabled. |
| BlockRespawnTime | Cooldown before you can respawn after death (seconds). |
| bPalLost | Permanently lose Pals on death. |
| BuildObjectDamageRate | Damage multiplier to buildings. |
| BuildObjectDeteriorationDamageRate | Building decay speed multiplier. |
| CollectionDropRate | Gatherable items multiplier |
| CollectionObjectHpRate | Gatherable objects health multiplier |
| CollectionObjectRespawnSpeedRate | Gatherable objects respawn interval |
| DayTimeSpeedRate | Daytime progression speed. |
| DeathPenalty | Death Penalty None : No drops, Item : Drop all items except equipment, ItemAndEquipment : Drop all items, All : Drop all items and all Pals on team |
| DenyTechnologyList | Disable specific technologies. Specify [Technology IDs](/settings-and-operation/technologyids) . Example: `DenyTechnologyList=(""PALBOX"", ""RepairBench""))` |
| EnemyDropItemRate | Dropped item quantity multiplier. |
| EquipmentDurabilityDamageRate | Equipment durability loss multiplier. |
| ExpRate | EXP gain multiplier. |
| GuildPlayerMaxNum | Max player number of guild. |
| GuildRejoinCooldownMinutes | Guild rejoin cooldown (minutes). |
| ItemCorruptionMultiplier | Item corruption speed multiplier. |
| ItemWeightRate | Item weight multiplier. |
| MonsterFarmActionSpeedRate | Item production speed multiplier from grazing. |
| NightTimeSpeedRate | Nighttime progression speed. |
| PalAutoHPRegeneRate | Pal natural HP regen multiplier. |
| PalAutoHpRegeneRateInSleep | Pal HP regen while sleeping (in Palbox) multiplier. |
| PalCaptureRate | Capture rate multiplier. |
| PalDamageRateAttack | Damage dealt by Pals multiplier. |
| PalDamageRateDefense | Damage taken by Pals multiplier. |
| PalEggDefaultHatchingTime | Time to hatch a Huge Egg (hours). Note: Other eggs also require time to incubate. |
| PalSpawnNumRate | Pal spawn rate. (Impacts performance.) |
| PalStaminaDecreaceRate | Pal stamina depletion rate multiplier. |
| PalStomachDecreaceRate | Pal hunger depletion rate multiplier. |
| PlayerAutoHPRegeneRate | Player natural HP regen multiplier. |
| PlayerAutoHpRegeneRateInSleep | Player HP regen while sleeping multiplier. |
| PlayerDamageRateAttack | Damage dealt by players multiplier. |
| PlayerDamageRateDefense | Damage taken by players multiplier. |
| PlayerStaminaDecreaceRate | Player stamina depletion rate multiplier. |
| PlayerStomachDecreaceRate | Player hunger depletion rate multiplier. |
| RespawnPenaltyDurationThreshold | Survival-time threshold (seconds) for applying the respawn cooldown multiplier set by RespawnPenaltyTimeScale on a subsequent death. |
| RespawnPenaltyTimeScale | Multiplier applied to the respawn cooldown. |
| SupplyDropSpan | Meteorite / supply drop interval (minutes). |

`bAdditionalDropItemWhenPlayerKillingInPvPMode`
`bAdditionalDropItemWhenPlayerKillingInPvPMode`
`DenyTechnologyList=(""PALBOX"", ""RepairBench""))`

## About bIsUseBackupSaveData[​](#about-bisusebackupsavedata "Direct link to About bIsUseBackupSaveData")

Create `backup` directory in save data directory when enabled this parameter.
Backup interval is below.

`backup`