// Package pibridge hosts Phi's side of the Phi ↔ Pi integration bridge.
//
// Phi owns one gRPC server on a local IPC listener — a private Unix-domain
// socket on macOS/Linux, a current-user named pipe on Windows — and never a
// TCP listener. Each provisioned Pi process holds one registered lease and
// at most one active Connect stream. The extension authenticates with a
// per-process random token in gRPC metadata, compared in constant time.
//
// The transport, leases, bounded queues, journal, and command correlation
// live here; browser wiring and launch provisioning are added by later
// milestones on top of this package's public surface.
package pibridge
