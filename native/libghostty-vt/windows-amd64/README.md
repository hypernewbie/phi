# Windows amd64

`libghostty-vt.a` contains the pinned COFF static archive under the suffix that CGO accepts.
The native CGO client cross-links with Zig C. It does not depend on a Ghostty DLL.
The checksum and source pin are in `../manifest.json`. Windows Terminal runtime remains unverified.
