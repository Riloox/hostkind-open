# Navigation
##
* [Home](https://docs.minecraftforge.net/en/latest/)
* [Contributing to the Docs](https://docs.minecraftforge.net/en/latest/contributing/)
* Getting Started
* [Introduction](https://docs.minecraftforge.net/en/latest/gettingstarted/)
* The Mod Files
* mods.toml
* Mod Entrypoints

...

# Mod Files
## mods.toml
```toml
  Lets you craft dirt into diamonds. This is a traditional mod that has existed for eons. It is ancient. The holy Notch created it. Jeb rainbowfied it. Dinnerbone made it upside down. Etc.
  '''
  displayTest="MATCH_VERSION"

[[dependencies.examplemod]]
  modId="forge"
  mandatory=true
  versionRange="[52,)"
  ordering="NONE"
  side="BOTH"

[[dependencies.examplemod]]
  modId="minecraft"
  mandatory=true
  versionRange="1.21.1,)"
  ordering="NONE"
  side="BOTH"
```

...

### Non-Mod-Specific Properties[
Can be used to support alternative language structures, such as Kotlin objects for the main file, or different methods of determining the entrypoint, such as an interface or method. Forge provides the Java loader "javafml" and low/no code loader "lowcodefml". | "javafml" |
| loaderVersion | string | **mandatory** | The acceptable version range of the language loader, expressed as a [Maven Version Range](https://maven.apache.org/enforcer/enforcer-rules/versionRanges.html). For javafml and lowcodefml, the version is the major version of the Forge version. | "[46,)" |

...

| clientSideOnly | boolean | false | When true, Forge will skip loading all mods declared in the mods.toml when running on a dedicated server, and set a correct displayTest for each of them when running on a client. | true |
| services | array | [] | An array of services your mod **uses**.
This is consumed as part of the created module for the mod from Forge’s implementation of the Java Platform Module System.
This is deprecated in favour of the standard Java methods for declaring services, namely individual service files or module-info.java [uses directive](https://docs.oracle.com/javase/specs/jls/se17/html/jls-7.html.7.3) | ["net.minecraftforge.forgespi.language.IModLanguageProvider"] |

...

The `services` property is functionally equivalent to specifying the [uses directive in a module](https://docs.oracle.com/javase/specs/jls/se17/html/jls-7.html.7.3), which allows [_loading_](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/ServiceLoader.html%28java.lang.Class%29) a

...

### Mod-Specific Properties
| Property | Type | Default | Description | Example |
| modId | string | **mandatory** | The unique identifier representing this mod. The id must match ^[a-z][a-z0-9_]{1,63}$ (a string 2-64 characters; starts with a lowercase letter; made up of lowercase letters, numbers, or underscores). | "examplemod" |

...

| features | table | {} | See ‘features’. | { java_version = "17" } |
| modproperties | table | {} | A table of key/values associated with this mod. Currently unused by Forge, but is mainly for use by mods. | { example = "value" } |
| modUrl | string | _nothing_ | A URL to the download page of the mod.

...

#### Features
| Feature | Description | Example |
| java_version | The acceptable version range of the Java version, expressed as a [Maven Version Range](https://maven.apache.org/enforcer/enforcer-rules/versionRanges.html). This should be the supported version used by Minecraft. | "\17,)" |

### Dependency Configurations[
Mods can specify their dependencies, which are checked by Forge before loading the mods. These configurations are created using the [array of tables](https://toml.io/en/v1.0.0) `[[dependencies.<modid>]]` where `modid` is the identifier of the mod the dependency is for.
| Property | Type | Default | Description | Example |
| versionRange | string | "" | The acceptable version range of the language loader, expressed as a [Maven Version Range](https://maven.apache.org/enforcer/enforcer-rules/versionRanges.html). An empty string matches any version. | "[1, 2)" |
| ordering | string | "NONE" | Defines if the mod must load before ("BEFORE") or after ("AFTER") this dependency. If the ordering does not matter, return "NONE" | "AFTER" |

...

## Mod Entrypoints
Now that the `mods.toml` is filled out, we need to provide an entrypoint to being programming the mod. Entrypoints are essentially the starting point for executing the mod. The entrypoint itself is determined by the language loader used in the `mods.toml`.

### `javafml` and `@Mod`
`javafml` is a language loader provided by Forge for the Java programming language. The entrypoint is defined using a public class with the `@Mod` annotation. The value of `@Mod` must contain one of the mod ids specified within the `mods.toml`.

...

The mod bus can be obtained from `FMLJavaModLoadingContext` which is fed through as a constructor parameter.
```java
@Mod("examplemod") // Must match mods.toml
public class Example {

  public Example(FMLJavaModLoadingContext context) {
    // Initialize logic here
    var modBus = context.getModEventBus();

    // ...
  }
}
```

### `lowcodefml`
`lowcodefml` is a language loader used as a way to distribute datapacks and resource packs as mods without the need of an in-code entrypoint. It is specified as `lowcodefml` rather than `nocodefml` for minor additions in the future that might require minimal coding.