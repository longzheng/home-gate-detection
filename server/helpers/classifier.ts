import * as ort from 'onnxruntime-node';
import type sharp from 'sharp';
import { logWithTimestamp } from './logger.js';

export type ClassifyLabels = 'closed' | 'open';

export type ClassificationResult = {
    classification: ClassifyLabels;
    confidence: number;
};

const labels: Record<string, ClassifyLabels> = {
    '0': 'closed',
    '1': 'open',
};

export async function classifyImage({
    image,
    onnxModel,
}: {
    image: sharp.Sharp;
    onnxModel: Buffer;
}): Promise<ClassificationResult[]> {
    const imageBuffer = await image
        .clone()
        // classify model is hard-coded to 224x224
        .resize({ width: 224, height: 224, fit: 'fill' })
        .raw()
        .toBuffer();

    const input = prepareInput(imageBuffer);
    const output = await runModel({ input, onnxModel });

    const result = Object.entries(output).map(([key, value]) => {
        const classification = labels[key];

        if (!classification) {
            throw new Error('unknown classification');
        }

        return { classification, confidence: value as number };
    });

    logWithTimestamp(`model result: ${JSON.stringify(result)}`);

    return result;
}

function prepareInput(pixels: Buffer) {
    const red: number[] = [],
        green: number[] = [],
        blue: number[] = [];
    for (let index = 0; index < pixels.length; index += 3) {
        const redPixel = pixels[index];
        const greenPixel = pixels[index + 1];
        const bluePixel = pixels[index + 2];

        if (
            redPixel === undefined ||
            greenPixel === undefined ||
            bluePixel === undefined
        ) {
            throw new Error('invalid pixel');
        }

        red.push(redPixel / 255.0);
        green.push(greenPixel / 255.0);
        blue.push(bluePixel / 255.0);
    }
    const input = [...red, ...green, ...blue];
    return input;
}

async function runModel({
    input,
    onnxModel,
}: {
    input: number[];
    onnxModel: Buffer;
}) {
    // TODO create session once and reuse
    const session = await ort.InferenceSession.create(onnxModel);
    const tensor = new ort.Tensor(
        Float32Array.from(input),
        [
            1,
            // 3 channels?
            3,
            // width
            224,
            // height
            224,
        ],
    );
    const outputs = await session.run({ images: tensor });

    const output0 = outputs['output0'];

    if (!output0) {
        throw new Error('no output0');
    }

    return output0.data;
}
