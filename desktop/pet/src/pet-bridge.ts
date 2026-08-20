/** The window.pet surface exposed by src/pet-preload.ts (the two sides must stay in sync). */
export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetMove {
  dx: number;
  dy: number;
  screenX: number;
  screenY: number;
  stage: StageRect;
  heldDrag: boolean;
}

export interface PetDragPosition {
  phase: "move" | "cancel";
  screenX: number;
  screenY: number;
  anchorX: number;
  anchorY: number;
  stage: StageRect;
}

export interface TerritoryBounds {
  minStageX: number;
  maxStageX: number;
  minStageY: number;
  maxStageY: number;
}

export type PetScaleRequest = { tick: number };
export type PetScaleState = { tick: number; accepted: boolean };
export type PetStageLayout = { stage: StageRect; resetPosition?: boolean };

export interface PetApi {
  sendHit(inside: boolean): void;
  sendMove(move: PetMove): void;
  sendDragPosition(position: PetDragPosition): void;
  requestScaleTick(request: PetScaleRequest): void;
  reportStageLayout(layout: PetStageLayout): void;
  onTerritoryBounds(listener: (bounds: TerritoryBounds) => void): () => void;
  onScaleState(listener: (state: PetScaleState) => void): () => void;
  onResetPosition(listener: () => void): () => void;
}

declare global {
  interface Window {
    pet: PetApi;
  }
}
