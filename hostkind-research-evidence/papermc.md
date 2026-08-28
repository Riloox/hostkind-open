# Basic troubleshooting
Both error messages and exception messages were put there by the developer of either your plugin or Paper. These messages tell you what problem your server experienced. An exception type like `java.lang.RuntimeException` tells you the type of the exception.

...

# Common issues
## Plugin-induced issues
### Check documentation
Section titled “Check documentation”
If you misconfigured your plugin or your server, it can also cause problems on your server. Many plugins provide their own documentation about how to set them up properly. Read those documents carefully and check if there is something wrong with the plugin’s configuration.

...

## Server does not start
### Checking your startup script
In case you get an error similar to `Error: Unable to access jarfile server.jar` , make sure that the .jar name in your startup script is the same as the file you downloaded.

...

### Failed to bind to port
1. A server is already running, check your task manager app for Java processes.
2. `server-ip` , in `server.properties` , is configured incorrectly. Note that this option is not a placeholder for your external IP, it controls which network interfaces your server will bind to.

...

### Attempted to load chunk saved with newer version
```
java.lang.RuntimeException: Server attempted to load chunk saved with newer version of minecraft! 3955 > 3465 [18:23:38 WARN]:        at net.minecraft.world.level.chunk.storage.ChunkRegionLoader.loadChunk(ChunkRegionLoader.java:149) [18:23:38 WARN]:        at io.papermc.paper.chunk.s
ystem.scheduling.ChunkLoadTask$ChunkDataLoadTask.runOffMain(ChunkLoadTask.java:338) [18:23:38 WARN]:        at io.papermc.paper.chunk.system.scheduling.GenericDataLoadTask$ProcessOffMainTask.run(GenericDataLoadTask.java:307) [18:23:38 WARN]:        at ca.spottedleaf.concurrentutil.ex
```

...

Forcing the server to try to load a newer world
The server will start if you use the `-DPaper.ignoreWorldDataVersion=true` flag. However, this is **highly not recommended, completely unsupported and may permanently corrupt your world** . If you’re going to attempt this, take a backup.

...

### Circular plugin loading
There’s often a problematic plugin involved, and to solve this, it’s preferable that you report the issue to its authors. Removing it should also fix the issue. As a last resort, you can use the `-Dpaper.useLegacyPluginLoading=true` startup flag, but it may cause hard to debug issues.

...

### Outdated version of Java
```
Exception in thread "ServerMain" java.lang.UnsupportedClassVersionError: org/bukkit/craftbukkit/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0 at java.base/java.lang.ClassLoader.de
fineClass1(Native Method) at java.base/java.lang.ClassLoader.defineClass(ClassLoader.java:1017) at java.base/java.security.SecureClassLoader.defineClass(SecureClassLoader.java:150) at java.base/java.net.URLClassLoader.defineClass(URLClassLoader.java:524) at java.base/java.net.URLClassLoader$1.run(URLClassLo
```

...

```
 java.base/java.lang.ClassLoader.loadClass(ClassLoader.java:525) at java.base/java.lang.Class.forName0(Native Method) at java.base/java.lang.Class.forName(Class.java:467) at io.papermc.paperclip.Paperclip.lambda$main$0(Paperclip.java:38) at java.base/java.lang.Thread.run(Thread.java:842)
```
Your version of Java is outdated, check our guide on updating it . To avoid possibly having to do more tweaks, uninstall your current version of Java, if any.
If you do have the correct version installed, your operating system may be not picking it up.
Make sure you’ve closed and opened your terminal after installing it, and that Java is present in your `PATH` environment variable.

...

## Server crashes or exits unexpectedly
### Unexpected graceful shutdown
Section titled “Unexpected graceful shutdown”
If your server shuts down normally as if you typed `/stop` or pressed a stop button in your panel, enable `debug` in `server.properties` . The next time the server shuts down, you will get a stack trace that will help you debug.

...

### Watchdog dump (“DO NOT REPORT THIS TO PAPER”)
```
[02:04:00] [Paper Watchdog Thread/ERROR]: --- DO NOT REPORT THIS TO PAPER - THIS IS NOT A BUG OR A CRASH  - 1.21.3-66-afb5b13 (MC: 1.21.3) --- [02:04:00] [Paper Watchdog Thread/ERROR]: The server has not responded for 10 seconds! Creating thread dump [02:04:00] [Paper Watchdog Thread/ER
```

...

```
 thread [02:04:00] [Paper Watchdog Thread/ERROR]: PID: 129 | Suspended: false | Native: true | State: RUNNABLE [02:04:00] [Paper Watchdog Thread/ERROR]: Stack: [02:04:00] [Paper Watchdog Thread/ERROR]:  [java.base@21.0.5](mailto:java.base@21.0.5) /sun.nio.ch.UnixFileDispatcherImpl.write
0(Native Method) [02:04:00] [Paper Watchdog Thread/ERROR]:  [java.base@21.0.5](mailto:java.base@21.0.5) /sun.nio.ch.UnixFileDispatcherImpl.write(UnixFileDispatcherImpl.java:65) [02:04:00] [Paper Watchdog Thread/ERROR]:  [java.base@21.0.5](mailto:java.base@21.0.5) /sun.nio.ch.IOUtil.writ
```

...

```
utStream.flushBuffer(BufferedOutputStream.java:125) [02:04:00] [Paper Watchdog Thread/ERROR]:  [java.base@21.0.5](mailto:java.base@21.0.5) /java.io.BufferedOutputStream.implFlush(BufferedOutputStream.java:252) [02:04:00] [Paper Watchdog Thread/ERROR]:  [java.base@21.0.5](mailto:java.bas
```

...

### Crash without logs
Either reduce `-Xmx` (by 1-2GB is a good initial rule of thumb) or increase/disable the memory limits in your panel.
If you’re using a hosting company that only provides you with a panel, you likely won’t have the tools to get to the bottom of the problem. You should make a ticket with your host in this case.