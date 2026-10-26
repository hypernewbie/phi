/* Φ phi — WebSocket subprotocol tokens (shared, side-effect-free).

   Each endpoint requires its own token at upgrade; a missing or wrong
   token is rejected with HTTP 426 before any application data flows. */

// Pane endpoint: TerminalClientFrame / TerminalServerFrame.
export const terminalSubprotocol = 'phi.terminal.protobuf.v1';
// Listen-only events endpoint: bare Notification messages.
export const eventsSubprotocol = 'phi.events.protobuf.v1';
// Chat control endpoint: ControlClientFrame / ControlServerFrame.
export const controlSubprotocol = 'phi.control.protobuf.v1';
