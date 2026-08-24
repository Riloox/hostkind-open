# Developer Certificate of Origin (DCO)

Hostkind requires every contribution to carry the Developer Certificate of Origin.
By signing off a commit you certify that you wrote it, or that you have the right to
contribute it under the project's license (AGPL-3.0-only, or the commercial license
for licensed distribution). You are not asked to transfer copyright, only to vouch
for provenance.

The DCO text below is the standard Developer Certificate of Origin as published at
<https://developercertificate.org/>.

---

## Developer Certificate of Origin

Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this license
document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right to
    submit it under the open source license indicated in the file; or

(b) The contribution is based upon previous work that, to the best of my knowledge,
    is covered under an appropriate open source license, and I have the right under
    that license to submit that work with modifications, whether created in whole or
    in part by me, under the same open source license (unless I am permitted to
    submit under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other person who certified
    (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public, and
    that a record of the contribution (including all personal information I submit
    with it, including my sign-off) is maintained indefinitely and may be
    redistributed consistent with this project or the open source license(s)
    involved.

---

## How to sign off

Add a `Signed-off-by` trailer to every commit you author:

```
Signed-off-by: Your Name <your.email@example.com>
```

With Git this is done with:

```bash
git commit -s
```

or per-message:

```bash
git commit -m "Subject" -m "Body." -m "Signed-off-by: Your Name <your.email@example.com>"
```

Use the name and email you are actually committing as; the sign-off is a personal
certification, not an alias. If you are contributing changes made by someone else,
you are certifying that they certified (a), (b) or (c) and that you did not modify
their work.

A PR will be asked to fix or drop a sign-off it cannot trace to its author. Commits
without a valid sign-off are not accepted.
