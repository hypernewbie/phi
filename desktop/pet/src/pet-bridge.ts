/** The window.pet surface exposed by src/pet-preload.ts (the two sides must stay in sync). */
export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetDragPosition {
  phase: "move" | "end" | "cancel";
  screenX: number;
  screenY: number;
  anchorX: number;
  anchorY: number;
  stage: StageRect;
}

export type PetZoomRequest = { percent: number };
export type PetZoomState = { percent: number; accepted: boolean };
export type PetStageLayout = { stage: StageRect };
export type PetIdleDwellRequest = { dwellSeconds: number };
export type PetIdleDwellState = { dwellSeconds: number };
export type PetIdleDwellResult = {
  dwellSeconds: number;
  accepted: boolean;
  error?: string;
};
export type PetMousePassthrough = boolean;

export interface PetHitTestRequest {
  requestId: number;
  screenX: number;
  screenY: number;
  window: StageRect;
}

export interface PetHitTestResult {
  requestId: number;
  visible: boolean;
}

export interface PetSettingsApi {
  requestIdleDwellSeconds(dwellSeconds: number): Promise<PetIdleDwellResult>;
  onIdleDwellState(listener: (state: PetIdleDwellState) => void): () => void;
}

export interface PetApi {
  sendDragPosition(position: PetDragPosition): void;
  requestZoomPercent(request: PetZoomRequest): void;
  reportStageLayout(layout: PetStageLayout): void;
  setMousePassthrough(ignore: PetMousePassthrough): void;
  reportHitTestResult(result: PetHitTestResult): void;
  onHitTestRequest(listener: (request: PetHitTestRequest) => void): () => void;
  onZoomState(listener: (state: PetZoomState) => void): () => void;
  onIdleDwellState?(listener: (state: PetIdleDwellState) => void): () => void;
}

declare global {
  interface Window {
    pet: PetApi;
    petSettings: PetSettingsApi;
  }
}
