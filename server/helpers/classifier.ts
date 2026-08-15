import * as ort from 'onnxruntime-node';
import type sharp from 'sharp';
import { logWithTimestamp } from './logger.js';

export type ClassifyLabels = 'closed' | 'open';

export type ClassificationResult = {
    classification: ClassifyLabels;
    confidence: number;
};

const modelWidth = 224;
const modelHeight = 224;
const channelCount = 3;
const pixelCount = modelWidth * modelHeight;
const inputElementCount = channelCount * pixelCount;
const labels = ['closed', 'open'] as const satisfies readonly ClassifyLabels[];
const normalizedByteValues = Float32Array.from(
    { length: 256 },
    (_, value) => value / 255,
);

export async function classifyImage({
    image,
}: {
    image: sharp.Sharp;
}): Promise<ClassificationResult[]> {
    const { data: imageBuffer, info } = await image
        .clone()
        // classify model is hard-coded to 224x224
        .resize({ width: modelWidth, height: modelHeight, fit: 'fill' })
        // Always provide the RGB input layout expected by the model, even if
        // the camera is changed to return a grayscale or alpha-channel image.
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (
        info.width !== modelWidth ||
        info.height !== modelHeight ||
        info.channels !== channelCount
    ) {
        throw new Error(
            `invalid model input shape: ${String(info.width)}x${String(info.height)}x${String(info.channels)}`,
        );
    }

    const input = prepareInput(imageBuffer);
    const output = await runModel({ input });

    if (output.length !== labels.length) {
        throw new Error(
            `unexpected model output count: received ${String(output.length)}, expected ${String(labels.length)}`,
        );
    }

    const result: ClassificationResult[] = [];
    for (const [index, classification] of labels.entries()) {
        const confidence = output[index];
        if (confidence === undefined) {
            throw new Error(`missing model output at index ${String(index)}`);
        }

        result.push({ classification, confidence });
    }

    logWithTimestamp(`model result: ${JSON.stringify(result)}`);

    return result;
}

function prepareInput(pixels: Uint8Array): Float32Array {
    if (pixels.length !== inputElementCount) {
        throw new Error(
            `invalid pixel count: received ${String(pixels.length)}, expected ${String(inputElementCount)}`,
        );
    }

    // Sharp returns interleaved RGB bytes (HWC), while the ONNX model expects
    // normalized planar floats (NCHW). Write directly into the final typed
    // array to avoid three dynamic number arrays, their concatenation, and a
    // second copy into Float32Array on every frame.
    const input = new Float32Array(inputElementCount);
    for (
        let sourceIndex = 0, pixelIndex = 0;
        pixelIndex < pixelCount;
        sourceIndex += channelCount, pixelIndex++
    ) {
        const red = pixels[sourceIndex];
        const green = pixels[sourceIndex + 1];
        const blue = pixels[sourceIndex + 2];

        if (red === undefined || green === undefined || blue === undefined) {
            throw new Error(
                `missing pixel data at index ${String(sourceIndex)}`,
            );
        }

        input[pixelIndex] = normalizeByte(red);
        input[pixelCount + pixelIndex] = normalizeByte(green);
        input[2 * pixelCount + pixelIndex] = normalizeByte(blue);
    }

    return input;
}

function normalizeByte(value: number): number {
    const normalized = normalizedByteValues[value];
    if (normalized === undefined) {
        throw new Error(`invalid byte value: ${String(value)}`);
    }

    return normalized;
}

// Loading from a path lets the native runtime own model loading. Reading the
// file into a module-level Buffer retained an extra ~49 MB for this model.
const session = await ort.InferenceSession.create('best.onnx');

async function runModel({ input }: { input: Float32Array }) {
    const tensor = new ort.Tensor(input, [
        1,
        channelCount,
        modelHeight,
        modelWidth,
    ]);
    const outputs = await session.run({ images: tensor });

    const output0 = outputs['output0'];

    if (!output0) {
        throw new Error('no output0');
    }

    if (output0.type !== 'float32') {
        throw new Error(`unexpected output type: ${output0.type}`);
    }

    return output0.data as Float32Array;
}
