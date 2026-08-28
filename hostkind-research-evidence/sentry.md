[Skip to content](#main)

[Go to Sentry](https://sentry.io/)

* [Home](/)
* [Concepts & Reference](/concepts/)
* [Data Management](/concepts/data-management/)
* [Issue Grouping](/concepts/data-management/event-grouping/)
* [Fingerprint Rules](/concepts/data-management/event-grouping/fingerprint-rules/)

# Fingerprint Rules

## Learn about fingerprint rules, matchers for fingerprinting, how to combine matchers, and using variables for fingerprinting.

This feature is only applicable for [error issues](/product/issues/issue-details/error-issues/). Other categories of issues (such as [performance issues](/product/issues/issue-details/performance-issues/) or [replay issues](/product/issues/issue-details/replay-issues/)) do not support this feature.

Fingerprint rules (previously known as *server-side fingerprinting*) are configured with a config similar to [stack trace rules](../stack-trace-rules/), but the syntax is slightly different. The matchers are the same, but instead of flipping flags, a fingerprint is assigned and it overrides the default grouping entirely. Assigning a fingerprint can also refine the default grouping rather than overriding it, if the fingerprint includes the value `{{ default }}`.

These rules can be configured on a per-project basis in your project's [Issue Grouping](https://sentry.io/orgredirect/organizations/:orgslug/settings/projects/:projectId/issue-grouping/) settings. This setting has input fields where you can write custom fingerprinting rules. To update a rule:

1. Identify the match logic for grouping issues together.
2. Set the match logic and the fingerprint for it.

The syntax for fingerprint rules is similar to syntax in [search queries](/concepts/search/#syntax). To negate a match, add an exclamation mark (`!`) at the beginning of the expression. See the full grammar [here](https://github.com/getsentry/sentry/blob/90f5cdfa9ebaf0bfdea63852812a6efc90f13691/src/sentry/grouping/fingerprinting/__init__.py#L36-L73).

Sentry attempts to match against all values that are configured in the fingerprint. In the case of stack traces, all frames are considered. If the event data matches all the values in a line for a matcher and expression, then the fingerprint is applied. When there are multiple rules that match the event, the first matching rule in the list is applied.

Copied

```
# You can use comments to explain the rules. Rules themselves follow the # You can use comments to explain the rules. Rules themselves follow the# following syntax: # following syntax:matcher:expression -> list of values ># The list of values can be hardcoded or substituted values. # The list of values can be hardcoded or substituted values.
```

```
# You can use comments to explain the rules. Rules themselves follow the # You can use comments to explain the rules. Rules themselves follow the# following syntax: # following syntax:matcher:expression -> list of values ># The list of values can be hardcoded or substituted values. # The list of values can be hardcoded or substituted values.
```

Below is a practical example, which groups exceptions of a specific type together:

Copied

```
error.type:DatabaseUnavailable -> system-down >error.type:ConnectionError -> system-down >  error.value:"connection error: *" -> connection-error, {{ transaction }} "connection error: *">{{}}
```

```
error.type:DatabaseUnavailable -> system-down >error.type:ConnectionError -> system-down >  error.value:"connection error: *" -> connection-error, {{ transaction }} "connection error: *">{{}}
```

Now, all the events with the error type `DatabaseUnavailable` or `ConnectionError` will be grouped into an issue with the type `system-down`. In addition, all events with the error value `connection error` will be grouped by their transaction name. So, for example, if your transactions `/api/users/foo/` and `/api/events/foo/`—both with the value `connection error`—crash the same way, Sentry will create two issues, regardless of stack trace or any other default grouping method.

## [Matchers](#matchers)

Matchers allow you to use [glob patterns](https://en.wikipedia.org/wiki/Glob_(programming)).

If you want to create a rule that includes brackets `[ ]`, braces `{ }` or a literal `*`, escape them with a backslash; that is, `\[`, `\]`, `\{`, `\}` or `\*`.

The following matchers are available:

### [`error.type`](#errortype)

alias: `type`

Matches on an exception type (exception name). The match is performed as a case-sensitive glob.

Copied

```
error.type:ZeroDivisionError -> zero-division >error.type:ConnectionError -> connection-error >
```

```
error.type:ZeroDivisionError -> zero-division >error.type:ConnectionError -> connection-error >
```

### [`error.value`](#errorvalue)

alias: `value`

Matches on the exception value. Errors or exceptions often have human-readable descriptions (values) associated with them. This matcher allows a case insensitive match.

Copied

```
error.value:"connection error (code: *)" -> connection-error "connection error (code: *)">error.value:"could not connect (*)" -> connection-error "could not connect (*)">
```

```
error.value:"connection error (code: *)" -> connection-error "connection error (code: *)">error.value:"could not connect (*)" -> connection-error "could not connect (*)">
```

### [`level`](#level)

Matches on the log level. The match is case insensitive.

Copied

```
logger:"com.myapp.FooLogger" level:"error" -> mylogger-error "com.myapp.FooLogger" "error">
```

```
logger:"com.myapp.FooLogger" level:"error" -> mylogger-error "com.myapp.FooLogger" "error">
```

### [`logger`](#logger)

Matches on the name of the logger, which is useful to combine all messages of a logger together. This match is case-sensitive.

Copied

```
logger:"com.myapp.mypackage.*" -> mypackage-logger "com.myapp.mypackage.*">
```

```
logger:"com.myapp.mypackage.*" -> mypackage-logger "com.myapp.mypackage.*">
```

### [`message`](#message)

Matches on a log message. It will also automatically check for the additional exception value as they can be hard to keep apart. The matching is case insensitive.

Copied

```
message:"system encountered a fatal problem: *" -> fatal-log "system encountered a fatal problem: *">
```

```
message:"system encountered a fatal problem: *" -> fatal-log "system encountered a fatal problem: *">
```

### [`stack.abs_path`](#stackabs_path)

alias: `path`

Matches on the path of an event and is case insensitive. It uses path globbing semantics, which means that `*` does not match a slash, but `**` does. Note that this matcher matches on both `abs_path` and `filename` as SDKs can be quite inconsistent about how these values are supported. If the glob matches on either of these values, it's considered a match.

Copied

```
stack.abs_path:"**/my-utils/*.js" -> my-utils, {{ error.type }} "**/my-utils/*.js">{{}}
```

```
stack.abs_path:"**/my-utils/*.js" -> my-utils, {{ error.type }} "**/my-utils/*.js">{{}}
```

### [`stack.function`](#stackfunction)

alias: `function`

Checks if any of the functions in the stack trace match the glob. The match is case-sensitive:

Copied

```
stack.function:"my_assertion_failed" -> my-assertion-failed "my_assertion_failed">
```

```
stack.function:"my_assertion_failed" -> my-assertion-failed "my_assertion_failed">
```

### [`stack.module`](#stackmodule)

alias: `module`

Similar to `stack.abs_path` but matches on the module name instead. The match is case-sensitive and regular globbing rules apply (`*` also matches slashes).

Copied

```
stack.module:"*/my-utils/*" -> my-utils, {{ error.type }} "*/my-utils/*">{{}}
```

```
stack.module:"*/my-utils/*" -> my-utils, {{ error.type }} "*/my-utils/*">{{}}
```

### [`stack.package`](#stackpackage)

alias: `package`

Matches on the "package" of a frame. This is typically the name of the debug symbol/object file that contains a frame. If any of the frames match this object file, then it matches.

Copied

```
stack.package:"**/libcurl.dylib" -> libcurl "**/libcurl.dylib">stack.package:"**/libcurl.so" -> libcurl "**/libcurl.so">
```

```
stack.package:"**/libcurl.dylib" -> libcurl "**/libcurl.dylib">stack.package:"**/libcurl.so" -> libcurl "**/libcurl.so">
```

### [`tags.tag_name`](#tagstag_name)

Matches on the value of the tag `tag_name`. This can be useful to filter down certain types of events. For instance, you can separate events caused by a specific server:

Copied

```
tags.server_name:"canary-*.mycompany.internal" -> canary-events "canary-*.mycompany.internal">
```

```
tags.server_name:"canary-*.mycompany.internal" -> canary-events "canary-*.mycompany.internal">
```

Additionally, the following utility matchers are available:

### [`app`](#app)

Checks if the frame is in-app or not. It is particularly useful when combined with another matcher. Possible values are `yes` and `no`:

Copied

```
app:yes stack.function:"assert" -> assert "assert">
```

```
app:yes stack.function:"assert" -> assert "assert">
```

### [`family`](#family)

Used to "scope" down the matcher. The following families exist: `javascript` for any type of JavaScript event, `native` for any type of Native event. Any other platform is called `other`.

Copied

```
family:native !stack.module:"myproject::*" -> not-from-my-project !"myproject::*">
```

```
family:native !stack.module:"myproject::*" -> not-from-my-project !"myproject::*">
```

## [Combining Matchers](#combining-matchers)

When multiple matchers are combined, they all need to match. Matchers that operate on frames must all apply to the same frame; otherwise, they are not considered a match.

For instance, if you match on both the function name and module name, then a match only exists if a frame matches *both* the function name and the module name. It's not enough for a frame to match only with the function name, even if another frame would match the module name by itself.

Copied

```
# this matches if a frame exists with a specific function and module name # this matches if a frame exists with a specific function and module name # and also a specific error type is thrown # and also a specific error type is thrownerror.type:ConnectionError stack.function:"connect" stack.module:"bot" -> bot-error "connect" "bot">
```

```
# this matches if a frame exists with a specific function and module name # this matches if a frame exists with a specific function and module name # and also a specific error type is thrown # and also a specific error type is thrownerror.type:ConnectionError stack.function:"connect" stack.module:"bot" -> bot-error "connect" "bot">
```

## [Variables](#variables)

On the right-hand side of the fingerprint, you can use constant values and variables. Variables are substituted automatically and have the same name as matchers, but they might be filled in differently. These variables can also be used when assigning fingerprints using Sentry SDKs.

Variables are enclosed in double braces (`{{ variable_name }}`).

### [`{{ default }}`](#-default-)

This fills in the default fingerprint that would be produced by the normal grouping operation. It is useful if you want to subdivide an already existing group by something else:

Copied

```
stack.function:"query_database" -> {{ default }}, {{ transaction }} "query_database">{{}}{{}}
```

```
stack.function:"query_database" -> {{ default }}, {{ transaction }} "query_database">{{}}{{}}
```

### [`{{ error.type }}`](#-errortype-)

alias: `{{ type }}`

This fills in the name of the error that occurred. When chained exceptions are used, it will be the most recently thrown error. This will force the creation of a group per error type:

Copied

```
stack.function:"evaluate_script" -> script-evaluation, {{ error.type }} "evaluate_script">{{}}
```

```
stack.function:"evaluate_script" -> script-evaluation, {{ error.type }} "evaluate_script">{{}}
```

### [`{{ error.value }}`](#-errorvalue-)

alias: `{{ value }}`

This fills in the stringified value of the error that occurred. When chained exceptions are used, it will be the most recently thrown error. Note that this can produce really bad groups when error values are frequently changing.

Copied

```
error.type:"ScriptError" -> script-evaluation, {{ error.value }} "ScriptError">{{}}
```

```
error.type:"ScriptError" -> script-evaluation, {{ error.value }} "ScriptError">{{}}
```

### [`{{ level }}`](#-level-)

This fills in the name of the log level that was used to create an event.

Copied

```
message:"connection error*" -> connection-error, {{ logger }}, {{ level }} "connection error*">{{}}{{}}
```

```
message:"connection error*" -> connection-error, {{ logger }}, {{ level }} "connection error*">{{}}{{}}
```

### [`{{ logger }}`](#-logger-)

This fills in the name of the logger that caused an event.

Copied

```
message:"critical connection error*" -> connection-error, {{ logger }} "critical connection error*">{{}}
```

```
message:"critical connection error*" -> connection-error, {{ logger }} "critical connection error*">{{}}
```

### [`{{ message }}`](#-message-)

This fills in the message of the event (similar to `error.value` but for captured messages). Note that this can produce groups with poor data quality if messages are changing frequently:

Copied

```
logger:"com.foo.auditlogger.*" -> audit-log, {{ message }} "com.foo.auditlogger.*">{{}}
```

```
logger:"com.foo.auditlogger.*" -> audit-log, {{ message }} "com.foo.auditlogger.*">{{}}
```

### [`{{ stack.abs_path }}`](#-stackabs_path-)

alias: `{{ path }}`

This fills in the path of the "crashing frame," also known as the application code's topmost frame.

Copied

```
error.type:"ScriptError" -> script-evaluation, {{ stack.abs_path }} "ScriptError">{{}}
```

```
error.type:"ScriptError" -> script-evaluation, {{ stack.abs_path }} "ScriptError">{{}}
```

### [`{{ stack.filename }}`](#-stackfilename-)

This is like `stack.abs_path` but will only fill in the relative file name:

Copied

```
error.type:"ScriptError" -> script-evaluation, {{ stack.filename }} "ScriptError">{{}}
```

```
error.type:"ScriptError" -> script-evaluation, {{ stack.filename }} "ScriptError">{{}}
```

### [`{{ stack.function }}`](#-stackfunction-)

alias: `{{ function }}`

This fills in the function name of the "crashing frame," also known as the application code's topmost frame.

Copied

```
error.type:"ScriptError" -> script-evaluation, {{ stack.function }} "ScriptError">{{}}
```

```
error.type:"ScriptError" -> script-evaluation, {{ stack.function }} "ScriptError">{{}}
```

### [`{{ stack.module }}`](#-stackmodule-)

alias: `{{ module }}`

This fills in the module name of the "crashing frame," also known as the application code's topmost frame.

Copied

```
error.type:"ScriptError" -> script-evaluation, {{ stack.module }} "ScriptError">{{}}
```

```
error.type:"ScriptError" -> script-evaluation, {{ stack.module }} "ScriptError">{{}}
```

### [`{{ stack.package }}`](#-stackpackage-)

alias: `{{ package }}`

This fills in the package name (object file) of the "crashing frame," also known as the application code's topmost frame.

Copied

```
stack.function:"assert" -> assertion, {{ stack.package }} "assert">{{}}
```

```
stack.function:"assert" -> assertion, {{ stack.package }} "assert">{{}}
```

### [`{{ tags.tag_name }}`](#-tagstag_name-)

This fills in the value of a tag into the fingerprint, which can, for instance, be used to split events by server name or something similar.

Copied

```
message:"connection error*" -> connection-error, {{ tags.server_name }} "connection error*">{{}}
```

```
message:"connection error*" -> connection-error, {{ tags.server_name }} "connection error*">{{}}
```

### [`{{ transaction }}`](#-transaction-)

This fills in the name of the transaction into the fingerprint. It will force the creation of a group per transaction:

Copied

```
error.type:"ApiError" -> api-error, {{ transaction }} "ApiError">{{}}
```

```
error.type:"ApiError" -> api-error, {{ transaction }} "ApiError">{{}}
```

## [Custom Titles](#custom-titles)

When you use fingerprinting to group events together it can sometimes be useful to also change the default title of the event. Normally the title of the event is the exception type and value (or the top most function names for certain platforms). When you group by custom rules this title can often be misleading. For instance if you group a logger together you might want to name the group after that logger. This can be accomplished by setting the `title` attribute like this:

Copied

```
logger:my.package.* level:error -> error-logger, {{ logger }} title="Error from Logger {{ logger }}" >{{}} title ="Error from Logger {{ logger }}"
```

```
logger:my.package.* level:error -> error-logger, {{ logger }} title="Error from Logger {{ logger }}" >{{}} title ="Error from Logger {{ logger }}"
```

[Merging Issues](/concepts/data-management/event-grouping/merging-issues/)

[Stack Trace Rules](/concepts/data-management/event-grouping/stack-trace-rules/)

Was this helpful?

**Help improve this content**
Our documentation is open source and available on GitHub. Your contributions are welcome, whether fixing a typo (drat!) or suggesting an update ("yeah, this would be better").

[How to contribute](https://docs.sentry.io/contributing/)   |  [Edit this page](https://github.com/getsentry/sentry-docs/edit/master/docs/concepts/data-management/event-grouping/fingerprint-rules.mdx)   |  [Create a docs issue](https://github.com/getsentry/sentry-docs/issues/new/choose)   |  [Get support](https://www.sentry.help/en/)