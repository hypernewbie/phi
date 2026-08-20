/**
 * Pet renderer state machine — a vanilla-DOM port of dsh-pet's
 * lib/client.js core (constants/catalog :88-182, dual-buffer switchTo
 * :232-306, chain pickNext/handleEnded :308-341, movement :363-497,
 * click/drag :499-596, geometry :598-668). No React, no fetch(), no
 * remote surface: media loads via relative file:// URLs under the page's
 * own directory.
 *
 * Positioning uses transform:translate (not left/top). customPos stores
 * {rx, ry} ratios of window.innerWidth/innerHeight so a resize keeps the
 * relative position. On drag release the renderer sends the accumulated
 * pointer delta to the main process (which moves the WINDOW), then the
 * pet resets to its pre-drag in-window position — net effect: the pet
 * stays under the cursor while the window follows home.
 */
import type {
  PetApi,
  PetDragPosition,
  PetScaleState,
  PetStageLayout,
} from "./pet-bridge.js";

/** The thumb canvas height and the feet baseline (dsh-pet client.js). */
export const CANVAS_H = 360;
export const FEET_Y = 330;

/** The click/drag hit rectangle (thumb 640×360 pixel coords). */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

/** The idle breathing animation (the only recurring one-shot). */
export const IDLE = "待机呼吸休闲";
/** The turn animation (ends with a facing flip). */
export const TURN = "东张西望";
/** The drag feedback animation (played while the pointer drags). */
export const DRAG = "被鼠标拖拽悬空反馈";
/** The random act pool (equal probability). */
export const ACTS = [
  "悠闲哼歌",
  "超大伸懒腰",
  "原地专心玩魔方",
  "原地敲击桌面互动",
  "原地重力下蹲压缩",
  "哈欠连天",
  "原地小憩沉眠",
  "原地蹲下玩玩具汽车",
  "鲸鱼吐泡泡特效",
  "女仆屈膝礼仪",
  "被吓一跳（炸毛）",
  "原地跳跃抓碎头顶物品",
  "小幅度原地 360 度旋转展示",
  "偷吃零食被抓住",
  "玩游戏气急败坏",
  "用鲸鱼尾巴拍打地面",
  "打瞌睡被惊醒",
  "玩水枪",
  "小提琴演奏",
  "蓝鲸现世",
  "吃白饭",
  "照镜子",
  "优雅女仆舞",
  "轻快摇摆舞",
  "可爱宅舞",
  "整体换装试色",
  "大口吃零食",
  "吹气球",
  "动物环绕",
  "深度思考碎碎念",
  "轻快记录",
  "写代码",
  "吃Token",
  "吃早餐",
  "吃午餐",
  "吃晚餐",
  "放风筝",
  "摇扇纳凉",
  "吃冰淇淋融化",
  "被落叶淹没",
  "中秋赏月吃月饼",
  "堆雪人",
];
/** The click-reaction pool (3 of 1). */
export const CLICKS = [
  "点击回应 - 开心跃动",
  "点击回应 - 害羞惊讶",
  "点击回应 - 傲娇生气（侧身展示）",
];
/** The movement pool (gait only; position is driven by rAF). */
export const MOVES = ["螃蟹走路", "原地漂浮踏步", "原地左转奔跑"];

/** Movement parameters (dsh-pet client.js). */
export const MOVE_MIN_PX = 60;
export const MOVE_MAX_PX = 240;
export const MOVE_MARGIN = 20;
export const MOVE_LEAD_SEC = 2;
export const MOVE_TAIL_SEC = 2;
/** Drag-vs-click pointer threshold (px). */
export const DRAG_THRESHOLD = 5;
/** Default bottom-right margin (upstream .dsh-pet-root[data-corner] CSS). */
export const DEFAULT_RIGHT_MARGIN = 24;

export const PET_SCALE_MIN_TICK = 0;
export const PET_SCALE_MAX_TICK = 7;
export const PET_SCALE_DEFAULT_TICK = 2;
export const PET_SCALE_MIN_FACTOR = 0.4;
export const PET_SCALE_STEP_FACTOR = 0.05;

const strictDecimal = (value: string | null): number | null => {
  if (value === null || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function queryScaleConfig(): {
  tick: number;
  minTick: number;
  maxTick: number;
  defaultTick: number;
  minFactor: number;
  stepFactor: number;
} {
  const fallback = {
    tick: PET_SCALE_DEFAULT_TICK,
    minTick: PET_SCALE_MIN_TICK,
    maxTick: PET_SCALE_MAX_TICK,
    defaultTick: PET_SCALE_DEFAULT_TICK,
    minFactor: PET_SCALE_MIN_FACTOR,
    stepFactor: PET_SCALE_STEP_FACTOR,
  };
  const query = new URLSearchParams(window.location.search);
  const values = [
    strictDecimal(query.get("petScaleTick")),
    strictDecimal(query.get("petScaleMinTick")),
    strictDecimal(query.get("petScaleMaxTick")),
    strictDecimal(query.get("petScaleDefaultTick")),
    strictDecimal(query.get("petScaleMinFactor")),
    strictDecimal(query.get("petScaleStepFactor")),
  ];
  if (values.some((value) => value === null)) return fallback;
  const [tick, minTick, maxTick, defaultTick, minFactor, stepFactor] =
    values as number[];
  if (
    !Number.isInteger(tick) ||
    !Number.isInteger(minTick) ||
    !Number.isInteger(maxTick) ||
    !Number.isInteger(defaultTick) ||
    minTick > maxTick ||
    defaultTick < minTick ||
    defaultTick > maxTick ||
    tick < minTick ||
    tick > maxTick ||
    minFactor <= 0 ||
    stepFactor <= 0
  )
    return fallback;
  return { tick, minTick, maxTick, defaultTick, minFactor, stepFactor };
}

/** The media directory under the package root (dist/ → ../assets/thumb/). */
const MEDIA_PREFIX = "../assets/thumb/";

/** The chain-model decision for a given random roll (client.js pickNext). */
export type AnimKind = "IDLE" | "TURN" | "ACTS" | "MOVE";

export function pickNextKind(roll: number): AnimKind {
  if (roll < 0.3) return "IDLE";
  if (roll < 0.4) return "TURN";
  if (roll < 0.8) return "ACTS";
  return "MOVE";
}

/** Equal-probability pool pick with an optional exclude (client.js pick). */
export function pick(
  pool: readonly string[],
  exclude: string | null,
  rng: () => number,
): string {
  const entries = exclude === null ? pool : pool.filter((n) => n !== exclude);
  return entries[Math.floor(rng() * entries.length)] ?? pool[0] ?? "";
}

/** [min, max) random integer (client.js randomBetween). */
export function randomBetween(
  min: number,
  max: number,
  rng: () => number,
): number {
  return Math.floor(min + rng() * (max - min));
}

/** A planned move, or null when the target is out of bounds. */
export interface MovePlan {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  dir: 1 | -1;
  totalRatio: number;
}

/** Plans a walk toward the actual facing, rejecting it when the target
 *  leaves the safe margin (client.js tryMove bounds check). */
export function planMove(opts: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  halfW: number;
  facing: "left" | "right";
  turning: boolean;
  distance: number;
}): MovePlan | null {
  // Direction from the ACTUAL facing: if TURN just ended, facing is about
  // to flip, so invert (client.js tryMove dir calc).
  const dir: 1 | -1 = (opts.facing === "right") === opts.turning ? -1 : 1;
  const target = opts.cx + dir * opts.distance;
  const leftBound = MOVE_MARGIN + opts.halfW;
  const rightBound = opts.W - MOVE_MARGIN - opts.halfW;
  if (target < leftBound || target > rightBound) return null;
  return {
    startRatio: opts.cx / opts.W,
    startYRatio: opts.cy / opts.H,
    targetRatio: target / opts.W,
    dir,
    totalRatio: Math.abs(target - opts.cx) / opts.W,
  };
}

/** The injected DOM + bridge the controller drives. */
export interface PetInitOptions {
  root: HTMLElement;
  stage: HTMLElement;
  videoA: HTMLVideoElement;
  videoB: HTMLVideoElement;
  hit: HTMLElement;
  bridge: PetApi;
  rng?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

export interface PetState {
  anim: string;
  once: boolean;
  facing: "left" | "right";
  dragging: boolean;
  customPos: { rx: number; ry: number } | null;
}

export interface PetController {
  getState(): PetState;
  destroy(): void;
}

export function initPet(opts: PetInitOptions): PetController {
  const { root, stage, videoA, videoB, hit, bridge } = opts;
  const rng = opts.rng ?? Math.random;
  const raf =
    opts.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));
  const scaleConfig = queryScaleConfig();
  let scaleTick = scaleConfig.tick;
  let desiredScaleTick = scaleTick;
  let scaleRequestInFlight: number | null = null;
  let wheelRemainder = 0;

  let size = 0;
  let halfW = 0;
  let stageH = 0;
  let halfH = 0;
  let bottomPad = 0;
  let territory: {
    minStageX: number;
    maxStageX: number;
    minStageY: number;
    maxStageY: number;
  } | null = null;

  const layout = (): void => {
    size = Math.floor(
      window.innerWidth *
        (scaleConfig.minFactor + scaleTick * scaleConfig.stepFactor),
    );
    halfW = size / 2;
    stageH = (size * 9) / 16;
    halfH = stageH / 2;
    bottomPad = (stageH * (CANVAS_H - FEET_Y)) / CANVAS_H;
    root.style.width = `${size}px`;
    root.style.height = `${stageH}px`;
    stage.style.transform = `translateY(${bottomPad}px)`;
    hit.style.left = `${(HIT_BOX.x0 / 640) * 100}%`;
    hit.style.top = `${(HIT_BOX.y0 / 360) * 100}%`;
    hit.style.width = `${((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100}%`;
    hit.style.height = `${((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100}%`;
  };

  let anim = IDLE;
  let once = true;
  let facing: "left" | "right" = "left";
  let dragging = false;
  let customPos: { rx: number; ry: number } | null = null;

  let front = 0; // 0 = videoA front, 1 = videoB front
  let pending: { anim: string; once: boolean; gen: number } | null = null;
  let gen = 0;

  let drag = { active: false, dragging: false, sx: 0, sy: 0 };
  let justDragged = false;
  let preDragCustomPos: { rx: number; ry: number } | null = null;
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStageRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  let pendingDragPosition: PetDragPosition | null = null;
  let pendingDragFrame: number | null = null;
  let deferredLayout = false;
  let deferredTerritory: {
    minStageX: number;
    maxStageX: number;
    minStageY: number;
    maxStageY: number;
  } | null = null;
  let deferredScaleState: PetScaleState | null = null;
  let deferredResetPosition = false;
  let terminalDrag = false;

  let moveId: number | null = null;
  let moveToken = 0;
  let pendingMove: MovePlan | null = null;

  let lastHitInside: boolean | null = null;

  const rootBounds = (): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } => {
    const cellMaxX = Math.max(0, window.innerWidth - size);
    const cellMaxY = Math.max(0, window.innerHeight - stageH);
    if (!territory) return { minX: 0, maxX: cellMaxX, minY: 0, maxY: cellMaxY };
    const intersectAxis = (
      territoryMin: number,
      territoryMax: number,
      cellMax: number,
    ): [number, number] => {
      const min = Math.max(0, territoryMin);
      const max = Math.min(cellMax, territoryMax);
      if (min <= max) return [min, max];
      const edge = min > cellMax ? cellMax : 0;
      return [edge, edge];
    };
    const [minX, maxX] = intersectAxis(
      territory.minStageX,
      territory.maxStageX,
      cellMaxX,
    );
    const [minY, maxY] = intersectAxis(
      territory.minStageY - bottomPad,
      territory.maxStageY - bottomPad,
      cellMaxY,
    );
    return { minX, maxX, minY, maxY };
  };

  const setRootPosition = (x: number, y: number): void => {
    const bounds = rootBounds();
    root.style.transform = `translate(${Math.min(Math.max(x, bounds.minX), bounds.maxX)}px, ${Math.min(Math.max(y, bounds.minY), bounds.maxY)}px)`;
  };

  const renderPosition = (): void => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const left = customPos
      ? customPos.rx * W - halfW
      : W - size - DEFAULT_RIGHT_MARGIN;
    const top = customPos ? customPos.ry * H - halfH : H - stageH;
    setRootPosition(left, top);
  };

  const captureBottomCenter = (): { x: number; y: number } => {
    const rect = stage.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  };

  const restoreBottomCenter = (anchor: { x: number; y: number }): void => {
    const left = anchor.x - size / 2;
    const top = anchor.y - bottomPad - stageH;
    customPos = {
      rx: (left + halfW) / Math.max(window.innerWidth, 1),
      ry: (top + halfH) / Math.max(window.innerHeight, 1),
    };
    renderPosition();
  };

  const setAnim = (next: string, nextOnce: boolean): void => {
    anim = next;
    once = nextOnce;
    switchTo(anim, once);
  };

  const handleEnded = (): void => {
    if (drag.active) return; // mid-drag: keep the drag animation
    if (anim === TURN) facing = facing === "left" ? "right" : "left";
    if (anim === DRAG || CLICKS.includes(anim)) {
      // Click/drag interruptions end with an idle buffer; that idle
      // one-shot then re-enters the chain.
      setAnim(IDLE, true);
      return;
    }
    pickNextChain();
  };

  const pickNextChain = (): void => {
    const kind = pickNextKind(rng());
    if (kind === "IDLE") {
      setAnim(IDLE, true);
    } else if (kind === "TURN") {
      setAnim(TURN, true);
    } else if (kind === "ACTS") {
      setAnim(pick(ACTS, anim, rng), true);
    } else if (!tryMove()) {
      // No room to walk → fall back to a random act.
      setAnim(pick(ACTS, anim, rng), true);
    }
    // else: tryMove already set the movement animation.
  };

  const tryMove = (): boolean => {
    if (moveId !== null || pendingMove) return true; // already moving/planned
    const plan = planMove({
      cx: currentCenterX(),
      cy: currentCenterY(),
      W: window.innerWidth,
      H: window.innerHeight,
      halfW,
      facing,
      turning: anim === TURN,
      distance: randomBetween(MOVE_MIN_PX, MOVE_MAX_PX, rng),
    });
    if (plan === null) return false;
    const bounds = rootBounds();
    const targetLeft = plan.targetRatio * window.innerWidth - halfW;
    if (targetLeft < bounds.minX || targetLeft > bounds.maxX) return false;
    pendingMove = plan;
    setAnim(pick(MOVES, null, rng), true);
    return true;
  };

  const currentCenterX = (): number => {
    if (customPos) return customPos.rx * window.innerWidth;
    return root.getBoundingClientRect().left + halfW;
  };

  const currentCenterY = (): number => {
    if (customPos) return customPos.ry * window.innerHeight;
    return root.getBoundingClientRect().top + halfH;
  };

  const stopMove = (): void => {
    pendingMove = null;
    moveToken += 1;
    if (moveId !== null) {
      caf(moveId);
      moveId = null;
    }
  };

  const startMoveDrive = (el: HTMLVideoElement): void => {
    const plan = pendingMove;
    if (!plan || moveId !== null) return;
    pendingMove = null;
    const duration =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
    const travelWindow = Math.max(
      0.1,
      duration - MOVE_LEAD_SEC - MOVE_TAIL_SEC,
    );
    const token = ++moveToken;
    const step = (): void => {
      if (moveToken !== token) return;
      const t = el.currentTime || 0;
      let ratioX: number;
      if (t <= MOVE_LEAD_SEC) ratioX = plan.startRatio;
      else if (t >= duration - MOVE_TAIL_SEC) ratioX = plan.targetRatio;
      else
        ratioX =
          plan.startRatio +
          plan.dir * plan.totalRatio * ((t - MOVE_LEAD_SEC) / travelWindow);
      setRootPosition(
        ratioX * window.innerWidth - halfW,
        plan.startYRatio * window.innerHeight - halfH,
      );
      if (t < duration - MOVE_TAIL_SEC) {
        moveId = raf(step);
      } else {
        moveId = null;
        customPos = { rx: plan.targetRatio, ry: plan.startYRatio };
      }
    };
    moveId = raf(step);
  };

  const switchTo = (next: string, nextOnce: boolean): void => {
    if (pending && pending.anim === next && pending.once === nextOnce) return;
    const currentGen = ++gen;
    pending = { anim: next, once: nextOnce, gen: currentGen };

    const el = front === 0 ? videoB : videoA;
    el.src = MEDIA_PREFIX + encodeURIComponent(next) + ".webm";
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = null;
    el.load();

    const onReady = (): void => {
      el.removeEventListener("loadeddata", onReady);
      if (pending?.gen !== currentGen) return;
      const old = front === 0 ? videoA : videoB;
      if (old && old !== el) {
        old.onended = null;
        old.pause();
        old.classList.remove("is-front");
      }
      el.classList.add("is-front");
      front = front === 0 ? 1 : 0;
      pending = null;
      el.onended = nextOnce ? handleEnded : null;
      el.style.transform = facing === "right" ? "scaleX(-1)" : "";
      void Promise.resolve(el.play()).catch(() => {});
      if (pendingMove) startMoveDrive(el);
    };
    el.addEventListener("loadeddata", onReady);
    if (el.readyState >= 2) onReady();
  };

  const handlePointerDown = (e: PointerEvent): void => {
    hit.classList.add("dragging");
    stopMove();
    if (typeof hit.setPointerCapture === "function")
      hit.setPointerCapture(e.pointerId);
    drag = {
      active: true,
      dragging: false,
      sx: e.clientX,
      sy: e.clientY,
    };
    preDragCustomPos = customPos ? { ...customPos } : null;
  };

  const captureDragAnchor = (e: PointerEvent): void => {
    stage.style.transform = "none";
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

  const handlePointerMove = (e: PointerEvent): void => {
    if (!drag.active) return;
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

  const restoreDrag = (): void => {
    drag.active = false;
    drag.dragging = false;
    hit.classList.remove("dragging");
    dragging = false;
    customPos = preDragCustomPos;
    dragAnchor = null;
    dragStageRect = null;
    stage.style.transform = `translateY(${bottomPad}px)`;
    renderPosition();
  };

  const isInHitRect = (clientX: number, clientY: number): boolean => {
    const rect = hit.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  };

  const reportHit = (inside: boolean, force = false): void => {
    if (force || inside !== lastHitInside) {
      lastHitInside = inside;
      bridge.sendHit(inside);
    }
  };

  const applyDeferredLayout = (): void => {
    if (!deferredLayout) return;
    deferredLayout = false;
    layout();
    renderPosition();
    reportLayout();
  };

  const applyDeferredInbound = (): void => {
    const nextTerritory = deferredTerritory;
    const nextScaleState = deferredScaleState;
    const resetPosition = deferredResetPosition;
    deferredTerritory = null;
    deferredScaleState = null;
    deferredResetPosition = false;
    if (nextTerritory) applyTerritory(nextTerritory);
    if (nextScaleState) applyScaleState(nextScaleState);
    if (resetPosition) applyResetPosition();
  };

  const handlePointerUp = (e: PointerEvent): void => {
    const wasDragging = drag.dragging;
    if (wasDragging && dragAnchor && dragStageRect) {
      pendingDragPosition = {
        phase: "move",
        screenX: e.screenX,
        screenY: e.screenY,
        anchorX: dragAnchor.x,
        anchorY: dragAnchor.y,
        stage: dragStageRect,
      };
      flushDragPosition();
    }
    restoreDrag();
    reportHit(isInHitRect(e.clientX, e.clientY), true);
    if (!wasDragging) return;
    justDragged = true;
    setTimeout(() => {
      justDragged = false;
    }, 100);
    const rect = stage.getBoundingClientRect();
    terminalDrag = true;
    try {
      bridge.sendMove({
        dx: e.clientX - drag.sx,
        dy: e.clientY - drag.sy,
        screenX: e.screenX,
        screenY: e.screenY,
        stage: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        heldDrag: true,
      });
    } finally {
      terminalDrag = false;
    }
    setAnim(IDLE, true);
    applyDeferredInbound();
    applyDeferredLayout();
  };

  const handlePointerCancel = (): void => {
    const wasDragging = drag.dragging;
    if (pendingDragFrame !== null) {
      caf(pendingDragFrame);
      pendingDragFrame = null;
    }
    pendingDragPosition = null;
    restoreDrag();
    reportHit(false, true);
    if (wasDragging) {
      const rect = stage.getBoundingClientRect();
      terminalDrag = true;
      try {
        bridge.sendDragPosition({
          phase: "cancel",
          screenX: 0,
          screenY: 0,
          anchorX: 0,
          anchorY: 0,
          stage: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        });
      } finally {
        terminalDrag = false;
      }
      setAnim(IDLE, true);
    }
    applyDeferredInbound();
    applyDeferredLayout();
  };

  const handleClick = (): void => {
    if (drag.active || drag.dragging || justDragged) return;
    if (once && anim !== IDLE) return; // busy one-shot
    stopMove();
    setAnim(pick(CLICKS, null, rng), true);
  };

  const onDocMouseMove = (e: MouseEvent): void => {
    if (drag.active) return; // keep the window interactive during a drag
    reportHit(isInHitRect(e.clientX, e.clientY));
  };

  hit.addEventListener("pointerdown", handlePointerDown);
  hit.addEventListener("pointermove", handlePointerMove);
  hit.addEventListener("pointerup", handlePointerUp);
  hit.addEventListener("pointercancel", handlePointerCancel);
  hit.addEventListener("click", handleClick);
  document.addEventListener("mousemove", onDocMouseMove);

  // Verify mode: log once the first video actually starts playing (the
  // empirical sandbox+webSecurity file:// video check). The initial IDLE
  // plays on the NON-front buffer (videoB — front starts at 0), so listen
  // on both buffers and report whichever fires first.
  if (new URLSearchParams(window.location.search).get("verify") === "1") {
    let verified = false;
    const onPlaying = (el: HTMLVideoElement): void => {
      if (verified) return;
      verified = true;
      console.log(`pet-verify-ok readyState=${el.readyState}`);
    };
    videoA.addEventListener("playing", () => onPlaying(videoA));
    videoB.addEventListener("playing", () => onPlaying(videoB));
  }

  const reportLayout = (resetPosition = false): void => {
    const rect = stage.getBoundingClientRect();
    const payload: PetStageLayout = {
      stage: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ...(resetPosition ? { resetPosition: true } : {}),
    };
    bridge.reportStageLayout(payload);
  };

  const requestScale = (): void => {
    if (scaleRequestInFlight !== null || desiredScaleTick === scaleTick) return;
    scaleRequestInFlight = desiredScaleTick;
    bridge.requestScaleTick({ tick: desiredScaleTick });
  };

  const applyScaleState = (state: PetScaleState): void => {
    if (
      !Number.isInteger(state.tick) ||
      state.tick < scaleConfig.minTick ||
      state.tick > scaleConfig.maxTick ||
      typeof state.accepted !== "boolean"
    )
      return;
    const responseMatchesWheelRequest =
      scaleRequestInFlight !== null && state.tick === scaleRequestInFlight;
    scaleRequestInFlight = null;
    if (!state.accepted || !responseMatchesWheelRequest) {
      desiredScaleTick = state.tick;
      wheelRemainder = 0;
    }
    stopMove();
    const anchor = captureBottomCenter();
    scaleTick = state.tick;
    layout();
    restoreBottomCenter(anchor);
    reportLayout();
    if (
      state.accepted &&
      responseMatchesWheelRequest &&
      desiredScaleTick !== scaleTick
    )
      requestScale();
  };

  const applyResetPosition = (): void => {
    stopMove();
    customPos = null;
    stage.style.transform = `translateY(${bottomPad}px)`;
    renderPosition();
    reportLayout(true);
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
    desiredScaleTick = Math.min(
      Math.max(desiredScaleTick - steps, scaleConfig.minTick),
      scaleConfig.maxTick,
    );
    requestScale();
  };

  const applyTerritory = (bounds: {
    minStageX: number;
    maxStageX: number;
    minStageY: number;
    maxStageY: number;
  }): void => {
    if (!Object.values(bounds).every(Number.isFinite)) return;
    territory = bounds;
    renderPosition();
  };
  const receiveTerritory = (bounds: {
    minStageX: number;
    maxStageX: number;
    minStageY: number;
    maxStageY: number;
  }): void => {
    if (terminalDrag || (drag.active && drag.dragging)) {
      deferredTerritory = bounds;
      return;
    }
    applyTerritory(bounds);
  };
  const receiveScaleState = (state: PetScaleState): void => {
    if (terminalDrag || (drag.active && drag.dragging)) {
      deferredScaleState = state;
      return;
    }
    applyScaleState(state);
  };
  const receiveResetPosition = (): void => {
    if (terminalDrag || (drag.active && drag.dragging)) {
      deferredResetPosition = true;
      return;
    }
    applyResetPosition();
  };
  // Subscribe before reporting the first layout so the hidden-first main
  // process reply cannot be missed.
  const removeTerritoryListener = bridge.onTerritoryBounds(receiveTerritory);
  const removeScaleListener = bridge.onScaleState(receiveScaleState);
  const removeResetListener = bridge.onResetPosition(receiveResetPosition);
  hit.addEventListener("wheel", handleWheel, { passive: false });
  const onResize = (): void => {
    if (drag.active && drag.dragging) {
      deferredLayout = true;
      return;
    }
    layout();
    renderPosition();
    reportLayout();
  };
  window.addEventListener("resize", onResize);
  layout();
  renderPosition();
  reportLayout();
  switchTo(IDLE, true);

  const destroy = (): void => {
    hit.removeEventListener("pointerdown", handlePointerDown);
    hit.removeEventListener("pointermove", handlePointerMove);
    hit.removeEventListener("pointerup", handlePointerUp);
    hit.removeEventListener("pointercancel", handlePointerCancel);
    hit.removeEventListener("click", handleClick);
    hit.removeEventListener("wheel", handleWheel);
    document.removeEventListener("mousemove", onDocMouseMove);
    window.removeEventListener("resize", onResize);
    removeTerritoryListener();
    removeScaleListener();
    removeResetListener();
    if (pendingDragFrame !== null) caf(pendingDragFrame);
    pendingDragFrame = null;
    pendingDragPosition = null;
    stopMove();
  };

  return {
    getState: () => ({
      anim,
      once,
      facing,
      dragging,
      customPos: customPos ? { ...customPos } : null,
    }),
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
    hit: document.getElementById("pet-hit") as HTMLElement,
    bridge: window.pet,
  });
}
