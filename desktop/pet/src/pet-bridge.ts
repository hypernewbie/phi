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
}

export interface TerritoryBounds {
  minStageX: number;
  maxStageX: number;
  minStageY: number;
  maxStageY: number;
}

export interface PetApi {
  sendHit(inside: boolean): void;
  sendMove(move: PetMove): void;
  reportStageLayout(stage: StageRect): void;
  onTerritoryBounds(listener: (bounds: TerritoryBounds) => void): () => void;
}

declare global {
  interface Window {
    pet: PetApi;
  }
}
