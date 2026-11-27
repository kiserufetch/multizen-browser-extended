import type {
  ChallengeFrameInspection,
  SolverOutcome,
  SolverPagePort,
} from "@multizen/types";

export interface InteractiveGridInput {
  imageBase64: string;
  tileImagesBase64?: string[];
  promptText: string;
  rows: number;
  columns: number;
}

export interface InteractiveCanvasInput {
  imageBase64: string;
  promptText: string;
}

export interface InteractiveVisionClassifier {
  solveGrid?(input: InteractiveGridInput, signal: AbortSignal): Promise<number[]>;
  solveCoordinates?(
    input: InteractiveCanvasInput,
    signal: AbortSignal,
  ): Promise<Array<{ x: number; y: number }>>;
}

export interface RunHCaptchaInteractiveOptions {
  page: SolverPagePort;
  classifier: InteractiveVisionClassifier;
  signal: AbortSignal;
  maxRounds?: number;
  delayScale?: number;
  jitterRatio?: number;
  frameUrlPattern?: string;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function boundingBoxOfTiles(
  tiles: NonNullable<ChallengeFrameInspection["tileBounds"]>,
  fallback: ChallengeFrameInspection["frameBounds"],
): { x: number; y: number; width: number; height: number } {
  if (tiles.length === 0) return fallback;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x + t.width > maxX) maxX = t.x + t.width;
    if (t.y + t.height > maxY) maxY = t.y + t.height;
  }
  const width = Math.max(1, Math.round(maxX - minX));
  const height = Math.max(1, Math.round(maxY - minY));
  return { x: Math.round(minX), y: Math.round(minY), width, height };
}

async function captureRegion(
  page: SolverPagePort,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<string> {
  if (page.captureRegionBase64) {
    return page.captureRegionBase64(bounds);
  }
  const frame = await page.captureFrame({ quality: 85 });
  return Buffer.from(frame.jpeg).toString("base64");
}

async function clickBoxHumanized(opts: {
  page: SolverPagePort;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  signal: AbortSignal;
  delayScale: number;
  jitterRatio: number;
}): Promise<void> {
  const { page, box, viewport, signal, delayScale, jitterRatio } = opts;
  if (signal.aborted) return;

  const offsetX =
    jitterRatio > 0 ? (Math.random() * 2 - 1) * jitterRatio * box.width : 0;
  const offsetY =
    jitterRatio > 0 ? (Math.random() * 2 - 1) * jitterRatio * box.height : 0;

  const targetX = box.x + box.width / 2 + offsetX;
  const targetY = box.y + box.height / 2 + offsetY;

  const normX =
    viewport.width > 1 ? Math.max(0, Math.min(1, targetX / viewport.width)) : targetX;
  const normY =
    viewport.height > 1 ? Math.max(0, Math.min(1, targetY / viewport.height)) : targetY;

  await page.dispatchInput({
    kind: "mouse",
    action: "move",
    x: normX,
    y: normY,
    button: "none",
    buttons: 0,
  });
  await sleepWithSignal(Math.round(randomInRange(40, 90) * delayScale), signal);
  if (signal.aborted) return;

  await page.dispatchInput({
    kind: "mouse",
    action: "down",
    x: normX,
    y: normY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleepWithSignal(Math.round(randomInRange(35, 75) * delayScale), signal);
  if (signal.aborted) return;

  await page.dispatchInput({
    kind: "mouse",
    action: "up",
    x: normX,
    y: normY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function runHCaptchaInteractive(
  opts: RunHCaptchaInteractiveOptions,
): Promise<SolverOutcome> {
  const {
    page,
    classifier,
    signal,
    maxRounds = 6,
    delayScale = 1,
    jitterRatio = 0.15,
    frameUrlPattern = "hcaptcha.com",
  } = opts;

  if (!page.inspectChallengeFrame) {
    return {
      status: "unsupported",
      reason: "SolverPagePort does not support inspectChallengeFrame",
      fallbackToHuman: true,
    };
  }

  const initialFrame = await page.captureFrame({ quality: 85 });
  let viewport = initialFrame.viewport;

  const firstCheck = await page.inspectChallengeFrame(frameUrlPattern);
  if (!firstCheck || !firstCheck.isVisible) {
    return {
      status: "failed",
      reason: "No visible hCaptcha frame found on the page",
      retryable: true,
      fallbackToHuman: true,
    };
  }

  if (firstCheck.challengeType === "checkbox") {
    if (firstCheck.checkboxChecked) {
      return {
        status: "solved",
        mode: "interactive",
        notes: "hCaptcha checkbox already checked",
      };
    }
    const targetBox = firstCheck.checkboxBounds ?? firstCheck.frameBounds;
    await clickBoxHumanized({
      page,
      box: targetBox,
      viewport,
      signal,
      delayScale,
      jitterRatio,
    });
    await sleepWithSignal(Math.round(1400 * delayScale), signal);

    const afterCheckbox = await page.inspectChallengeFrame(frameUrlPattern);
    if (
      !afterCheckbox ||
      !afterCheckbox.isVisible ||
      (afterCheckbox.challengeType === "checkbox" && afterCheckbox.checkboxChecked)
    ) {
      return {
        status: "solved",
        mode: "interactive",
        notes: "hCaptcha solved via checkbox click",
      };
    }
  }

  let errorRetries = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) {
      return {
        status: "failed",
        reason: "Interactive hCaptcha solver aborted",
        retryable: false,
      };
    }

    const inspection =
      round === 0 && firstCheck.challengeType !== "checkbox"
        ? firstCheck
        : await page.inspectChallengeFrame(frameUrlPattern);
    if (!inspection || !inspection.isVisible) {
      if (round > 0) {
        return {
          status: "solved",
          mode: "interactive",
          notes: `hCaptcha modal closed after ${round} interactive round(s)`,
        };
      }
      return {
        status: "failed",
        reason: "hCaptcha challenge modal is not visible",
        retryable: true,
        fallbackToHuman: true,
      };
    }

    if (inspection.challengeType === "checkbox" && inspection.checkboxChecked) {
      return {
        status: "solved",
        mode: "interactive",
        notes: `hCaptcha checkbox checked after ${round} round(s)`,
      };
    }

    if (inspection.errorText && /try again|попробуйте еще/i.test(inspection.errorText)) {
      errorRetries++;
      if (errorRetries > 2) {
        return {
          status: "failed",
          reason: `Interactive hCaptcha solver failed after repeated challenge errors: ${inspection.errorText}`,
          retryable: true,
          fallbackToHuman: true,
        };
      }
    }

    const promptText = inspection.promptText ?? "Select matching images";
    const latestFrame = await page.captureFrame({ quality: 85 });
    viewport = latestFrame.viewport;

    if (
      inspection.challengeType === "grid" &&
      inspection.tileBounds &&
      inspection.tileBounds.length > 0
    ) {
      if (!classifier.solveGrid) {
        return {
          status: "unsupported",
          reason: "Configured solver adapter does not support interactive GridTask classification",
          fallbackToHuman: true,
        };
      }

      const gridBounds = boundingBoxOfTiles(inspection.tileBounds, inspection.frameBounds);
      const imageBase64 = await captureRegion(page, gridBounds);
      const tileImagesBase64: string[] = [];
      for (const tile of inspection.tileBounds) {
        tileImagesBase64.push(await captureRegion(page, tile));
      }

      const indices1Based = await classifier.solveGrid(
        {
          imageBase64,
          tileImagesBase64,
          promptText,
          rows: 3,
          columns: 3,
        },
        signal,
      );

      for (const idx1 of indices1Based) {
        if (signal.aborted) break;
        const zeroIdx = idx1 - 1;
        const tile =
          inspection.tileBounds.find((t) => t.index === zeroIdx) ??
          inspection.tileBounds[zeroIdx];
        if (!tile) continue;
        await clickBoxHumanized({
          page,
          box: tile,
          viewport,
          signal,
          delayScale,
          jitterRatio,
        });
        await sleepWithSignal(Math.round(randomInRange(120, 280) * delayScale), signal);
      }
    } else if (inspection.challengeType === "canvas" || inspection.canvasBounds) {
      if (!classifier.solveCoordinates) {
        return {
          status: "unsupported",
          reason:
            "Configured solver adapter does not support interactive CoordinatesTask classification",
          fallbackToHuman: true,
        };
      }

      const targetBounds = inspection.canvasBounds ?? inspection.frameBounds;
      const imageBase64 = await captureRegion(page, targetBounds);
      const coords = await classifier.solveCoordinates(
        {
          imageBase64,
          promptText,
        },
        signal,
      );

      for (const pt of coords) {
        if (signal.aborted) break;
        const relX = pt.x <= 1 && pt.y <= 1 ? pt.x * targetBounds.width : pt.x;
        const relY = pt.x <= 1 && pt.y <= 1 ? pt.y * targetBounds.height : pt.y;
        const pointBox = {
          x: targetBounds.x + relX - 4,
          y: targetBounds.y + relY - 4,
          width: 8,
          height: 8,
        };
        await clickBoxHumanized({
          page,
          box: pointBox,
          viewport,
          signal,
          delayScale,
          jitterRatio: 0,
        });
        await sleepWithSignal(Math.round(randomInRange(120, 280) * delayScale), signal);
      }
    } else {
      return {
        status: "unsupported",
        reason: `Unrecognized interactive hCaptcha challenge layout (${inspection.challengeType ?? "unknown"})`,
        fallbackToHuman: true,
      };
    }

    await sleepWithSignal(Math.round(randomInRange(250, 450) * delayScale), signal);
    const submitBox = inspection.submitButtonBounds ?? {
      x: inspection.frameBounds.x + Math.round(inspection.frameBounds.width * 0.78),
      y: inspection.frameBounds.y + Math.round(inspection.frameBounds.height * 0.92),
      width: Math.round(inspection.frameBounds.width * 0.18),
      height: 36,
    };
    await clickBoxHumanized({
      page,
      box: submitBox,
      viewport,
      signal,
      delayScale,
      jitterRatio,
    });

    await sleepWithSignal(Math.round(randomInRange(1200, 1800) * delayScale), signal);
    const afterSubmit = await page.inspectChallengeFrame(frameUrlPattern);
    if (
      !afterSubmit ||
      !afterSubmit.isVisible ||
      (afterSubmit.challengeType === "checkbox" && afterSubmit.checkboxChecked)
    ) {
      return {
        status: "solved",
        mode: "interactive",
        notes: `Solved interactive hCaptcha in ${round + 1} round(s)`,
      };
    }
  }

  return {
    status: "failed",
    reason: `Interactive hCaptcha solver exceeded max rounds (${maxRounds})`,
    retryable: true,
    fallbackToHuman: true,
  };
}
