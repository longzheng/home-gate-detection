import type sharp from 'sharp';
import { addon as ov } from 'openvino-node';
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
}: {
    image: sharp.Sharp;
}): Promise<ClassificationResult[]> {
    const imageBuffer = await image
        .clone()
        // classify model is hard-coded to 224x224
        .resize({ width: 224, height: 224, fit: 'fill' })
        .raw()
        .toBuffer();

    const input = prepareInput(imageBuffer);
    const output = runModel({ input });

    const result = Object.entries(output).map(([key, value]) => {
        const classification = labels[key];

        if (!classification) {
            throw new Error('unknown classification');
        }

        const confidence = Number(value);

        return { classification, confidence };
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

const core = new ov.Core();
const modelPath = 'best.xml';
const model = await core.readModel(modelPath);
const compiledModel = await core.compileModel(model, 'CPU');
const inferRequest = compiledModel.createInferRequest();
const outputLayer = compiledModel.outputs[0];

if (!outputLayer) {
    throw new Error('Model does not expose an output layer');
}

const validatedOutputLayer = outputLayer;

function runModel({ input }: { input: number[] }) {
    const tensor = new ov.Tensor(
        ov.element.f32,
        [
            1,
            // 3 channels?
            3,
            // width
            224,
            // height
            224,
        ],
        Float32Array.from(input),
    );

    inferRequest.setInputTensor(tensor);
    inferRequest.infer();

    const outputTensor = inferRequest.getTensor(validatedOutputLayer);

    return outputTensor.data;
}
