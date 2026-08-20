/** The window.pet surface exposed by src/pet-preload.ts (the two sides must stay in sync). */
export interface PetApi {
  /** Report whether the pointer is over the pet's hit region. */
  sendHit(inside: boolean): void;
  /** Report the accumulated drag delta (the window follows home). */
  sendMove(dx: number, dy: number): void;
}

declare global {
  interface Window {
    pet: PetApi;
  }
}
