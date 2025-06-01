import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import AxiosDigestAuth from '@mhoc/axios-digest-auth';
import mqtt from 'mqtt';
import 'dotenv/config';
import { readFile } from 'fs/promises';

const digestAuth = new AxiosDigestAuth({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    username: process.env['CAMERA_USERNAME']!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    password: process.env['CAMERA_PASSWORD']!,
});

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const mqttHost = process.env['MQTT_HOST']!;
const uniqueId = 'home_gate_detection_driveway_gate';
const mqttTopic = `homeassistant/binary_sensor/${uniqueId}/state`;
const mqttClient = mqtt.connect(mqttHost);

mqttClient.on('connect', () => {
    logWithTimestamp('Connected to MQTT broker');
    // Publish MQTT discovery configuration for Home Assistant auto-discovery using auto-generated topic
    const discoveryTopic = `homeassistant/binary_sensor/${uniqueId}/config`;
    const configPayload = JSON.stringify({
        name: 'Driveway Gate',
        state_topic: mqttTopic,
        payload_on: 'on',
        payload_off: 'off',
        device_class: 'garage_door',
        unique_id: uniqueId,
    });
    mqttClient.publish(
        discoveryTopic,
        configPayload,
        { retain: true },
        (err) => {
            if (err) {
                logWithTimestamp(
                    `MQTT discovery publish error: ${err.message}`,
                );
            } else {
                logWithTimestamp(
                    `Published MQTT discovery config to ${discoveryTopic}`,
                );
            }
        },
    );
});
mqttClient.on('error', (err) => {
    logWithTimestamp(`MQTT error: ${err.message}`);
});

void (async () => {
    const onnxModel = await readFile('best.onnx');
    // state for debounced classification updates
    let lastClassificationReceived: ClassifyLabels | null = null;
    let consecutiveCount = 0;
    let lastPublishedClassification: ClassifyLabels | null = null;

    for (;;) {
        try {
            const classification = await classifyGate({ onnxModel });
            // count consecutive occurrences of the same classification
            if (classification === lastClassificationReceived) {
                consecutiveCount++;
            } else {
                lastClassificationReceived = classification;
                consecutiveCount = 1;
            }
            // only update when two consecutive readings differ from last published state
            if (
                classification !== lastPublishedClassification &&
                consecutiveCount >= 2
            ) {
                updateMqttState(classification);
                lastPublishedClassification = classification;
            }
        } catch (error) {
            if (error instanceof Error) {
                logWithTimestamp(`exception: ${error.message}
${error.stack ? error.stack.toString() : ''}`);
                continue;
            }

            throw error;
        }
    }
})();

async function classifyGate({ onnxModel }: { onnxModel: Buffer }) {
    // get image
    console.time('get_camera_image');
    const { croppedImage, croppedImageBuffer } = await get_camera_image();
    console.timeEnd('get_camera_image');

    // classify
    console.time('classify_image');
    const classify = await classify_image({
        img: croppedImageBuffer,
        onnxModel,
    });
    console.timeEnd('classify_image');

    // filter out low confidence
    const confidenceThreshold = 0.9;
    const filtered = classify.filter(
        (classification) => classification.confidence > confidenceThreshold,
    );

    // sort by confidence result descending
    const result = filtered.sort((a, b) => b.confidence - a.confidence);

    if (result.length === 0 || !result[0]) {
        await saveCroppedImage(croppedImage, 'not-confident');
        throw new Error('no confident results');
    }

    const topResult = result[0];
    logWithTimestamp(`top result: ${JSON.stringify(topResult)}`);

    if (
        topResult.classification === 'open' &&
        process.env['SAVE_OPEN_IMAGES'] === 'true'
    ) {
        await saveCroppedImage(croppedImage, 'open');
    }

    if (
        topResult.classification === 'closed' &&
        process.env['SAVE_CLOSED_IMAGES'] === 'true'
    ) {
        if (Math.random() < 0.01) {
            await saveCroppedImage(croppedImage, 'closed');
        }
    }

    return topResult.classification;
}

async function saveCroppedImage(croppedImage: sharp.Sharp, folder: string) {
    const timestamp = new Date().toISOString().replace(/:/g, '_');
    const filePath = `images/${folder}/${timestamp}.jpg`;
    await croppedImage.toFormat('jpeg').toFile(filePath);
}

function updateMqttState(classification: ClassifyLabels) {
    const state = classification === 'open' ? 'on' : 'off';
    const payload = state;
    mqttClient.publish(mqttTopic, payload, (err) => {
        if (err) {
            logWithTimestamp(`MQTT publish error: ${err.message}`);
        } else {
            logWithTimestamp(
                `Published state '${state}' to MQTT topic '${mqttTopic}'`,
            );
        }
    });
}

async function get_camera_image() {
    const imageBuffer = await digestAuth
        .request({
            method: 'GET',
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            url: process.env['CAMERA_URL']!,
            responseType: 'arraybuffer',
            timeout: 10_000,
        })
        .then((response) => response.data);

    const sharpImage = sharp(imageBuffer, { failOn: 'none' });

    // crop image to gate
    const croppedImage = sharpImage.extract({
        left: 2142,
        top: 333,
        width: 585,
        height: 468,
    });

    // crop image to gate
    const croppedImageBuffer = await croppedImage
        .clone()
        // classify model is hard-coded to 224x224
        .resize({ width: 224, height: 224, fit: 'fill' })
        .raw()
        .toBuffer();

    return { croppedImageBuffer, croppedImage };
}

// helpers from https://github.com/AndreyGermanov/yolov8_onnx_nodejs/blob/main/object_detector.js
async function classify_image({
    img,
    onnxModel,
}: {
    img: Buffer;
    onnxModel: Buffer;
}) {
    const input = prepare_input(img);
    const output = await run_model({ input, onnxModel });

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

/**
 * Function used to convert input image to tensor,
 * required as an input to YOLOv8 object detection
 * network.
 */
function prepare_input(pixels: Buffer) {
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

/**
 * Function used to pass provided input tensor to YOLOv8 neural network and return result
 * @param input Input pixels array
 * @returns Raw output of neural network as a flat array of numbers
 */
async function run_model({
    input,
    onnxModel,
}: {
    input: number[];
    onnxModel: Buffer;
}) {
    const model = await ort.InferenceSession.create(onnxModel);
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
    const outputs = await model.run({ images: tensor });

    const output0 = outputs['output0'];

    if (!output0) {
        throw new Error('no output0');
    }

    const data = output0.data;

    return data;
}

type ClassifyLabels = 'closed' | 'open';

const labels: Record<string, ClassifyLabels> = {
    '0': 'closed',
    '1': 'open',
};

function logWithTimestamp(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}
