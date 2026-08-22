/**
 * Pet renderer state machine — a vanilla-DOM port of dsh-pet's
 * media catalog, dual-buffer playback, click/drag interaction, and zoom
 * handling. Media loads through relative file:// URLs under the page's own
 * directory.
 */
import type {
  PetApi,
  PetConfig,
  PetDragPosition,
  PetHitTestRequest,
  PetStageLayout,
  PetZoomState,
  StageRect,
} from "./pet-bridge.js";
import { PET_CONFIG } from "./pet-config.js";

/** The sentinel "show the static maid image" state — never a webm filename. */
export const STATIC = "STATIC";
/** The drag feedback animation (played while the pointer drags). */
export const DRAG = "被鼠标拖拽悬空反馈";
/** Runtime config: test-injected via globalThis.petConfig, else embedded. */
const activeConfig = (): PetConfig =>
  (globalThis as { petConfig?: PetConfig }).petConfig ?? PET_CONFIG;

const lastActRef = { current: null as string | null };

/** The stationary act pool: category actions plus the idle animation. */
export const ACTS = (): readonly string[] => [
  ...activeConfig().animations.categories.flatMap((c) => c.actions),
  ...activeConfig().animations.idle,
];

/** The click-reaction pool. */
export const CLICKS = (): readonly string[] => activeConfig().animations.clicks;
/** Pointer distance at which a click becomes a drag. */
export const DRAG_THRESHOLD = 5;

export const PET_ZOOM_MIN_PERCENT = 50;
export const PET_ZOOM_MAX_PERCENT = 300;
export const PET_ZOOM_DEFAULT_PERCENT = 100;
export const PET_ZOOM_STEP_PERCENT = 25;
export const PET_BASE_VISUAL_WIDTH_DIP = 192;

const strictDecimal = (value: string | null): number | null => {
  if (value === null || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function queryZoomConfig(): {
  percent: number;
  minPercent: number;
  maxPercent: number;
  defaultPercent: number;
  stepPercent: number;
  baseVisualWidth: number;
} {
  const fallback = {
    percent: PET_ZOOM_DEFAULT_PERCENT,
    minPercent: PET_ZOOM_MIN_PERCENT,
    maxPercent: PET_ZOOM_MAX_PERCENT,
    defaultPercent: PET_ZOOM_DEFAULT_PERCENT,
    stepPercent: PET_ZOOM_STEP_PERCENT,
    baseVisualWidth: PET_BASE_VISUAL_WIDTH_DIP,
  };
  const values = [
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomMinPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomMaxPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomDefaultPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomStepPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petBaseVisualWidth"),
    ),
  ];
  if (values.some((value) => value === null)) return fallback;
  const [
    percent,
    minPercent,
    maxPercent,
    defaultPercent,
    stepPercent,
    baseVisualWidth,
  ] = values as number[];
  if (
    !Number.isInteger(percent) ||
    !Number.isInteger(minPercent) ||
    !Number.isInteger(maxPercent) ||
    !Number.isInteger(defaultPercent) ||
    !Number.isInteger(stepPercent) ||
    minPercent > maxPercent ||
    defaultPercent < minPercent ||
    defaultPercent > maxPercent ||
    percent < minPercent ||
    percent > maxPercent ||
    stepPercent <= 0 ||
    (percent - minPercent) % stepPercent !== 0 ||
    (defaultPercent - minPercent) % stepPercent !== 0 ||
    baseVisualWidth <= 0
  )
    return fallback;
  return {
    percent,
    minPercent,
    maxPercent,
    defaultPercent,
    stepPercent,
    baseVisualWidth,
  };
}

/** The media directory under the package root (dist/ → ../assets/thumb/). */
const MEDIA_PREFIX = "../assets/thumb/";

/** The chain decision for a given random roll. */

/** Equal-probability pool pick with an optional exclude. */
export function pick(
  pool: readonly string[],
  exclude: string | null,
  rng: () => number,
): string {
  const entries = exclude === null ? pool : pool.filter((n) => n !== exclude);
  return entries[Math.floor(rng() * entries.length)] ?? pool[0] ?? "";
}

/** Weighted category roll; noMirror categories excluded when facing right. */
export const pickWeightedCategory = (
  cats: ReadonlyArray<{
    id: string;
    weight: number;
    noMirror?: boolean;
    actions: string[];
  }>,
  facing: "left" | "right",
  rng: () => number,
): { id: string; actions: string[] } | null => {
  const eligible = cats.filter((c) => !(facing === "right" && c.noMirror));
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const c of eligible) {
    roll -= c.weight;
    if (roll < 0) return { id: c.id, actions: c.actions };
  }
  return {
    id: eligible[eligible.length - 1].id,
    actions: eligible[eligible.length - 1].actions,
  };
};

/** Roll idle vs weighted category. Turn/move weights are forward hooks
 *  (dsh items 5/6) and are not yet played. Guarantees the returned name
 *  is never equal to `lastAct` (falls through pools when excluded). */
export const pickNext = (
  config: PetConfig,
  lastAct: string | null,
  facing: "left" | "right" = "left",
  rng: () => number = Math.random,
): { kind: "idle" | "act"; name: string } | null => {
  const idleWeight = config.animationWeights.idle;
  const catTotal = config.animations.categories.reduce(
    (s, c) => s + c.weight,
    0,
  );
  const total = idleWeight + catTotal;
  if (total <= 0) return null;
  const roll = rng() * total;
  const exclude = (name: string | null) => name;

  const pickFromIdle = (): string | null => {
    const idle = config.animations.idle.filter((n) => n !== exclude(lastAct));
    if (idle.length === 0) return null;
    return idle[Math.floor(rng() * idle.length)]!;
  };
  const pickFromCat = (): string | null => {
    const cat = pickWeightedCategory(config.animations.categories, facing, rng);
    if (!cat) return null;
    const eligible =
      lastAct === null ? cat.actions : cat.actions.filter((n) => n !== lastAct);
    if (eligible.length === 0) return null;
    return eligible[Math.floor(rng() * eligible.length)]!;
  };

  if (roll < idleWeight) {
    const name = pickFromIdle();
    if (name !== null) return { kind: "idle", name };
    const fall = pickFromCat();
    return fall === null ? null : { kind: "act", name: fall };
  }
  {
    const name = pickFromCat();
    if (name !== null) return { kind: "act", name };
    const fall = pickFromIdle();
    if (fall !== null) return { kind: "idle", name: fall };
    return lastAct === null ? null : { kind: "act", name: lastAct };
  }
};

export type PetHitLayer = {
  element: HTMLImageElement | HTMLVideoElement;
  intrinsicX: number;
  intrinsicY: number;
};

export type PetAlphaSampler = (
  stagePoint: { x: number; y: number },
  layers: readonly PetHitLayer[],
) => boolean | null;

// The canvas probe measured 1/255 alpha noise across the transparent background.
const PET_HIT_ALPHA_THRESHOLD = 16 / 255;

const createDefaultAlphaSampler = (): PetAlphaSampler => {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  return (_stagePoint, layers) => {
    if (layers.length === 0) return false;
    try {
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        context = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (!context) return null;
      let compositedAlpha = 0;
      for (const layer of layers) {
        const opacityValue = Number.parseFloat(
          getComputedStyle(layer.element).opacity,
        );
        const opacity = Number.isFinite(opacityValue)
          ? Math.min(Math.max(opacityValue, 0), 1)
          : 1;
        if (opacity === 0) continue;
        context.clearRect(0, 0, 1, 1);
        context.globalAlpha = 1;
        context.drawImage(
          layer.element,
          Math.floor(layer.intrinsicX),
          Math.floor(layer.intrinsicY),
          1,
          1,
          0,
          0,
          1,
          1,
        );
        const sourceAlpha = context.getImageData(0, 0, 1, 1).data[3] / 255;
        const effectiveAlpha = sourceAlpha * opacity;
        compositedAlpha =
          effectiveAlpha + compositedAlpha * (1 - effectiveAlpha);
      }
      return compositedAlpha > PET_HIT_ALPHA_THRESHOLD;
    } catch {
      return null;
    }
  };
};

/** The injected DOM + bridge the controller drives. */
export interface PetInitOptions {
  root: HTMLElement;
  stage: HTMLElement;
  videoA: HTMLVideoElement;
  videoB: HTMLVideoElement;
  staticImg: HTMLImageElement;
  hit: HTMLElement;
  bridge: PetApi;
  alphaSampler?: PetAlphaSampler;
  rng?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

export interface PetState {
  anim: string;
  once: boolean;
  facing: "left" | "right";
  dragging: boolean;
}

export interface PetController {
  getState(): PetState;
  destroy(): void;
}

export function initPet(opts: PetInitOptions): PetController {
  const { root, stage, videoA, videoB, staticImg, hit, bridge } = opts;
  const alphaSampler = opts.alphaSampler ?? createDefaultAlphaSampler();
  const rng = opts.rng ?? Math.random;
  const raf =
    opts.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));
  const zoomConfig = queryZoomConfig();
  const validDwellSeconds = (value: unknown): value is number =>
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 3600;
  const queryDwell = (): number => {
    const value = Number(
      new URLSearchParams(window.location.search).get("petIdleDwellSeconds"),
    );
    return validDwellSeconds(value) ? value : 10;
  };
  let dwellSeconds = queryDwell(); // canonical seconds (1..3600) for the next rest
  let zoomPercent = zoomConfig.percent;
  let desiredZoomPercent = zoomPercent;
  let zoomRequestInFlight: number | null = null;
  let wheelRemainder = 0;
  let stageWidth = 0;
  let stageHeight = 0;
  let lastPoint: { x: number; y: number } | null = null;
  let lastVisible: boolean | null = null;
  let ignoreMouseEvents = true;
  let gestureOwned = false;
  let clickEligible = false;
  let pendingHitTestRequest: PetHitTestRequest | null = null;
  let mediaSampleGeneration = 0;
  let pendingFrameFallback: number | null = null;
  let destroyed = false;

  const layout = (): void => {
    stageWidth = Math.floor((zoomConfig.baseVisualWidth * zoomPercent) / 100);
    stageHeight = Math.floor((stageWidth * 9) / 16);
    root.style.width = `${stageWidth}px`;
    root.style.height = `${stageHeight}px`;
    root.style.transform = "none";
    stage.style.width = `${stageWidth}px`;
    stage.style.height = `${stageHeight}px`;
    stage.style.transform = "none";
    hit.style.inset = "0px";
  };

  let anim = STATIC;
  let once = false;
  const facing: "left" | "right" = "left";
  let dragging = false;

  let front = 0; // 0 = videoA front, 1 = videoB front
  let pending: {
    anim: string;
    once: boolean;
    gen: number;
  } | null = null;
  let gen = 0;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRestTimer = (): void => {
    if (restTimer !== null) clearTimeout(restTimer);
    restTimer = null;
  };

  const mediaElements = [staticImg, videoA, videoB] as const;
  const stageClientRect = (): DOMRect => stage.getBoundingClientRect();
  const mediaDimensions = (
    element: HTMLImageElement | HTMLVideoElement,
  ): { width: number; height: number } | null => {
    if (
      element instanceof HTMLVideoElement &&
      element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    )
      return null;
    const width =
      element instanceof HTMLImageElement
        ? element.naturalWidth
        : element.videoWidth;
    const height =
      element instanceof HTMLImageElement
        ? element.naturalHeight
        : element.videoHeight;
    if (width > 0 && height > 0) return { width, height };
    return null;
  };
  const mediaClientRect = (
    element: HTMLImageElement | HTMLVideoElement,
    fallback: DOMRect,
  ): DOMRect => {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
    return fallback;
  };
  const hitLayers = (point: {
    x: number;
    y: number;
  }): { decoded: boolean; layers: PetHitLayer[] } => {
    const stageRect = stageClientRect();
    const layers: PetHitLayer[] = [];
    let decoded = false;
    for (const element of mediaElements) {
      const rect = mediaClientRect(element, stageRect);
      const dimensions = mediaDimensions(element);
      // Injected samplers use stage-sized fallback dimensions so JSDOM can
      // exercise coordinate mapping without decoding media; production never
      // treats an undecoded image/video as eligible.
      const usableDimensions =
        dimensions ??
        (opts.alphaSampler
          ? {
              width: Math.max(1, Math.round(rect.width)),
              height: Math.max(1, Math.round(rect.height)),
            }
          : null);
      if (!usableDimensions) continue;
      decoded = true;
      const sourceAspect = usableDimensions.width / usableDimensions.height;
      const rectAspect = rect.width / rect.height;
      const contentWidth =
        rectAspect > sourceAspect ? rect.height * sourceAspect : rect.width;
      const contentHeight =
        rectAspect > sourceAspect ? rect.height : rect.width / sourceAspect;
      const contentLeft =
        rect.left - stageRect.left + (rect.width - contentWidth) / 2;
      const contentTop =
        rect.top - stageRect.top + (rect.height - contentHeight) / 2;
      if (
        point.x < contentLeft ||
        point.x > contentLeft + contentWidth ||
        point.y < contentTop ||
        point.y > contentTop + contentHeight
      )
        continue;
      const intrinsicX = Math.min(
        Math.max(
          ((point.x - contentLeft) / contentWidth) * usableDimensions.width,
          0,
        ),
        usableDimensions.width - 1,
      );
      const intrinsicY = Math.min(
        Math.max(
          ((point.y - contentTop) / contentHeight) * usableDimensions.height,
          0,
        ),
        usableDimensions.height - 1,
      );
      layers.push({ element, intrinsicX, intrinsicY });
    }
    return { decoded, layers };
  };
  const sampleAt = (point: { x: number; y: number }): boolean | null => {
    const mapped = hitLayers(point);
    if (!mapped.decoded) return null;
    return alphaSampler(point, mapped.layers);
  };
  const setMousePassthrough = (ignore: boolean): void => {
    if (ignoreMouseEvents === ignore) return;
    bridge.setMousePassthrough(ignore);
    ignoreMouseEvents = ignore;
  };
  const resampleLastPoint = (): boolean | null => {
    if (destroyed || !lastPoint) return null;
    const visible = sampleAt(lastPoint);
    if (visible === null) return null;
    const previous = lastVisible;
    lastVisible = visible;
    if (pendingHitTestRequest) {
      const request = pendingHitTestRequest;
      pendingHitTestRequest = null;
      ignoreMouseEvents = !visible;
      bridge.reportHitTestResult({ requestId: request.requestId, visible });
    } else if (!gestureOwned && previous !== visible) {
      setMousePassthrough(!visible);
    }
    return visible;
  };
  const stagePointFromClient = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const rect = stageClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const stagePointFromRequest = (
    request: PetHitTestRequest,
  ): { x: number; y: number } | null => {
    if (
      request.window.width <= 0 ||
      request.window.height <= 0 ||
      !Number.isFinite(request.window.x) ||
      !Number.isFinite(request.window.y) ||
      !Number.isFinite(request.screenX) ||
      !Number.isFinite(request.screenY)
    )
      return null;
    const rect = stageClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x:
        ((request.screenX - request.window.x) / request.window.width) *
        rect.width,
      y:
        ((request.screenY - request.window.y) / request.window.height) *
        rect.height,
    };
  };
  const sampleClientPoint = (
    clientX: number,
    clientY: number,
    publish: boolean,
  ): boolean | null => {
    const point = stagePointFromClient(clientX, clientY);
    if (!point) return null;
    lastPoint = point;
    const visible = sampleAt(point);
    if (visible === null) return null;
    const previous = lastVisible;
    lastVisible = visible;
    if (publish && !gestureOwned && previous !== visible)
      setMousePassthrough(!visible);
    return visible;
  };
  const handleHitTestRequest = (request: PetHitTestRequest): void => {
    pendingHitTestRequest = request;
    const point = stagePointFromRequest(request);
    if (!point) {
      pendingHitTestRequest = null;
      lastPoint = null;
      lastVisible = false;
      ignoreMouseEvents = true;
      bridge.reportHitTestResult({
        requestId: request.requestId,
        visible: false,
      });
      return;
    }
    lastPoint = point;
    resampleLastPoint();
  };

  let drag = { active: false, dragging: false, sx: 0, sy: 0 };
  let justDragged = false;
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStageRect: StageRect | null = null;
  let pendingDragPosition: PetDragPosition | null = null;
  let pendingDragFrame: number | null = null;

  const setAnim = (next: string, nextOnce: boolean): void => {
    anim = next;
    once = nextOnce;
    switchTo(anim, once);
  };

  const cancelVideoFrameSampling = (): void => {
    mediaSampleGeneration += 1;
    if (pendingFrameFallback !== null) caf(pendingFrameFallback);
    pendingFrameFallback = null;
  };
  const scheduleVideoFrameSampling = (element: HTMLVideoElement): void => {
    if (destroyed || !lastPoint || !element.classList.contains("is-front"))
      return;
    const generation = mediaSampleGeneration;
    const requestVideoFrameCallback = (
      element as HTMLVideoElement & {
        requestVideoFrameCallback?: (
          callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
        ) => number;
      }
    ).requestVideoFrameCallback;
    if (typeof requestVideoFrameCallback === "function") {
      requestVideoFrameCallback.call(element, () => {
        if (
          destroyed ||
          generation !== mediaSampleGeneration ||
          !element.classList.contains("is-front")
        )
          return;
        resampleLastPoint();
        scheduleVideoFrameSampling(element);
      });
      return;
    }
    pendingFrameFallback = raf(() => {
      pendingFrameFallback = null;
      if (
        destroyed ||
        generation !== mediaSampleGeneration ||
        !element.classList.contains("is-front")
      )
        return;
      resampleLastPoint();
      scheduleVideoFrameSampling(element);
    });
  };

  const startStatic = (): void => {
    cancelVideoFrameSampling();
    anim = STATIC;
    once = false;
    staticImg.src = MEDIA_PREFIX + "maid-static.png";
    staticImg.classList.add("is-front");
    videoA.classList.remove("is-front");
    videoB.classList.remove("is-front");
    resampleLastPoint();
    clearRestTimer();
    restTimer = setTimeout(playRandomAct, dwellSeconds * 1000);
  };

  const handleEnded = (): void => {
    if (drag.active) return;
    startStatic();
  };

  const playRandomAct = (): void => {
    const cfg = activeConfig();
    const next = pickNext(cfg, lastActRef.current, "left", rng);
    if (!next) return;
    lastActRef.current = next.name;
    switchTo(next.name, true);
  };

  const switchTo = (next: string, nextOnce: boolean): void => {
    if (pending && pending.anim === next && pending.once === nextOnce) return;
    cancelVideoFrameSampling();
    clearRestTimer();
    anim = next;
    once = nextOnce;
    const currentGen = ++gen;
    pending = { anim: next, once: nextOnce, gen: currentGen };

    const el = front === 0 ? videoB : videoA;
    el.src = MEDIA_PREFIX + encodeURIComponent(next) + ".webm";
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = null;
    const onError = (): void => {
      el.removeEventListener("error", onError);
      if (!destroyed && pending?.gen === currentGen) startStatic();
    };
    el.addEventListener("error", onError);
    el.load();

    const onReady = (): void => {
      el.removeEventListener("loadeddata", onReady);
      if (destroyed) return;
      el.removeEventListener("error", onError);
      if (pending?.gen !== currentGen) return;
      const old = front === 0 ? videoA : videoB;
      if (old && old !== el) {
        old.onended = null;
        old.pause();
        old.classList.remove("is-front");
      }
      staticImg.classList.remove("is-front");
      el.classList.add("is-front");
      front = front === 0 ? 1 : 0;
      pending = null;
      el.onended = nextOnce
        ? () => {
            // Clear the one-shot callback before transitioning so duplicate
            // ended notifications cannot re-enter startStatic.
            el.onended = null;
            handleEnded();
          }
        : null;
      el.style.transform = "";
      resampleLastPoint();
      scheduleVideoFrameSampling(el);
      void Promise.resolve(el.play()).catch(() => {
        if (!destroyed && gen === currentGen) startStatic();
      });
    };
    el.addEventListener("loadeddata", onReady);
    if (el.readyState >= 2) onReady();
  };

  const captureDragAnchor = (e: PointerEvent): void => {
    const rect = stage.getBoundingClientRect();
    dragStageRect = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
    dragAnchor = { x: e.clientX - rect.x, y: e.clientY - rect.y };
  };

  const scheduleDragPosition = (): void => {
    if (pendingDragFrame !== null) return;
    pendingDragFrame = raf(() => {
      pendingDragFrame = null;
      const position = pendingDragPosition;
      pendingDragPosition = null;
      if (position) bridge.sendDragPosition(position);
    });
  };

  const flushDragPosition = (): void => {
    if (pendingDragFrame !== null) {
      caf(pendingDragFrame);
      pendingDragFrame = null;
    }
    const position = pendingDragPosition;
    pendingDragPosition = null;
    if (position) bridge.sendDragPosition(position);
  };

  const clearDrag = (): void => {
    drag.active = false;
    drag.dragging = false;
    hit.classList.remove("dragging");
    dragging = false;
    dragAnchor = null;
    dragStageRect = null;
  };
  const rearmMousePassthrough = (): void => {
    if (!gestureOwned && lastVisible !== null)
      setMousePassthrough(!lastVisible);
  };

  const handlePointerDown = (e: PointerEvent): void => {
    if (clickEligible && !drag.active) {
      clickEligible = false;
      gestureOwned = false;
      rearmMousePassthrough();
    }
    const sampled = sampleClientPoint(e.clientX, e.clientY, false);
    if (sampled !== true && lastVisible !== true) return;
    setMousePassthrough(false);
    gestureOwned = true;
    clickEligible = true;
    hit.classList.add("dragging");
    if (typeof hit.setPointerCapture === "function")
      hit.setPointerCapture(e.pointerId);
    drag = {
      active: true,
      dragging: false,
      sx: e.clientX,
      sy: e.clientY,
    };
  };

  const handlePointerMove = (e: PointerEvent): void => {
    if (!drag.active) return;
    const point = stagePointFromClient(e.clientX, e.clientY);
    if (point) lastPoint = point;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.dragging = true;
      dragging = true;
      captureDragAnchor(e);
      setAnim(DRAG, true);
    }
    if (!dragAnchor || !dragStageRect) return;
    pendingDragPosition = {
      phase: "move",
      screenX: e.screenX,
      screenY: e.screenY,
      anchorX: dragAnchor.x,
      anchorY: dragAnchor.y,
      stage: dragStageRect,
    };
    scheduleDragPosition();
  };

  const handlePointerUp = (e: PointerEvent): void => {
    if (!drag.active) return;
    const wasDragging = drag.dragging;
    sampleClientPoint(e.clientX, e.clientY, false);
    if (wasDragging && dragAnchor && dragStageRect) {
      const finalPosition: PetDragPosition = {
        phase: "move",
        screenX: e.screenX,
        screenY: e.screenY,
        anchorX: dragAnchor.x,
        anchorY: dragAnchor.y,
        stage: dragStageRect,
      };
      pendingDragPosition = finalPosition;
      flushDragPosition();
      bridge.sendDragPosition({ ...finalPosition, phase: "end" });
    }
    clearDrag();
    if (!wasDragging) return;
    gestureOwned = false;
    clickEligible = false;
    justDragged = true;
    setTimeout(() => {
      justDragged = false;
    }, 100);
    startStatic();
    rearmMousePassthrough();
  };

  const handlePointerCancel = (): void => {
    if (!drag.active) return;
    const wasDragging = drag.dragging;
    if (pendingDragFrame !== null) {
      caf(pendingDragFrame);
      pendingDragFrame = null;
    }
    pendingDragPosition = null;
    if (wasDragging && dragStageRect && dragAnchor) {
      bridge.sendDragPosition({
        phase: "cancel",
        screenX: 0,
        screenY: 0,
        anchorX: dragAnchor.x,
        anchorY: dragAnchor.y,
        stage: dragStageRect,
      });
    }
    clearDrag();
    gestureOwned = false;
    clickEligible = false;
    if (wasDragging) startStatic();
    resampleLastPoint();
    rearmMousePassthrough();
  };

  const handleClick = (e: MouseEvent): void => {
    sampleClientPoint(e.clientX, e.clientY, false);
    if (drag.active || drag.dragging || justDragged) return;
    if (!clickEligible && lastVisible !== true) return;
    setAnim(pick(CLICKS(), null, rng), true);
    clickEligible = false;
    gestureOwned = false;
    rearmMousePassthrough();
  };

  const onWindowMouseMove = (event: MouseEvent): void => {
    sampleClientPoint(event.clientX, event.clientY, true);
  };
  const onStaticLoad = (): void => {
    resampleLastPoint();
  };
  const removeHitTestRequest = bridge.onHitTestRequest(handleHitTestRequest);
  hit.addEventListener("pointerdown", handlePointerDown);
  hit.addEventListener("pointermove", handlePointerMove);
  hit.addEventListener("pointerup", handlePointerUp);
  hit.addEventListener("pointercancel", handlePointerCancel);
  hit.addEventListener("click", handleClick);
  staticImg.addEventListener("load", onStaticLoad);
  window.addEventListener("mousemove", onWindowMouseMove);

  // Verify mode: log once the first video actually starts playing, or once
  // the static image loads (whichever happens first — the new STATIC initial
  // state means no <video> plays for 30s).
  if (new URLSearchParams(window.location.search).get("verify") === "1") {
    let verified = false;
    const verifyLog = (source: string, detail: string): void => {
      if (verified) return;
      verified = true;
      console.log(`pet-verify-ok ${source} ${detail}`);
    };
    const onPlaying = (el: HTMLVideoElement): void => {
      verifyLog("video-readyState", String(el.readyState));
    };
    videoA.addEventListener("playing", () => onPlaying(videoA));
    videoB.addEventListener("playing", () => onPlaying(videoB));
    staticImg.addEventListener("load", () => verifyLog("static", "loaded"));
  }

  const reportLayout = (): void => {
    const rect = stage.getBoundingClientRect();
    const payload: PetStageLayout = {
      stage: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
    bridge.reportStageLayout(payload);
  };

  const requestZoom = (): void => {
    if (zoomRequestInFlight !== null || desiredZoomPercent === zoomPercent)
      return;
    zoomRequestInFlight = desiredZoomPercent;
    bridge.requestZoomPercent({ percent: desiredZoomPercent });
  };

  const applyZoomState = (state: PetZoomState): void => {
    if (
      !Number.isInteger(state.percent) ||
      state.percent < zoomConfig.minPercent ||
      state.percent > zoomConfig.maxPercent ||
      (state.percent - zoomConfig.minPercent) % zoomConfig.stepPercent !== 0 ||
      typeof state.accepted !== "boolean"
    )
      return;
    const responseMatchesWheelRequest =
      zoomRequestInFlight !== null && state.percent === zoomRequestInFlight;
    zoomRequestInFlight = null;
    if (!state.accepted || !responseMatchesWheelRequest) {
      desiredZoomPercent = state.percent;
      wheelRemainder = 0;
    }
    zoomPercent = state.percent;
    layout();
    reportLayout();
    if (
      state.accepted &&
      responseMatchesWheelRequest &&
      desiredZoomPercent !== zoomPercent
    )
      requestZoom();
  };

  const handleWheel = (event: WheelEvent): void => {
    if (
      drag.active ||
      dragging ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * window.innerHeight
          : event.deltaY;
    if (!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    wheelRemainder += delta;
    const steps =
      wheelRemainder > 0
        ? Math.floor(wheelRemainder / 100)
        : Math.ceil(wheelRemainder / 100);
    wheelRemainder -= steps * 100;
    if (steps === 0) return;
    desiredZoomPercent = Math.min(
      Math.max(
        desiredZoomPercent - steps * zoomConfig.stepPercent,
        zoomConfig.minPercent,
      ),
      zoomConfig.maxPercent,
    );
    requestZoom();
  };

  // Subscribe before reporting the first layout so the initial main-process
  // response cannot be missed.
  const removeZoomListener = bridge.onZoomState(applyZoomState);
  const removeDwellListener =
    bridge.onIdleDwellState?.((state) => {
      if (
        Number.isInteger(state.dwellSeconds) &&
        state.dwellSeconds >= 1 &&
        state.dwellSeconds <= 3600
      )
        dwellSeconds = state.dwellSeconds;
    }) ?? (() => {});
  hit.addEventListener("wheel", handleWheel, { passive: false });
  const onResize = (): void => {
    layout();
    reportLayout();
  };
  window.addEventListener("resize", onResize);
  layout();
  reportLayout();
  startStatic();

  const destroy = (): void => {
    destroyed = true;
    hit.removeEventListener("pointerdown", handlePointerDown);
    hit.removeEventListener("pointermove", handlePointerMove);
    hit.removeEventListener("pointerup", handlePointerUp);
    hit.removeEventListener("pointercancel", handlePointerCancel);
    hit.removeEventListener("click", handleClick);
    hit.removeEventListener("wheel", handleWheel);
    staticImg.removeEventListener("load", onStaticLoad);
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("resize", onResize);
    removeHitTestRequest();
    cancelVideoFrameSampling();
    removeZoomListener();
    removeDwellListener();
    clearRestTimer();
    if (pendingDragFrame !== null) caf(pendingDragFrame);
    pendingDragFrame = null;
    pendingDragPosition = null;
  };

  return {
    getState: () => ({ anim, once, facing, dragging }),
    destroy,
  };
}

// Self-bootstrap when the pet page is loaded (not in unit tests, where the
// vitest jsdom document has no #pet-root).
const bootRoot = document.getElementById("pet-root");
if (bootRoot) {
  initPet({
    root: bootRoot,
    stage: document.getElementById("pet-stage") as HTMLElement,
    videoA: document.getElementById("pet-video-a") as HTMLVideoElement,
    videoB: document.getElementById("pet-video-b") as HTMLVideoElement,
    staticImg: document.getElementById("pet-static") as HTMLImageElement,
    hit: document.getElementById("pet-hit") as HTMLElement,
    bridge: window.pet,
  });
}
