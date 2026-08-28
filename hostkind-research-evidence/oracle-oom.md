Search
**Java Platform, Standard Edition Troubleshooting Guide**
Contents Previous Next

# 3.2 Understand the OutOfMemoryError Exception
One common indication of a memory leak is the `java.lang.OutOfMemoryError` exception. Usually, this error is thrown when there is insufficient space to allocate an object in the Java heap.
In this case, The garbage collector cannot make space available to accommodate a new object, and the heap cannot be expanded further. Also, this error may be thrown when there is insufficient native memory to support the loading of a Java class.
In a rare instance, a `java.lang.OutOfMemoryError` may be thrown when an excessive amount of time is being spent doing garbage collection and little memory is being freed.
When a `java.lang.OutOfMemoryError` exception is thrown, a stack trace is also printed.
The `java.lang.OutOfMemoryError` exception can also be thrown by native library code when a native allocation cannot be satisfied (for example, if swap space is low).
An early step to diagnose an `OutOfMemoryError` exception is to determine the cause of the exception. Was it thrown because the Java heap is full, or because the native heap is full?

...

Exception in thread thread_name : java.lang.OutOfMemoryError: Java heap space
Cause: The detail message Java heap space indicates object could not be allocated in the Java heap. This error does not necessarily imply a memory leak.

...

In other cases, and in particular for a long-lived application, the message might be an indication that the application is unintentionally holding references to objects, and this prevents the objects from being garbage collected. This is the Java language equivalent of a memory leak.

...

If the finalizer thread cannot keep up, with the finalization queue, then the Java heap could fill up and this type of `OutOfMemoryError` exception would be thrown.

...

Exception in thread thread_name : java.lang.OutOfMemoryError: GC Overhead limit exceeded
Cause: The detail message "GC overhead limit exceeded" indicates that the garbage collector is running all the time and Java program is making very slow progress.
After a garbage collection, if the Java process is spending more than approximately 98% of its time doing garbage collection and if it is recovering less than 2% of the heap and has been doing so far the last 5 (compile time constant) consecutive garbage collections, then a
`java.lang.OutOfMemoryError` is thrown. This exception is typically thrown because the amount of live data barely fits into the Java heap having little free space for new allocations.
Action: Increase the heap size.
The `java.lang.OutOfMemoryError` exception for **GC Overhead limit exceeded** can be turned off with the command line flag `-XX:-UseGCOverheadLimit` .

...

Exception in thread thread_name : java.lang.OutOfMemoryError: Metaspace
Cause: Java class metadata (the virtual machines internal presentation of Java class) is allocated in native memory (referred to here as metaspace).
If metaspace for class metadata is exhausted, a `java.lang.OutOfMemoryError` exception with a detail `MetaSpace` is thrown. The amount of metaspace that can be used for class metadata is limited by the parameter `MaxMetaSpaceSize` , which is specified on the command line.
When the amount of native memory needed for a class metadata exceeds `MaxMetaSpaceSize` , a `java.lang.OutOfMemoryError` exception with a detail `MetaSpace` is thrown.
Action: If `MaxMetaSpaceSize` , has been set on the command-line, increase its value.
`MetaSpace` is allocated from the same address spaces as the Java heap. Reducing the size of the Java heap will make more space available for `MetaSpace` . This is only a correct trade-off if there is an excess of free space in the Java heap.

...

However, the Java HotSpot VM code reports this apparent exception when an allocation from the native heap failed and the native heap might be close to exhaustion. The message indicates the size (in bytes) of the request that failed and the reason for the memory request.

...

Exception in thread thread_name : java.lang.OutOfMemoryError: Compressed class space
Cause: On 64-bit platforms a pointer to class metadata can be represented by a 32-bit offset (with `UseCompressedOops` ).

...

If the space needed for `UseCompressedClassPointers` exceeds `CompressedClassSpaceSize` , a `java.lang.OutOfMemoryError` with detail **Compressed class space** is thrown.
Action: Increase `CompressedClassSpaceSize` to turn off `UseCompressedClassPointers` .